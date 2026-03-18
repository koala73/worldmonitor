export function createIpRateLimiter({ limit, windowMs }) {
  const rateLimitMap = new Map();

  function getEntry(ip) {
    return rateLimitMap.get(ip) || null;
  }

  function isRateLimited(ip) {
    const now = Date.now();
    const entry = getEntry(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      rateLimitMap.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  }

  return { isRateLimited, getEntry };
}
