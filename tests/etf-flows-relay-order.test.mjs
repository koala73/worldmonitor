import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The relay is the deployed writer of market:etf-flows:v1; it must publish the
// same descending-volume order as scripts/seed-etf-flows.mjs (#11271).
const relay = readFileSync('scripts/ais-relay.cjs', 'utf8');
const seeder = readFileSync('scripts/seed-etf-flows.mjs', 'utf8');
const volumeSort = 'etfs.sort((a, b) => b.volume - a.volume);';

describe('ETF flow writers', () => {
  it('sort ETFs by descending volume before the relay writes the cache', () => {
    const start = relay.indexOf('async function seedEtfFlows(');
    const write = relay.indexOf("envelopeWrite('market:etf-flows:v1'", start);
    assert.ok(start > -1 && write > start, 'relay ETF writer not found');
    assert.ok(relay.slice(start, write).includes(volumeSort), 'relay must sort ETFs by volume before writing');
    assert.ok(seeder.includes(volumeSort), 'seed-etf-flows.mjs must keep its volume sort');
  });
});
