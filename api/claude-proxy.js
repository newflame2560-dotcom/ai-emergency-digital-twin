const { verifyToken, getBearerToken } = require('./_lib/session');
const { checkRateLimit } = require('./_lib/rateLimit');

// Only these roles may spend Claude API budget — see RBAC matrix in the plan.
const AI_ALLOWED_ROLES = ['ic', 'safety'];
const RATE_LIMIT_PER_ROLE_PER_HOUR = 20;
const MODEL = 'claude-sonnet-5';
const MAX_MODEL_RESPONSE_CHARS = 16000;
const MAX_REPORT_SECTIONS = 3;
const MAX_SECTION_ITEMS = 8;
const MAX_HEADING_CHARS = 80;
const MAX_ITEM_CHARS = 500;
const MAX_CHAT_ANSWER_CHARS = 4000;

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isValidReport(value) {
  if (!hasExactKeys(value, ['sections']) ||
      !Array.isArray(value.sections) ||
      value.sections.length !== MAX_REPORT_SECTIONS) return false;

  return value.sections.every(section =>
    hasExactKeys(section, ['heading', 'style', 'items']) &&
    isBoundedString(section.heading, MAX_HEADING_CHARS) &&
    ['bullets', 'numbered'].includes(section.style) &&
    Array.isArray(section.items) &&
    section.items.length > 0 &&
    section.items.length <= MAX_SECTION_ITEMS &&
    section.items.every(item => isBoundedString(item, MAX_ITEM_CHARS))
  );
}

function isValidChatAnswer(value) {
  return hasExactKeys(value, ['answer']) &&
    isBoundedString(value.answer, MAX_CHAT_ANSWER_CHARS);
}

function validateModelOutput(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_MODEL_RESPONSE_CHARS) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return false;
  }
  return isValidReport(parsed) || isValidChatAnswer(parsed);
}

function rejectInvalidModelOutput(res) {
  res.status(502).json({
    error: 'AI ส่งข้อมูลในรูปแบบที่ไม่ถูกต้อง',
    code: 'AI_OUTPUT_INVALID'
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = getBearerToken(req);
  const session = token && verifyToken(token);
  if (!session) {
    res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ หรือ session หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    return;
  }

  if (!AI_ALLOWED_ROLES.includes(session.role)) {
    res.status(403).json({ error: 'บทบาทนี้ไม่มีสิทธิ์ใช้ AI' });
    return;
  }

  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const withinLimit = await checkRateLimit(`ai_calls:${session.role}:${hourBucket}`, RATE_LIMIT_PER_ROLE_PER_HOUR, 3600);
  if (!withinLimit) {
    res.status(429).json({ error: 'ใช้งาน AI เกินโควต้าต่อชั่วโมงของบทบาทนี้แล้ว กรุณารอรอบถัดไป' });
    return;
  }

  const body = req.body || {};
  const userPrompt = body.userPrompt;
  const systemPrompt = body.systemPrompt || '';
  const maxTokens = body.maxTokens;

  if (!userPrompt || typeof userPrompt !== 'string') {
    res.status(400).json({ error: 'userPrompt is required' });
    return;
  }

  // Audit log — role + metadata only, never the prompt text itself (drill content privacy).
  console.log(JSON.stringify({
    event: 'ai_call', role: session.role, endpoint: 'claude-proxy',
    promptLength: userPrompt.length, ts: new Date().toISOString()
  }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server not configured (missing ANTHROPIC_API_KEY)' });
    return;
  }

  const anthropicBody = {
    model: MODEL,
    max_tokens: maxTokens || 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    // Sonnet 5 runs adaptive thinking by default, which can consume the whole
    // max_tokens budget on a hidden thinking block for these short-form use
    // cases. Disable it so the budget goes to the visible answer.
    thinking: { type: 'disabled' }
  };

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthropicBody)
    });
  } catch (e) {
    res.status(502).json({ error: 'เรียก Claude API ไม่สำเร็จ: ' + e.message });
    return;
  }

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const err = await resp.json();
      msg = (err && err.error && err.error.message) || msg;
    } catch (e) {}
    res.status(resp.status).json({ error: msg });
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    rejectInvalidModelOutput(res);
    return;
  }
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const block = blocks.find(b => b && b.type === 'text');
  const text = block && block.text;
  if (!validateModelOutput(text)) {
    console.log(JSON.stringify({
      event: 'ai_output_validation_failed', role: session.role, endpoint: 'claude-proxy',
      reason: 'schema_mismatch', ts: new Date().toISOString()
    }));
    rejectInvalidModelOutput(res);
    return;
  }
  res.status(200).json({ text, model: MODEL });
};
