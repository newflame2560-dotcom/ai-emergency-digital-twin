const crypto = require('crypto');

const VALID_ROLES = ['ic', 'safety', 'floor_warden', 'security', 'observer'];
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecodeToString(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function sign(payloadObj) {
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!secret) throw new Error('SESSION_SIGNING_SECRET not configured');
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function issueToken(role) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { role, iat: now, exp: now + SESSION_TTL_SECONDS };
  return { token: sign(payload), role, exp: payload.exp };
}

// Returns the verified {role, iat, exp} payload, or null if invalid/expired/misconfigured.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!secret) return null;

  const expectedSig = base64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadB64));
  } catch (e) {
    return null;
  }
  if (!payload || !VALID_ROLES.includes(payload.role)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

function getBearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

module.exports = { VALID_ROLES, issueToken, verifyToken, getBearerToken };
