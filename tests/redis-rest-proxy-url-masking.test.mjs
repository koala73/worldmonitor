// docker/redis-rest-proxy.mjs connects to Redis (and calls server.listen) as a
// top-level side effect on import, so it can't be required directly in a unit
// test — same constraint as scripts/ais-relay.cjs (see
// relay-boot-seed-freshness-guard.test.mjs). Extract maskRedisUrl's real
// source via regex and eval it standalone instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');

const helperSrc = proxySrc.match(/function maskRedisUrl\([\s\S]*?\n\}/)?.[0];

function buildMaskRedisUrl() {
  // eslint-disable-next-line no-new-func
  return new Function(`${helperSrc}\nreturn maskRedisUrl;`)();
}

describe('maskRedisUrl (redis-rest-proxy)', () => {
  it('is defined in redis-rest-proxy.mjs', () => {
    assert.ok(helperSrc, 'maskRedisUrl not found in docker/redis-rest-proxy.mjs');
  });

  it('redacts the password from a SRH_CONNECTION_STRING-shaped URL', () => {
    const maskRedisUrl = buildMaskRedisUrl();
    const masked = maskRedisUrl('redis://:deadbeef00112233445566778899aabbccddeeff00112233445566778899aa@redis:6379');
    assert.equal(masked, 'redis://:***@redis:6379');
    assert.doesNotMatch(masked, /deadbeef00112233445566778899aabbccddeeff00112233445566778899aa/);
  });

  it('redacts a username when present too', () => {
    const maskRedisUrl = buildMaskRedisUrl();
    assert.equal(maskRedisUrl('redis://user:pass@host:6379/0'), 'redis://***:***@host:6379/0');
  });

  it('passes through a URL with no credentials unchanged', () => {
    const maskRedisUrl = buildMaskRedisUrl();
    assert.equal(maskRedisUrl('redis://redis:6379'), 'redis://redis:6379');
  });

  it('fails safe (never throws, never returns the raw input) on an unparsable value', () => {
    const maskRedisUrl = buildMaskRedisUrl();
    assert.equal(maskRedisUrl('not a url'), '<unparsable redis URL>');
  });

  it('is called at the actual "Connected to Redis at" log site (regression guard)', () => {
    // The whole point of this fix: REDIS_URL itself must never reach a
    // console call unmasked again.
    assert.match(proxySrc, /console\.log\(`Connected to Redis at \$\{maskRedisUrl\(REDIS_URL\)\}`\)/);
    assert.doesNotMatch(proxySrc, /console\.(log|error|warn|info)\([^)]*\$\{REDIS_URL\}/);
  });
});
