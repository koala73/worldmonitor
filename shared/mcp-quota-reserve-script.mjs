// Atomic reservation + owner-only reject/clamp for Pro MCP daily quota.
//
// Redis serializes EVAL, so increment, this-request rollback, and F4 residue
// clamp cannot interleave with another reservation. After this script's DECR,
// any remaining overshoot is failed-rollback residue, not another request's
// still-live increment, so SET cannot steal a concurrent reservation and later
// undercount the meter (#7272).
//
// KEYS[2] records the highest allowance that successfully reserved today
// (`-1` = unlimited). Clamp never drops the shared counter below that floor, so
// a user_key 50/day rejection cannot SET away a Pro Business 250/day charge on
// the same key.
//
// docker/redis-rest-proxy.mjs carries a byte-identical pinned copy because it
// allowlists EVAL scripts by exact text. Keep the two copies in sync.
//
// KEYS[1] = daily counter
// KEYS[2] = max successful limit today (`-1` = unlimited seen)
// ARGV[1] = finite limit, or empty for unlimited (meter only)
// ARGV[2] = TTL seconds
//
// Returns {status, count}:
//   1, n  reserved at n
//   0, n  rejected; n is the post-recovery count
//  -1, 0  unreadable limit (fail closed after rolling back this INCR)
export const MCP_QUOTA_RESERVE_SCRIPT = [
  'local ttl = tonumber(ARGV[2])',
  "local n = redis.call('INCR', KEYS[1])",
  'if ttl ~= nil and ttl > 0 then',
  "  redis.call('EXPIRE', KEYS[1], ttl)",
  'end',
  '',
  'local function read_floor()',
  "  local raw = redis.call('GET', KEYS[2])",
  "  if raw == false or raw == nil or raw == '' then return nil end",
  '  return tonumber(raw)',
  'end',
  '',
  'local function write_floor(value)',
  "  redis.call('SET', KEYS[2], value)",
  '  if ttl ~= nil and ttl > 0 then',
  "    redis.call('EXPIRE', KEYS[2], ttl)",
  '  end',
  'end',
  '',
  'local function remember_success(limit)',
  '  local seen = read_floor()',
  '  if seen == -1 then return end',
  '  if seen == nil or limit > seen then',
  '    write_floor(limit)',
  '  end',
  'end',
  '',
  'local limit_raw = ARGV[1]',
  "if limit_raw == nil or limit_raw == false or limit_raw == '' then",
  '  write_floor(-1)',
  '  return {1, n}',
  'end',
  '',
  'local limit = tonumber(limit_raw)',
  'if limit == nil or limit < 0 then',
  "  redis.call('DECR', KEYS[1])",
  '  return {-1, 0}',
  'end',
  '',
  'if n <= limit then',
  '  remember_success(limit)',
  '  return {1, n}',
  'end',
  '',
  "n = redis.call('DECR', KEYS[1])",
  'local seen = read_floor()',
  'if seen ~= -1 then',
  '  local clamp_to = limit',
  '  if seen ~= nil and seen > clamp_to then clamp_to = seen end',
  '  if n > clamp_to then',
  "    redis.call('SET', KEYS[1], clamp_to)",
  '    if ttl ~= nil and ttl > 0 then',
  "      redis.call('EXPIRE', KEYS[1], ttl)",
  '    end',
  '    n = clamp_to',
  '  end',
  'end',
  'return {0, n}',
].join('\n');
