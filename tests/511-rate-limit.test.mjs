import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  HOST_511_RATES,
  acquire511Slot,
  create511RateLimiter,
  reset511RateLimiterForTests,
} from '../scripts/_511-rate-limit.mjs';

const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
const ADAPTER_SOURCE = readFileSync(new URL('../scripts/lib/provincial-511.mjs', import.meta.url), 'utf8');
const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
// canada-roads-core.ts, not canada-roads.ts: #6763 moved the source descriptors
// into the import-safe core, so the per-jurisdiction literals this file checks
// for live there now.
const CANADA_ROADS_SOURCE = readFileSync(new URL('../src/services/canada-roads-core.ts', import.meta.url), 'utf8');

describe('per-host 511 limiter (#6618 v1)', () => {
  it('does not import the seeder from tests', () => {
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    assert.equal(/from ['"][^'"]*seed-provincial-511/.test(self), false);
    assert.equal(self.includes('seed-provincial-511.mjs'), true, 'fixture: this file must still mention the seeder as text');
  });

  it('11th call for the same host waits; a different host has its own bucket', async () => {
    let nowMs = 1_000;
    const sleeps = [];
    const limiter = create511RateLimiter({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    for (let i = 0; i < 10; i++) {
      await limiter.acquire511Slot('511on.ca');
    }
    assert.equal(limiter.pendingCount('511on.ca'), 10);
    assert.equal(limiter.pendingCount('511.alberta.ca'), 0);

    const eleventh = limiter.acquire511Slot('511on.ca');
    await eleventh;
    assert.ok(sleeps.length >= 1, '11th same-host call must wait for the window');
    assert.equal(sleeps[0], 60_000);

    sleeps.length = 0;
    await limiter.acquire511Slot('511.alberta.ca');
    assert.equal(sleeps.length, 0, 'a different host must not share the Ontario bucket');
  });

  it('three Ontario resources consume 3 tokens of the 511on.ca bucket', async () => {
    reset511RateLimiterForTests();
    await acquire511Slot('511on.ca');
    await acquire511Slot('511on.ca');
    await acquire511Slot('511on.ca');
    // BC Open511 is a different host and must not wait on Ontario's 3 tokens.
    const started = Date.now();
    await acquire511Slot('api.open511.gov.bc.ca');
    assert.ok(Date.now() - started < 50, 'BC host must not share the Ontario bucket');
  });

  it('adapter acquires the Ontario host slot before each fetch', () => {
    assert.match(ADAPTER_SOURCE, /acquire511Slot\(hostname\)/);
    assert.match(ADAPTER_SOURCE, /511on\.ca/);
    assert.match(ADAPTER_SOURCE, /511\.alberta\.ca/);
    assert.doesNotMatch(ADAPTER_SOURCE, /open511\.gov\.bc/);
    assert.doesNotMatch(ADAPTER_SOURCE, /from ['"]\.\.\/\.\.\/shared\//);
    assert.doesNotMatch(ADAPTER_SOURCE, /fetch\.bind/);
  });

  it('BC Open511 is paced at one request per second; Ontario stays 10/60', async () => {
    assert.deepEqual(HOST_511_RATES['api.open511.gov.bc.ca'], { capacity: 1, windowMs: 1_000 });
    let nowMs = 1_000;
    const sleeps = [];
    const limiter = create511RateLimiter({
      hostRates: HOST_511_RATES,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await limiter.acquire511Slot('api.open511.gov.bc.ca');
    assert.equal(limiter.pendingCount('api.open511.gov.bc.ca'), 1);
    assert.equal(limiter.pendingCount('511on.ca'), 0);

    await limiter.acquire511Slot('api.open511.gov.bc.ca');
    assert.ok(sleeps.length >= 1, 'second BC call must wait for the one-second window');
    assert.equal(sleeps[0], 1_000);

    sleeps.length = 0;
    for (let i = 0; i < 10; i++) {
      await limiter.acquire511Slot('511on.ca');
    }
    assert.equal(sleeps.length, 0, 'Ontario 10/60 must not wait on the first 10 calls');
    await limiter.acquire511Slot('511on.ca');
    assert.ok(sleeps.length >= 1, '11th Ontario call must still wait');
    assert.equal(sleeps[0], 60_000);
  });

  it('seeder is a standalone nixpacks job and does not loop ais-relay', () => {
    assert.match(SEEDER_SOURCE, /fetchVendor511\(ONTARIO_511/);
    assert.match(SEEDER_SOURCE, /fetchVendor511\(ALBERTA_511/);
    assert.match(SEEDER_SOURCE, /fetchVendor511\(MANITOBA_511/);
    assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
    assert.match(SEEDER_SOURCE, /infra:ontario-511:v1/);
    assert.match(SEEDER_SOURCE, /infra:alberta-511:v1/);
    assert.match(SEEDER_SOURCE, /infra:manitoba-511:v1/);
    assert.match(SEEDER_SOURCE, /seed-meta:infra:alberta-511/);
    assert.match(SEEDER_SOURCE, /seed-meta:infra:manitoba-511/);
    assert.doesNotMatch(RELAY_SOURCE, /511on\.ca/);
    assert.doesNotMatch(RELAY_SOURCE, /511\.alberta\.ca/);
    assert.doesNotMatch(RELAY_SOURCE, /manitoba511/);
    assert.doesNotMatch(RELAY_SOURCE, /ontario-511/);
    assert.doesNotMatch(RELAY_SOURCE, /alberta-511/);
    assert.doesNotMatch(RELAY_SOURCE, /manitoba-511/);
    assert.doesNotMatch(RELAY_SOURCE, /canadaRoads/);
    assert.match(CANADA_ROADS_SOURCE, /albertaRoads/);
    assert.match(CANADA_ROADS_SOURCE, /alberta-511/);
    assert.match(CANADA_ROADS_SOURCE, /manitobaRoads/);
    assert.match(CANADA_ROADS_SOURCE, /manitoba-511/);
  });

  it('511.alberta.ca is a separate limiter bucket from 511on.ca', async () => {
    const limiter = create511RateLimiter({
      now: () => 1_000,
      sleep: async () => {
        throw new Error('Alberta must not wait on Ontario tokens');
      },
    });
    for (let i = 0; i < 10; i++) {
      await limiter.acquire511Slot('511on.ca');
    }
    await limiter.acquire511Slot('511.alberta.ca');
    assert.equal(limiter.pendingCount('511on.ca'), 10);
    assert.equal(limiter.pendingCount('511.alberta.ca'), 1);
  });

  it('www.manitoba511.ca is a separate limiter bucket from 511on.ca', async () => {
    const limiter = create511RateLimiter({
      now: () => 1_000,
      sleep: async () => {
        throw new Error('Manitoba must not wait on Ontario tokens');
      },
    });
    for (let i = 0; i < 10; i++) {
      await limiter.acquire511Slot('511on.ca');
    }
    await limiter.acquire511Slot('www.manitoba511.ca');
    assert.equal(limiter.pendingCount('511on.ca'), 10);
    assert.equal(limiter.pendingCount('www.manitoba511.ca'), 1);
  });
});
