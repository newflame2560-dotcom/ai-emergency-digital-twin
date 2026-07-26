const { issueToken, VALID_ROLES } = require('./_lib/session');
const { checkRateLimit } = require('./_lib/rateLimit');

const ROLE_ENV_MAP = {
  ic: 'ROLE_PASSCODE_IC',
  safety: 'ROLE_PASSCODE_SAFETY',
  floor_warden: 'ROLE_PASSCODE_FLOOR_WARDEN',
  security: 'ROLE_PASSCODE_SECURITY',
  observer: 'ROLE_PASSCODE_OBSERVER'
};

function logAttempt(role, success) {
  console.log(JSON.stringify({ event: 'login', role: role || 'unknown', success, ts: new Date().toISOString() }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = ((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown') + '').split(',')[0].trim();
  const withinLimit = await checkRateLimit(`login_attempts:${ip}`, 5, 60);
  if (!withinLimit) {
    res.status(429).json({ error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
    return;
  }

  const body = req.body || {};
  const role = body.role;
  const passcode = body.passcode;

  // Deliberately generic — do not reveal whether the role or the passcode was wrong.
  const denyLogin = () => res.status(401).json({ error: 'เข้าสู่ระบบไม่สำเร็จ ตรวจสอบบทบาทและรหัสผ่าน' });

  if (!role || !VALID_ROLES.includes(role) || typeof passcode !== 'string' || !passcode) {
    logAttempt(role, false);
    denyLogin();
    return;
  }

  const expected = process.env[ROLE_ENV_MAP[role]];
  if (!expected || passcode !== expected) {
    logAttempt(role, false);
    denyLogin();
    return;
  }

  logAttempt(role, true);
  const { token, exp } = issueToken(role);
  res.status(200).json({ token, role, exp });
};
