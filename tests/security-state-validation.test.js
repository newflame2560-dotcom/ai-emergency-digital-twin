const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(new URL('../ai-emergency-digital-twin-prototype.html', `file://${__filename}`), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const validationSource = between('const STATE_KEYS =', 'function saveState(){');
const persistenceSource = between('function saveState(){', 'loadState();');
const importSource = between('function importState(ev){', 'function toast(msg){');
const escapingSource = between('function esc(v){', 'function roomGuidance(');
const renderScenarioSource = between('function renderScenarioList(){', 'renderScenarioList();');
const logEventSource = between('function logEvent(', 'let simConfigured');
const checkListSource = between('function chipHTML(', '/* ---------- Live Drill Mode');
const aarSource = between('function buildAARFromSim(){', 'function occAARSections(');

const fixture = {
  scenarios: [{
    id: 1,
    name: 'ทดสอบ',
    type: 'เพลิงไหม้',
    floor: 5,
    origin: 'svr',
    time: '14:00',
    people: 120,
    blockW: false,
    blockE: false,
    night: false,
    note: ''
  }],
  nextId: 2,
  activeScenario: 1,
  car: [{
    id: 1,
    item: 'ทดสอบ',
    found: 'วันนี้',
    owner: 'ฝ่ายอาคาร',
    due: 'พรุ่งนี้',
    status: 'doing'
  }],
  carNextId: 2,
  verify: {},
  liveDrill: null
};

function copy(value){ return JSON.parse(JSON.stringify(value)); }

function validationContext(initial=fixture){
  const context = vm.createContext({state: copy(initial)});
  vm.runInContext(
    `${validationSource}\n${escapingSource}\nthis.validateJson=json=>validatePersistedState(JSON.parse(json));this.esc=esc;`,
    context
  );
  return context;
}

function entryContext(initial=fixture, stored=null){
  const values = new Map();
  if(stored !== null) values.set('aidt_occ_state_v1', stored);
  const calls = {removed:[], rendered:0, toasts:[]};
  class FileReader {
    readAsText(file){ this.result=file.content; this.onload(); }
  }
  const context = vm.createContext({
    state: copy(initial),
    localStorage: {
      getItem:key=>values.has(key) ? values.get(key) : null,
      setItem:(key,value)=>values.set(key,value),
      removeItem:key=>{ calls.removed.push(key); values.delete(key); }
    },
    FileReader,
    canUse:()=>true,
    renderScenarioList:()=>calls.rendered++,
    renderCAR:()=>calls.rendered++,
    renderVerify:()=>calls.rendered++,
    renderLiveDrillResult:()=>calls.rendered++,
    renderOCC:()=>calls.rendered++,
    toast:message=>calls.toasts.push(message)
  });
  vm.runInContext(
    `const STORAGE_KEY='aidt_occ_state_v1';\n${validationSource}\n${persistenceSource}\n${importSource}\nthis.loadState=loadState;this.saveState=saveState;this.importState=importState;`,
    context
  );
  return {context, values, calls};
}

test('strict schema accepts valid state and rejects unknown fields, unsafe IDs, and oversized values', () => {
  const context = validationContext();
  assert.doesNotThrow(() => context.validateJson(JSON.stringify(fixture)));
  assert.throws(() => context.validateJson('{}'), /state ขาดฟิลด์/);

  const unknown = copy(fixture);
  unknown.scenarios[0].onclick = 'alert(1)';
  assert.throws(() => context.validateJson(JSON.stringify(unknown)), /ฟิลด์ที่ไม่รู้จัก/);

  const unsafeId = copy(fixture);
  unsafeId.scenarios[0].id = '1);alert(1)//';
  assert.throws(() => context.validateJson(JSON.stringify(unsafeId)), /scenario\[0\]\.id/);

  const oversized = copy(fixture);
  oversized.scenarios[0].name = 'ก'.repeat(161);
  assert.throws(() => context.validateJson(JSON.stringify(oversized)), /scenario\[0\]\.name/);
});

test('all built-in preset scenarios satisfy the persisted-state schema', () => {
  const presetContext = vm.createContext({});
  const stateSource = between('const state = {', 'const $ =');
  vm.runInContext(`${stateSource}\nthis.presetState=state;`, presetContext);
  const persisted = {
    scenarios: copy(presetContext.presetState.scenarios),
    nextId: presetContext.presetState.nextId,
    activeScenario: presetContext.presetState.activeScenario,
    car: copy(presetContext.presetState.car),
    carNextId: presetContext.presetState.carNextId,
    verify: {},
    liveDrill: null
  };
  assert.doesNotThrow(() => validationContext(persisted).validateJson(JSON.stringify(persisted)));
});

test('save/load performs a valid round-trip through localStorage', () => {
  const {context, values, calls} = entryContext();
  context.saveState();
  const saved = values.get('aidt_occ_state_v1');
  assert.deepEqual(JSON.parse(saved), fixture);
  context.state.scenarios[0].name = 'เปลี่ยนแล้ว';
  context.loadState();
  assert.equal(context.state.scenarios[0].name, 'ทดสอบ');
  assert.deepEqual(calls.removed, []);
});

test('load rejects tainted localStorage atomically and removes it', () => {
  const tainted = copy(fixture);
  tainted.scenarios[0].name = 'โจมตี';
  tainted.scenarios[0].unknown = '<img src=x onerror=alert(1)>';
  const {context, values, calls} = entryContext(fixture, JSON.stringify(tainted));
  const before = JSON.stringify(context.state);
  context.loadState();
  assert.equal(JSON.stringify(context.state), before);
  assert.deepEqual(calls.removed, ['aidt_occ_state_v1']);
  assert.equal(values.has('aidt_occ_state_v1'), false);
});

test('import applies valid data and rejects invalid data atomically', () => {
  const imported = copy(fixture);
  imported.scenarios[0].name = 'นำเข้าสำเร็จ';
  const valid = entryContext();
  const validInput = {files:[{size:100,content:JSON.stringify(imported)}],value:'selected'};
  valid.context.importState({target:validInput});
  assert.equal(valid.context.state.scenarios[0].name, 'นำเข้าสำเร็จ');
  assert.equal(valid.calls.rendered, 5);
  assert.equal(validInput.value, '');
  assert.ok(valid.values.has('aidt_occ_state_v1'));

  const invalid = copy(imported);
  invalid.scenarios[0].onclick = 'alert(1)';
  const rejected = entryContext();
  const before = JSON.stringify(rejected.context.state);
  rejected.context.importState({target:{files:[{size:100,content:JSON.stringify(invalid)}],value:'selected'}});
  assert.equal(JSON.stringify(rejected.context.state), before);
  assert.equal(rejected.calls.rendered, 0);
  assert.equal(rejected.values.has('aidt_occ_state_v1'), false);
  assert.deepEqual(rejected.calls.toasts, ['ไฟล์ไม่ถูกต้อง นำเข้าไม่สำเร็จ']);
});

test('scenario list escapes state and binds actions without inline handlers', () => {
  const listeners = [];
  const buttons = [
    {dataset:{scenarioId:'1',scenarioAction:'run'},addEventListener:(type,fn)=>listeners.push({type,fn})}
  ];
  const list = {innerHTML:'',querySelectorAll:()=>buttons};
  const state = copy(fixture);
  state.scenarios[0].name = '<img src=x onerror=alert(1)>';
  state.scenarios[0].note = '"><svg onload=alert(2)>';
  const calls = [];
  const context = vm.createContext({
    state,
    $:()=>list,
    scDesc:()=>'<script>alert(3)</script>',
    setActiveScenario:id=>calls.push(['active',id]),
    goPage:page=>calls.push(['page',page]),
    simReset:()=>calls.push(['reset']),
    simToggle:()=>calls.push(['toggle'])
  });
  vm.runInContext(`${escapingSource}\n${renderScenarioSource}\nthis.renderScenarioList=renderScenarioList;`, context);
  context.renderScenarioList();
  assert.doesNotMatch(list.innerHTML, /onclick=/);
  assert.doesNotMatch(list.innerHTML, /<img|<svg|<script/);
  assert.match(list.innerHTML, /&lt;img/);
  assert.match(list.innerHTML, /data-scenario-id="1"/);
  listeners[0].fn();
  assert.deepEqual(calls, [['active',1],['page','sim'],['reset'],['toggle']]);
});

test('event log, checklist, and AAR render state-derived text safely', () => {
  const nodes = [];
  const eventList = {appendChild:node=>nodes.push(node)};
  const document = {
    createElement:tag=>({
      tag, children:[], style:{},
      append(...children){ this.children.push(...children); }
    })
  };
  const eventContext = vm.createContext({
    SIM:{events:[]}, document, $:()=>eventList,
    fmtTime:()=> '0:00'
  });
  vm.runInContext(`${logEventSource}\nthis.logEvent=logEvent;`, eventContext);
  const payload = '<img src=x onerror=alert(1)>';
  eventContext.logEvent(0,payload,'red');
  assert.equal(nodes[0].children[2].textContent,payload);

  const checklist = {innerHTML:''};
  const checkContext = vm.createContext({$:()=>checklist});
  vm.runInContext(`${escapingSource}\n${checkListSource}\nthis.checkList=checkList;`, checkContext);
  checkContext.checkList('#x',[[payload,`red|${payload}`]]);
  assert.doesNotMatch(checklist.innerHTML, /<img/);
  assert.match(checklist.innerHTML, /&lt;img/);

  const aarState = {
    lastSim: {
      scenario:{...copy(fixture.scenarios[0]),name:payload,note:payload,originLabel:payload},
      evacSec:200,missionSec:200,total:120,maxQueue:2,pass:true,advanced:false,
      exits:[{name:'MST-01',count:120,blocked:false}],when:'วันนี้',maxDelay:20
    }
  };
  const aarContext = vm.createContext({
    state:aarState,
    fmtTime:value=>String(value),
    floorDisplay:()=> 'ชั้น 5',
    scOriginName:sc=>sc.originLabel,
    lawBlock:()=>'', aarFoot:()=>''
  });
  vm.runInContext(`${escapingSource}\n${aarSource}\nthis.buildAARFromSim=buildAARFromSim;`, aarContext);
  const report = aarContext.buildAARFromSim();
  assert.doesNotMatch(report, /<img/);
  assert.match(report, /&lt;img/);
});
