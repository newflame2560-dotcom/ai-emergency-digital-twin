// Rate limiter: uses Vercel KV (Upstash REST protocol) if provisioned via
// KV_REST_API_URL / KV_REST_API_TOKEN env vars, so counts are shared across
// all function instances. If KV isn't provisioned, falls back to a weak
// per-instance in-memory counter (resets on cold start, not shared across
// regions) — good enough to blunt casual abuse, not a hard guarantee.

const fallbackStore = new Map();

function checkFallback(key, limit, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const entry = fallbackStore.get(key);
  if (!entry || now - entry.start > windowMs) {
    fallbackStore.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

async function kvIncrWithExpiry(key, windowSeconds) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const headers = { Authorization: `Bearer ${token}` };
  const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, { headers });
  if (!incrRes.ok) return null;
  const { result: count } = await incrRes.json();
  if (count === 1) {
    // first hit in this window — set the key to expire so it auto-resets
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${windowSeconds}`, { headers }).catch(() => {});
  }
  return count;
}

// Returns true if the call is within the limit, false if it should be rejected (429).
async function checkRateLimit(key, limit, windowSeconds) {
  let count = null;
  try {
    count = await kvIncrWithExpiry(key, windowSeconds);
  } catch (e) {
    count = null;
  }
  if (count === null) return checkFallback(key, limit, windowSeconds);
  return count <= limit;
}

module.exports = { checkRateLimit };
