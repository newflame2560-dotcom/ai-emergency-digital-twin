const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const { issueToken } = require('../api/_lib/session');
const handler = require('../api/claude-proxy');

const originalFetch = global.fetch;
const originalSecret = process.env.SESSION_SIGNING_SECRET;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

process.env.SESSION_SIGNING_SECRET = 'test-session-secret-with-sufficient-length';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

test.after(() => {
  global.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.SESSION_SIGNING_SECRET;
  else process.env.SESSION_SIGNING_SECRET = originalSecret;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

function request() {
  const session = issueToken('ic');
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
    body: { userPrompt: 'ทดสอบ', systemPrompt: 'ทดสอบ', maxTokens: 1200 }
  };
}

function response() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function upstream(text) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] })
  });
}

test('proxy returns a valid structured Thai AAR response', async () => {
  const report = {
    sections: [
      { heading: 'สิ่งที่ทำได้ดี', style: 'bullets', items: ['อพยพครบตามแผน'] },
      { heading: 'จุดที่ต้องแก้ไข', style: 'bullets', items: ['ปิด < 2 ทางออก & ยืนยันด้วย "IC"'] },
      { heading: 'ข้อเสนอแนะเชิงระบบ', style: 'numbered', items: ['ทบทวน CAR รายเดือน'] }
    ]
  };
  upstream(JSON.stringify(report));
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.model, 'claude-sonnet-5');
  assert.deepEqual(JSON.parse(res.body.text), report);
});

test('proxy rejects malformed model output with a typed error and never returns raw text', async () => {
  upstream('<h3>โจมตี</h3><script>alert(1)</script>');
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, {
    error: 'AI ส่งข้อมูลในรูปแบบที่ไม่ถูกต้อง',
    code: 'AI_OUTPUT_INVALID'
  });
  assert.equal('text' in res.body, false);
});

test('proxy rejects unknown, wrong-shaped, and oversized model responses', async () => {
  const cases = [
    'not json',
    '{"sections":"<h3>oops</h3>"}',
    '{"sections":[{"heading":"x","style":"bullets","items":"<img src=x>"}]}',
    JSON.stringify({ sections: Array.from({ length: 3 }, () => ({
      heading: 'x', style: 'raw-html', items: ['<script>alert(1)</script>']
    })) }),
    JSON.stringify({ sections: Array.from({ length: 3 }, () => ({
      heading: 'x', style: 'bullets', items: ['ok'], html: '<script>alert(1)</script>'
    })) }),
    JSON.stringify({ sections: Array.from({ length: 3 }, () => ({
      heading: 'x', style: 'bullets', items: Array(9).fill('เกินจำนวน')
    })) }),
    JSON.stringify({ sections: Array.from({ length: 3 }, () => ({
      heading: 'x', style: 'bullets', items: ['ก'.repeat(501)]
    })) }),
    JSON.stringify({ answer: 'ก'.repeat(16001) })
  ];

  for (const text of cases) {
    upstream(text);
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'AI_OUTPUT_INVALID');
    assert.equal('text' in res.body, false);
  }
});

test('proxy preserves the existing chat path through a validated answer envelope', async () => {
  const answer = 'Decision Support เท่านั้น & ห้ามกลับเข้าพื้นที่อันตราย';
  upstream(JSON.stringify({ answer }));
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body.text), { answer });
});

const html = fs.readFileSync(
  new URL('../ai-emergency-digital-twin-prototype.html', `file://${__filename}`),
  'utf8'
);
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const clientValidationSource = between('function hasExactAIKeys(', '/* ---------- AI Advisory chat');
const clientRendererSource = between('function appendAIInsight(', '/* ========================================================= */\n/* AI AAR Report');
const escapingSource = between('function esc(v){', 'function roomGuidance(');
const chatRendererSource = between('let AI_CHAT_HISTORY = [];', 'function aiChatContext(){');

function clientContext() {
  const context = vm.createContext({});
  vm.runInContext(
    `${clientValidationSource}\n${clientRendererSource}\n` +
    'this.parseAIReportResponse=parseAIReportResponse;' +
    'this.parseAIChatResponse=parseAIChatResponse;' +
    'this.appendAIInsight=appendAIInsight;',
    context
  );
  return context;
}

