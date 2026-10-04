import { MCP_QUOTA_RESERVE_SCRIPT } from './mcp-quota-reserve-script.mjs';

export const PANEL_REQUEST_RESERVE_SCRIPT = [
  "local current = tonumber(redis.call('GET', KEYS[3]))",
  "local expires = current or tonumber(redis.call('GET', KEYS[4]))",
  'if expires ~= nil then',
  "  local n = tonumber(redis.call('GET', KEYS[1]))",
  '  if n == nil or n < 0 then return {-1, 0} end',
  '  return {current and 2 or 3, n, expires}',
  'end',
  MCP_QUOTA_RESERVE_SCRIPT.replaceAll('return {1, n}', "redis.call('SET', KEYS[3], ARGV[6], 'EX', ARGV[5])\n  return {1, n, tonumber(ARGV[6])}"),
].join('\n');

export const PANEL_REQUEST_READ_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[3] then return {-1, 0} end",
  "local n = redis.call('INCRBY', KEYS[2], 1)",
  "redis.call('EXPIRE', KEYS[2], ARGV[2])",
  'if n > tonumber(ARGV[1]) then',
  "  redis.call('DECRBY', KEYS[2], 1)",
  '  return {0, n - 1}',
  'end',
  'return {1, n}',
].join('\n');
