import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const start = source.indexOf('const PIZZINT_SEED_INTERVAL_MS');
const end = source.indexOf('function startPizzintSeedLoop()', start);
assert.ok(start >= 0 && end > start);

function harness(responses) {
  const writes = [];
  const warnings = [];
  const context = vm.createContext({
    CHROME_UA: 'test', AbortSignal, Date,
    console: { log() {}, warn: (...args) => warnings.push(args.join(' ')) },
    fetch: async (url) => ({ ok: true, json: async () => url.includes('/gdelt/') ? {} : responses.shift() }),
    envelopeWrite: async (...args) => { writes.push(args); return true; },
    upstashSet: async (...args) => { writes.push(args); return true; },
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: () => vm.runInContext('seedPizzint()', context), writes, warnings };
}

test('empty upstream snapshot preserves payload and heartbeat, then permits recovery', async () => {
  const h = harness([
    { success: true, data: [] },
    { success: true, data: [{ place_id: 'test', is_closed_now: true, current_popularity: 0 }] },
  ]);
  await h.run();
  assert.equal(h.writes.length, 0, 'must not replace last-good data, refresh TTL, or advance heartbeat');
  assert.ok(h.warnings.some(warning => warning.includes('No data')));
  await h.run();
  assert.equal(h.writes.length, 2, 'next valid run can publish after empty response');
  const [key, payload, ttl, meta] = h.writes[0];
  assert.equal(key, 'intelligence:pizzint:seed:v1');
  assert.equal(ttl, 1800);
  assert.equal(meta.recordCount, 1);
  assert.equal(payload.pizzint.locationsMonitored, 1);
  assert.equal(payload.pizzint.locationsOpen, 0, 'closed locations are valid records');
  assert.equal(h.writes[1][0], 'seed-meta:intelligence:pizzint');
  assert.equal(h.writes[1][1].recordCount, 1);
});

test('unsuccessful and malformed upstream responses do not publish', async () => {
  const h = harness([{ success: false, data: [] }, { success: true, data: null }]);
  await h.run();
  await h.run();
  assert.equal(h.writes.length, 0);
  assert.equal(h.warnings.length, 2);
});
