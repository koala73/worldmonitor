// Fenced atomic publication for one story-alias cohort.
//
// A digest build first obtains KEYS[1] with SET NX PX and passes that unique
// value as ARGV[1]. This script verifies the lease at Redis execution time
// before it writes any aliases. The check is a fencing token: an older request
// delayed past its lease cannot overwrite a newer cohort after the lock has
// expired or changed owners.
//
// KEYS[1] is the publication-lock key; KEYS[2..] are member alias keys.
// ARGV: 1=lock token, 2=canonical hash, 3=alias TTL seconds.
// Returns 1 when the complete cohort was written, 0 when the writer is stale.
//
// docker/redis-rest-proxy.mjs carries a byte-identical pinned copy because it
// allowlists EVAL scripts by exact text. Keep the two copies in sync.
export const STORY_ALIAS_PUBLISH_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  'for index = 2, #KEYS do',
  "  redis.call('SET', KEYS[index], ARGV[2], 'EX', ARGV[3])",
  'end',
  'return 1',
].join('\n');
