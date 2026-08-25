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
// Gate rules, mirrored from shouldReplaceAccepted:
// - no current metadata, unparseable metadata, or an EXPIRED current snapshot
//   never vetoes;
// - a FUTURE acceptedAt is corrupt, not live — it must not veto (delta < 0);
// - metadata whose paired BODY is gone cannot veto: Redis eviction is not
//   TTL-bound and can drop one key of the pair, and a body-less veto would
//   block repair until the metadata expired;
// - a candidate narrower on categories OR items does not displace a live,
//   servable snapshot.
//
// KEYS[1] = metadata key, KEYS[2] = snapshot body key.
// ARGV: 1=nowMs 2=maxAgeMs 3=candCategoryCount 4=candItemCount
//       5=metaJson 6=ttlSeconds 7=bodyJson
// Returns 1 when written, 0 when the live snapshot was kept.
export const DIGEST_LASTGOOD_PUBLISH_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1])",
  "if cur and redis.call('EXISTS', KEYS[2]) == 1 then",
  '  local ok, meta = pcall(cjson.decode, cur)',
  "  if ok and type(meta) == 'table' then",
  '    local curAcc = tonumber(meta.acceptedAt) or 0',
  '    local curCat = tonumber(meta.categoryCount) or 0',
  '    local curItems = tonumber(meta.itemCount) or 0',
  '    local delta = tonumber(ARGV[1]) - curAcc',
  '    local live = delta >= 0 and delta <= tonumber(ARGV[2])',
  '    if live and (tonumber(ARGV[3]) < curCat or tonumber(ARGV[4]) < curItems) then',
  '      return 0',
  '    end',
  '  end',
  'end',
  "redis.call('SET', KEYS[1], ARGV[5], 'EX', ARGV[6])",
  "redis.call('SET', KEYS[2], ARGV[7], 'EX', ARGV[6])",
  'return 1',
].join('\n');
