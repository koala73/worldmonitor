// Atomic replacement gate for the durable last-good digest snapshot (#7084),
// executed inside Redis so concurrent isolates cannot interleave a
// read-decide-write.
//
// MIRROR of shouldReplaceAccepted in server/worldmonitor/news/v1/_lastgood.ts —
// the same rules, in the same order. The TS function is the tested fast path
// (it decides whether to attempt the ~126KB upload at all); this script is the
// authoritative gate at write time. Change them together.
//
// A second consumer holds a byte-identical copy: docker/redis-rest-proxy.mjs
// allowlists EVAL for exactly this script (its image bundles only its own
// file, so it cannot import this module). tests/digest-lastgood.test.mts pins
// the two copies equal — edit both or that test goes red.
//
// The script reads the revocation set and measures BOTH bodies inside this
// atomic operation. Stored bodies remain unfiltered, but a URL revoked after
// incumbent publication cannot keep inflating its richness and veto repair.
//
// KEYS[1] = metadata key, KEYS[2] = snapshot body key,
// KEYS[3] = revoked URL set.
// ARGV: 1=nowMs 2=maxAgeMs 3=candidateAcceptedAt 4=ttlSeconds
//       5=candidateJson ({ acceptedAt, data }).
// Returns 1 when written, 0 when the live snapshot was kept, -1 when the
// candidate has no servable items.
export const DIGEST_LASTGOOD_PUBLISH_SCRIPT = [
  'local revoked = {}',
  "for _, url in ipairs(redis.call('SMEMBERS', KEYS[3])) do revoked[url] = true end",
  'local function decodeAndCount(raw)',
  '  local ok, snapshot = pcall(cjson.decode, raw)',
  "  if not ok or type(snapshot) ~= 'table' or type(snapshot.data) ~= 'table' or type(snapshot.data.categories) ~= 'table' then",
  '    return nil',
  '  end',
  '  local categories = 0',
  '  local items = 0',
  '  for _, bucket in pairs(snapshot.data.categories) do',
  '    categories = categories + 1',
  "    if type(bucket) == 'table' and type(bucket.items) == 'table' then",
  '      for _, item in ipairs(bucket.items) do',
  "        local isRevoked = type(item) == 'table' and type(item.link) == 'string' and revoked[item.link]",
  '        if not isRevoked then items = items + 1 end',
  '      end',
  '    end',
  '  end',
  '  return { snapshot = snapshot, categories = categories, items = items }',
  'end',
  'local candidate = decodeAndCount(ARGV[5])',
  'if not candidate or candidate.categories < 1 or candidate.items < 1 then return -1 end',
  "local currentRaw = redis.call('GET', KEYS[2])",
  'if currentRaw then',
  '  local current = decodeAndCount(currentRaw)',
  '  if current then',
  '    local delta = tonumber(ARGV[1]) - (tonumber(current.snapshot.acceptedAt) or 0)',
  '    local live = delta >= 0 and delta <= tonumber(ARGV[2])',
  '    if live and (candidate.categories < current.categories or candidate.items < current.items) then return 0 end',
  '  end',
  'end',
  'local meta = { acceptedAt = tonumber(ARGV[3]), categoryCount = candidate.categories, itemCount = candidate.items }',
  'local stored = { acceptedAt = tonumber(ARGV[3]), categoryCount = candidate.categories, itemCount = candidate.items, data = candidate.snapshot.data }',
  "redis.call('SET', KEYS[1], cjson.encode(meta), 'EX', ARGV[4])",
  "redis.call('SET', KEYS[2], cjson.encode(stored), 'EX', ARGV[4])",
  'return 1',
].join('\n');
