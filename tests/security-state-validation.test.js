const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(new URL('../ai-emergency-digital-twin-prototype.html', `file://${__filename}`), 'utf8');
const validationSource = html.slice(
  html.indexOf('const STATE_KEYS ='),
  html.indexOf('function saveState(){')
);
const escapingSource = html.slice(
  html.indexOf('function esc(v){'),
  html.indexOf('function roomGuidance(')
);
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
const context = vm.createContext({state: fixture});
vm.runInContext(
  `${validationSource}\n${escapingSource}\nthis.validateJson=json=>validatePersistedState(JSON.parse(json));this.esc=esc;`,
  context
);

function copy(value){ return JSON.parse(JSON.stringify(value)); }
function validate(value){ return context.validateJson(JSON.stringify(value)); }

test('accepts a valid exported state', () => {
  assert.doesNotThrow(() => validate(copy(fixture)));
});

test('rejects unknown fields and unsafe identifiers', () => {
  assert.throws(() => validate({}), /state ขาดฟิลด์/);

  const unknown = copy(fixture);
  unknown.scenarios[0].onclick = 'alert(1)';
  assert.throws(() => validate(unknown), /ฟิลด์ที่ไม่รู้จัก/);

  const unsafeId = copy(fixture);
  unsafeId.scenarios[0].id = '1);alert(1)//';
  assert.throws(() => validate(unsafeId), /scenario\[0\]\.id/);
});

test('rejects oversized strings and inconsistent references', () => {
  const oversized = copy(fixture);
  oversized.scenarios[0].name = 'ก'.repeat(161);
  assert.throws(() => validate(oversized), /scenario\[0\]\.name/);

  const missingActive = copy(fixture);
  missingActive.activeScenario = 99;
  assert.throws(() => validate(missingActive), /activeScenario/);
});

test('escapes scenario-controlled markup for HTML rendering', () => {
  assert.equal(
    context.esc('<img src=x onerror="globalThis.pwned=1">'),
    '&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;'
  );
});
