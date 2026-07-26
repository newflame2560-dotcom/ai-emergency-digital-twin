const { verifyToken, getBearerToken } = require('./_lib/session');

// The Google Maps JavaScript API key is inherently visible in the browser's
// Network tab and DOM (<script src>) once loaded — that is normal for this
// API, not a bug here. Gating this endpoint behind login just stops a
// logged-out visitor from being handed the key at all; the real protection
// is the HTTP referrer + API + quota restriction set on the key in Google
// Cloud Console (see the plan's Step 0).
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = getBearerToken(req);
  const session = token && verifyToken(token);
  if (!session) {
    res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ หรือ session หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    return;
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server not configured (missing GOOGLE_MAPS_API_KEY)' });
    return;
  }

  res.status(200).json({ key });
};
