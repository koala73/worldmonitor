// Repair only the snapshot that was read. Keep its payload and success clock unchanged.
export const CABLE_HEALTH_REPAIR_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "local clock = redis.call('TIME')",
  'local now = tonumber(clock[1]) * 1000.0 + tonumber(clock[2]) / 1000',
  'if tonumber(ARGV[2]) <= now then return 0 end',
  "redis.call('PEXPIREAT', KEYS[1], ARGV[2])",
  "if redis.call('GET', KEYS[2]) ~= ARGV[3] then",
  "  redis.call('SET', KEYS[2], ARGV[3], 'EX', 604800)",
  'end',
  'return 1',
].join('\n');
