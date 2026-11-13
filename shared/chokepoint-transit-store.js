import { createTransitTracker } from './chokepoint-transit-tracker.js';

const STATE_KEY = 'supply_chain:transit-gates:v1';
const INDEX_KEY = 'supply_chain:transit-gate-times:v1';
const CROSSINGS_KEY = 'supply_chain:chokepoint-crossings:v1';
const COUNT_RETENTION_MS = 24.5 * 60 * 60 * 1000;
// Bound outage memory, shared storage, and the history replayed by one EVAL.
const MAX_PENDING = 20000;
const MAX_PENDING_PER_VESSEL = 1000;
const MAX_VESSELS = 10000;
const MAX_VESSEL_ROWS = 10000;
const MAX_TOTAL_ROWS = 250000;

// Replay each affected vessel's ordered observations. Late batches can supply
// a missing first gate or an earlier completion report. Replace only this
// journal's derived events, atomically with its observation history.
export const MERGE_TRANSIT_GATES = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local cooldown = tonumber(ARGV[3])
local countRetention = tonumber(ARGV[4])
local cutoff = now - gap - countRetention
local total = tonumber(redis.call('HGET', KEYS[1], '_rows') or '0')
local incomplete = cjson.decode(redis.call('HGET', KEYS[1], '_incomplete') or '{}')
for name, deadline in pairs(cjson.decode(ARGV[9])) do
  incomplete[name] = math.max(incomplete[name] or 0, deadline)
end
for name, deadline in pairs(incomplete) do
  if deadline <= now then incomplete[name] = nil end
end
local function saveMetadata()
  redis.call('HSET', KEYS[1], '_rows', total, '_incomplete', cjson.encode(incomplete))
  redis.call('EXPIRE', KEYS[1], math.ceil((gap + countRetention) / 1000) + 3600)
  redis.call('EXPIRE', KEYS[2], math.ceil((gap + countRetention) / 1000) + 3600)
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. cutoff, 'LIMIT', 0, 4)
for _, id in ipairs(expired) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then total = total - #cjson.decode(raw).observations end
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
local vessels = redis.call('ZCARD', KEYS[2])
local groups = {}
for _, row in ipairs(cjson.decode(ARGV[5])) do
  local ts = tonumber(row[5])
  if ts <= now and ts >= cutoff then
    local id = cjson.encode({row[1], row[2]})
    if not groups[id] then groups[id] = {name=row[1], mmsi=row[2], rows={}} end
    table.insert(groups[id].rows, {row[3], row[4], ts})
  end
end
for id, group in pairs(groups) do
  local raw = redis.call('HGET', KEYS[1], id)
  local previous = raw and cjson.decode(raw) or {observations={}, crossings={}, anchor={ts=0, crossedAt=0}}
  local observations, unique = {}, {}
  for _, rows in ipairs({previous.observations, group.rows}) do
    for _, row in ipairs(rows) do
      local key = row[1] .. ':' .. row[3]
      if row[3] > previous.anchor.ts and not unique[key] then
        unique[key] = true
        table.insert(observations, row)
      end
    end
  end
  table.sort(observations, function(a,b)
    if a[3] == b[3] then return a[1] < b[1] end
    return a[3] < b[3]
  end)
  local state = previous.anchor
  local anchor = previous.anchor
  local retained, crossings = {}, {}
  for _, row in ipairs(observations) do
    local side, kind, ts = row[1], row[2], row[3]
    if ts > state.ts then
      local crossedAt = state.crossedAt
      if state.side and state.side ~= side and ts - state.ts <= gap
          and (crossedAt == 0 or ts - crossedAt >= cooldown) then
        crossedAt = ts
        if ts > now - countRetention then
          table.insert(crossings, {group.name, group.mmsi, kind, ts})
        end
      end
      state = {side=side, ts=ts, crossedAt=crossedAt}
      if ts < cutoff then anchor = state else table.insert(retained, row) end
    end
  end
  local nextTotal = total - #previous.observations + #retained
  local nextVessels = vessels + (raw and 0 or 1)
  if nextVessels > tonumber(ARGV[6]) or #retained > tonumber(ARGV[7]) or nextTotal > tonumber(ARGV[8]) then
    -- Drop only this vessel's journal, freeing capacity for other vessels.
    -- Its waterway is explicitly unavailable until all affected input ages out.
    local newest = state.ts
    for _, row in ipairs(group.rows) do newest = math.max(newest, row[3]) end
    incomplete[group.name] = math.max(incomplete[group.name] or 0, newest + gap + countRetention)
    if raw then
      redis.call('HDEL', KEYS[1], id)
      redis.call('ZREM', KEYS[2], id)
      total = total - #previous.observations
      vessels = vessels - 1
    end
  else
    for _, event in ipairs(previous.crossings) do
      redis.call('ZREM', KEYS[3], cjson.encode(event))
    end
    for _, event in ipairs(crossings) do
      redis.call('ZADD', KEYS[3], event[4], cjson.encode(event))
    end
    redis.call('HSET', KEYS[1], id, cjson.encode({observations=retained, crossings=crossings, anchor=anchor}))
    redis.call('ZADD', KEYS[2], state.ts, id)
    total = nextTotal
    vessels = nextVessels
  end