function domNode(tag) {
  return {
    tag: tag.toLowerCase(),
    children: [],
    style: {},
    className: '',
    textContent: '',
    appendChild(child) { this.children.push(child); return child; }
  };
}

test('client renders malicious-looking model strings as literal text with DOM construction', () => {
  const malicious = {
    sections: [
      {
        heading: '<img src=x onerror=window.__xss_sentinel="heading">',
        style: 'bullets',
        items: ['<svg onload=window.__xss_sentinel="svg">']
      },
      { heading: 'จุดที่ต้องแก้ไข', style: 'bullets', items: ['<script>fetch("https://attacker.example")</script>'] },
      { heading: 'ข้อเสนอแนะ', style: 'numbered', items: ['ปิด < 2 ทางออก & ยืนยันด้วย "IC"'] }
    ]
  };
  const context = clientContext();
  const report = context.parseAIReportResponse(JSON.stringify(malicious));
  const container = domNode('div');
  context.document = { createElement: domNode };

  context.appendAIInsight(container, report);

  assert.deepEqual(container.children.map(node => node.tag), ['h2', 'div', 'p']);
  const insight = container.children[1];
  assert.deepEqual(insight.children.map(node => node.tag), ['h3', 'ul', 'h3', 'ul', 'h3', 'ol']);
  assert.equal(insight.children[0].textContent, malicious.sections[0].heading);
  assert.equal(insight.children[1].children[0].textContent, malicious.sections[0].items[0]);
  assert.equal(insight.children[5].children[0].textContent, 'ปิด < 2 ทางออก & ยืนยันด้วย "IC"');
  assert.equal(container.children[2].textContent.includes('โปรดตรวจทานก่อนใช้งานจริง'), true);
  assert.equal(context.window && context.window.__xss_sentinel, undefined);
});

test('client independently rejects malformed, unknown, and nonconforming report data', () => {
  const context = clientContext();
  const cases = [
    'not json',
    '{"sections":"wrong"}',
    JSON.stringify({ sections: Array.from({ length: 3 }, () => ({
      heading: 'x', style: 'raw-html', items: ['x']
    })) }),
    JSON.stringify({ sections: Array.from({ length: 3 }, () => ({
      heading: 'x', style: 'bullets', items: ['x'], raw: '<script>alert(1)</script>'
    })) })
  ];
  for (const text of cases) {
    assert.throws(() => context.parseAIReportResponse(text), error => {
      assert.equal(error.code, 'AI_OUTPUT_INVALID');
      return true;
    });
  }
});

test('client accepts legitimate Thai report content near schema bounds without truncation', () => {
  const longItem = `ข้อเสนอแนะ ${'ก'.repeat(487)}`;
  const report = {
    sections: [
      { heading: 'สิ่งที่ทำได้ดี', style: 'bullets', items: Array(8).fill('อพยพครบตามแผน') },
      { heading: 'จุดที่ต้องแก้ไข', style: 'bullets', items: ['ใช้คำว่า KPI และ CAR ได้ตามปกติ'] },
      { heading: 'ข้อเสนอแนะเชิงระบบ', style: 'numbered', items: [longItem] }
    ]
  };
  const context = clientContext();
  const parsed = context.parseAIReportResponse(JSON.stringify(report));
  assert.equal(parsed.sections[0].items.length, 8);
  assert.equal(parsed.sections[2].items[0], longItem);
});

test('AI chat still escapes model answers before the existing innerHTML sink', () => {
  const log = { innerHTML: '', scrollTop: 0, scrollHeight: 50 };
  const context = vm.createContext({ $: () => log });
  vm.runInContext(
    `${escapingSource}\n${chatRendererSource}\n` +
    `AI_CHAT_HISTORY.push({role:'assistant',text:'<img src=x onerror=alert(1)> & ภาษาไทย'});` +
    'renderAIChat();',
    context
  );
  assert.doesNotMatch(log.innerHTML, /<img/);
  assert.match(log.innerHTML, /&lt;img/);
  assert.match(log.innerHTML, /ภาษาไทย/);
  assert.equal(log.scrollTop, 50);
});
