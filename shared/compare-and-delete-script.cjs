'use strict';

// Exact bytes the redis-rest proxy pins as COMPARE_AND_DELETE_SCRIPT.
// Seed lock release, the AIS relay owner check, and compareAndDeleteRedisKey
// must send this text: the proxy allowlist matches the script byte for byte.
// CJS so scripts/ais-relay.cjs can require() it and ESM/TS can import it.
// Mirrored at scripts/shared/compare-and-delete-script.cjs for Railway
// rootDirectory=scripts (tests/scripts-shared-mirror.test.mjs).
const COMPARE_AND_DELETE_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

module.exports = { COMPARE_AND_DELETE_SCRIPT };
