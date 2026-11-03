export const TRANSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
const RETENTION_MS = TRANSIT_WINDOW_MS + COOLDOWN_MS;
const WINDOW_KEY = 'supply_chain:chokepoint-crossings:v1';

// Merge observations atomically so retries and overlapping deployments cannot
// replace another relay's history. Scores remain the original observation time.
export const MERGE_TRANSIT_WINDOW = `
local now = tonumber(ARGV[1])
local cutoff = now - tonumber(ARGV[2])
local events = cjson.decode(ARGV[4])
for _, event in ipairs(events) do
  local ts = tonumber(event[4])
  if ts > cutoff and ts <= now then
    redis.call('ZADD', KEYS[1], ts, cjson.encode(event))
  end
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. cutoff, now)
`;

export async function readTransitWindow(crossings, now, evaluate) {
  const batch = [];
  for (const [name, events] of crossings) {
    for (const { mmsi, type, ts } of events) {
      if (ts > now - RETENTION_MS && ts <= now) batch.push([name, mmsi, type, ts]);
    }
  }
  const rows = await evaluate(MERGE_TRANSIT_WINDOW, [WINDOW_KEY], [
    now, RETENTION_MS, 25 * 60 * 60, JSON.stringify(batch),
  ]);
  if (!Array.isArray(rows)) throw new Error('Durable transit window unavailable');
  const result = new Map();
  const lastCrossing = new Map();
  for (const row of rows) {
    let event;
    try { event = JSON.parse(row); } catch { throw new Error('Invalid durable transit window'); }
    if (!Array.isArray(event) || event.length !== 4
      || typeof event[0] !== 'string' || typeof event[1] !== 'string'
      || !['tanker', 'cargo', 'other'].includes(event[2]) || !Number.isFinite(event[3])) {
      throw new Error('Invalid durable transit window');
    }
    const [name, mmsi, type, ts] = event;
    if (ts <= now - RETENTION_MS || ts > now) continue;
    const key = `${name}:${mmsi}`;
    if (lastCrossing.has(key) && ts - lastCrossing.get(key) < COOLDOWN_MS) continue;
    lastCrossing.set(key, ts);
    // Keep the expired original through the cooldown so a later duplicate
    // cannot become countable when the original leaves the display window.
    if (ts <= now - TRANSIT_WINDOW_MS) continue;
    if (!result.has(name)) result.set(name, []);
    result.get(name).push({ mmsi, type, ts });
  }
  return result;
}