end
saveMetadata()
redis.call('EXPIRE', KEYS[3], 25 * 60 * 60)
return {1, cjson.encode(incomplete)}
`;

export function createDurableTransitTracker({ gates, maxTransitMs, cooldownMs, evaluate }) {
  let pending = [];
  let inFlight = null;
  let buffered = 0;
  const incomplete = new Map();
  const bufferedByVessel = new Map();
  const vesselKey = row => JSON.stringify(row.slice(0, 2));
  const tracker = createTransitTracker({ gates, maxTransitMs, cooldownMs,
    crossings: new Map(),
    onGateObservation: (mmsi, name, side, type, ts) => {
      const row = [name, mmsi, side, type, ts];
      const id = vesselKey(row);
      const count = bufferedByVessel.get(id) || 0;
      if (buffered >= MAX_PENDING || count >= MAX_PENDING_PER_VESSEL) {
        // A lost input can affect a later journey for gap + count retention.
        // Keep that fixed source deadline visible, including across restarts.
        incomplete.set(name, Math.max(incomplete.get(name) || 0, ts + maxTransitMs + COUNT_RETENTION_MS));
        return;
      }
      pending.push(row);
      buffered++;
      bufferedByVessel.set(id, count + 1);
    },
  });

  function release(rows) {
    buffered -= rows.length;
    for (const row of rows) {
      const id = vesselKey(row);
      const count = bufferedByVessel.get(id) - 1;
      if (count) bufferedByVessel.set(id, count);
      else bufferedByVessel.delete(id);
    }
  }

  function prune(now) {
    const cutoff = now - maxTransitMs - COUNT_RETENTION_MS;
    release(pending.filter(row => row[4] < cutoff));
    pending = pending.filter(row => row[4] >= cutoff);
    for (const [name, deadline] of incomplete) if (deadline <= now) incomplete.delete(name);
  }

  async function flush(now) {
    if (inFlight) { await inFlight; return flush(now); }
    prune(now);
    const batch = pending.filter(row => row[4] <= now);
    batch.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[4] - b[4]);
    pending = pending.filter(row => row[4] > now);
    const operation = (async () => {
      let committed = 0;
      try {
        do {
          let end = committed;
          const vessels = new Set();
          while (end < batch.length && end - committed < 1000) {
            const id = vesselKey(batch[end]);
            if (!vessels.has(id) && vessels.size === 4) break;
            vessels.add(id);
            end++;
          }
          const chunk = batch.slice(committed, end);
          const result = await evaluate(MERGE_TRANSIT_GATES,
            [STATE_KEY, INDEX_KEY, CROSSINGS_KEY],
            [now, maxTransitMs, cooldownMs, COUNT_RETENTION_MS, JSON.stringify(chunk),
              MAX_VESSELS, MAX_VESSEL_ROWS, MAX_TOTAL_ROWS, JSON.stringify(Object.fromEntries(incomplete))]);
          if (!Array.isArray(result) || result[0] !== 1 || typeof result[1] !== 'string') {
            throw new Error('Durable transit gate update failed');
          }
          const persisted = JSON.parse(result[1]);
          for (const [name, deadline] of Object.entries(persisted)) {
            if (!Number.isFinite(deadline)) throw new Error('Invalid transit capacity deadline');
            incomplete.set(name, Math.max(incomplete.get(name) || 0, deadline));
          }
          release(chunk);
          committed += chunk.length;
        } while (committed < batch.length);
      } catch (error) {
        pending = [...batch.slice(committed), ...pending];
        prune(now);
        throw error;
      }
    })();
    inFlight = operation;
    try {
      await operation;
      return new Set([...incomplete].filter(([, deadline]) => deadline > now).map(([name]) => name));
    } finally { if (inFlight === operation) inFlight = null; }
  }

  return { observe: tracker.observe, prune, flush };
}
