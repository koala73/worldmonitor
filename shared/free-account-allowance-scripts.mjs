// Atomic free-account MCP allowance reservation and its read-only snapshot.
//
// Redis serializes EVAL, so the reserve script can reject before the first
// write and commit the three allowance keys together. The read script is
// GET/PTTL only: the account-status resource must not observe a torn snapshot
// while a reservation is committing, and it must not be able to mutate state.
//
// docker/redis-rest-proxy.mjs carries byte-identical pinned copies because it
// allowlists EVAL scripts by exact text. Keep the copies in sync; do not
// hand-edit one side.
//
// Reserve KEYS:
//   [1] daily call counter
//   [2] daily request-window counter
//   [3] last-activity timestamp (PX = idle gap)
// Reserve ARGV:
//   [1] now ms
//   [2] idle gap ms
//   [3] calls/day limit
//   [4] request windows/day limit
//   [5] counter TTL seconds
// Reserve results: {1} admitted, {0} exhausted, {-1} malformed (fail closed)
//
// Read KEYS are the same three. Result: {calls, requests, activity PTTL}.

export const RESERVE_FREE_ACCOUNT_ALLOWANCE_SCRIPT = [
  'local function non_negative_integer(raw)',
  '  if raw == false or raw == nil then return 0 end',
  '  local value = tonumber(raw)',
  '  if value == nil or value < 0 or value ~= math.floor(value) then return nil end',
  '  return value',
  'end',
  '',
  "local calls_raw = redis.call('GET', KEYS[1])",
  "local requests_raw = redis.call('GET', KEYS[2])",
  "local last_raw = redis.call('GET', KEYS[3])",
  'local calls = non_negative_integer(calls_raw)',
  'local requests = non_negative_integer(requests_raw)',
  'local last = nil',
  'if last_raw ~= false and last_raw ~= nil then',
  '  last = non_negative_integer(last_raw)',
  'end',
  'local calls_missing = calls_raw == false or calls_raw == nil',
  'local requests_missing = requests_raw == false or requests_raw == nil',
  'local last_present = last_raw ~= false and last_raw ~= nil',
  'if calls == nil or requests == nil or (last_present and last == nil) then',
  '  return {-1}',
  'end',
  'if calls_missing ~= requests_missing or requests > calls or (last_present and calls == 0) then',
  '  return {-1}',
  'end',
  '',
  'local now_ms = tonumber(ARGV[1])',
  'local idle_gap_ms = tonumber(ARGV[2])',
  'local calls_limit = tonumber(ARGV[3])',
  'local requests_limit = tonumber(ARGV[4])',
  'local opens_window = last == nil or now_ms - last >= idle_gap_ms',
  'local activity_value = ARGV[1]',
  'if last ~= nil and last > now_ms then activity_value = last_raw end',
  '',
  'if calls >= calls_limit then return {0} end',
  'if opens_window and requests >= requests_limit then return {0} end',
  '',
  'calls = calls + 1',
  'if opens_window then requests = requests + 1 end',
  "redis.call('SET', KEYS[1], tostring(calls), 'EX', ARGV[5])",
  'if opens_window then',
  "  redis.call('SET', KEYS[2], tostring(requests), 'EX', ARGV[5])",
  'end',
  "redis.call('SET', KEYS[3], activity_value, 'PX', ARGV[2])",
  'return {1}',
].join('\n');

export const READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT = [
  "local calls = redis.call('GET', KEYS[1])",
  "local requests = redis.call('GET', KEYS[2])",
  "local activityPttl = redis.call('PTTL', KEYS[3])",
  'return {calls or false, requests or false, activityPttl}',
].join('\n');
