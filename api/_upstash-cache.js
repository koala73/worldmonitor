const isSidecar = (process.env.LOCAL_API_MODE || '').includes('sidecar');

// ── In-memory cache (desktop/sidecar) ──
const mem = new Map();
let persistPath = null;
let persistTimer = null;
let persistInFlight = false;
let persistQueued = false;
let loaded = false;
const MAX_PERSIST_ENTRIES = Math.max(100, Number(process.env.LOCAL_API_CACHE_PERSIST_MAX || 5000));

async function ensureDesktopCache() {
  if (loaded) return;
  loaded = true;
  try {
    const { join } = await import('node:path');
    const { readFileSync } = await import('node:fs');
    const dir = process.env.LOCAL_API_RESOURCE_DIR || '.';
    persistPath = join(dir, 'api-cache.json');
    const data = JSON.parse(readFileSync(persistPath, 'utf8'));
    const now = Date.now();
    for (const [k, entry] of Object.entries(data)) {
      if (entry.expiresAt > now) mem.set(k, entry);
    }
    console.log(`[Cache] Loaded ${mem.size} entries from disk`);
  } catch {
    // File doesn't exist yet
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of mem) {
      if (v.expiresAt <= now) mem.delete(k);
    }
  }, 60_000).unref?.();
}

function buildPersistSnapshot() {
  const now = Date.now();
  const payload = Object.create(null);
  let kept = 0;

  for (const [key, entry] of mem) {
    if (!entry || entry.expiresAt <= now) continue;
    payload[key] = entry;
    kept += 1;
    if (kept >= MAX_PERSIST_ENTRIES) break;
  }

  return payload;
}

async function persistToDisk() {
  if (!persistPath) return;
  if (persistInFlight) {
    persistQueued = true;
    return;
  }

  persistInFlight = true;
  try {
    const snapshot = buildPersistSnapshot();
    const json = JSON.stringify(snapshot);
    const { writeFile, rename } = await import('node:fs/promises');
    const tmp = persistPath + '.tmp';
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, persistPath);
  } catch (err) {
    console.warn('[Cache] Persist error:', err.message);
  } finally {
    persistInFlight = false;
    if (persistQueued) {
      persistQueued = false;
      void persistToDisk();
    }
  }
}

function debouncedPersist() {
  if (!persistPath) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistToDisk();
  }, 2000);
  if (persistTimer?.unref) persistTimer.unref();
}

// ── Redis (cloud/Vercel) ──
let RedisClass = null;
let redis = null;
let redisInitFailed = false;

export async function getRedis() {
  if (isSidecar) return null;
  if (redis) return redis;
  if (redisInitFailed) return null;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    if (!RedisClass) {
      const mod = await import('@upstash/redis');
      RedisClass = mod.Redis;
    }
    redis = new RedisClass({ url, token });
    return redis;
  } catch (err) {
    redisInitFailed = true;
    console.warn('[Cache] Redis init failed:', err.message);
    return null;
  }
}

// ── Shared API ──

export async function getCachedJson(key) {
  if (isSidecar) {
    await ensureDesktopCache();
    const entry = mem.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      mem.delete(key);
      return null;
    }
    return entry.value;
  }

  const r = await getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch (err) {
    console.warn('[Cache] Read failed:', err.message);
    return null;
  }
}

export async function setCachedJson(key, value, ttlSeconds) {
  if (isSidecar) {
    await ensureDesktopCache();
    mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    debouncedPersist();
    return true;
  }

  const r = await getRedis();
  if (!r) return false;
  try {
    await r.set(key, value, { ex: ttlSeconds });
    return true;
  } catch (err) {
    console.warn('[Cache] Write failed:', err.message);
    return false;
  }
}

export async function mget(...keys) {
  if (isSidecar) {
    await ensureDesktopCache();
    const now = Date.now();
    return keys.map(k => {
      const entry = mem.get(k);
      if (!entry || entry.expiresAt <= now) return null;
      return entry.value;
    });
  }

  const r = await getRedis();
  if (!r) return keys.map(() => null);
  try {
    return await r.mget(...keys);
  } catch (err) {
    console.warn('[Cache] mget failed:', err.message);
    return keys.map(() => null);
  }
}

export function hashString(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
