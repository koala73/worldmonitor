// forecast:resolutions:v1 grew past MAX_PAYLOAD_BYTES (5.0MB > 5MB, Railway
// deployment 4cd2d87b, 2026-10-21) and seed-forecast-resolutions exited 1 on
// every tick. The ledger keeps 180 days of resolved entries with their full
// judged evidence, because a corrected receipt is rebuilt from the hot entry,
// so it cannot be trimmed without losing audit evidence. A seeder can instead
// opt into gzip storage. The stored value is not JSON, so a reader that has
// not learned the encoding fails instead of reading an empty ledger.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const {
  atomicPublish,
  MAX_PAYLOAD_BYTES,
  readCanonicalEnvelopeMeta,
  readSeedSnapshot,
  verifySeedKey,
} = await import('../scripts/_seed-utils.mjs');
const { GZIP_PAYLOAD_PREFIX, MAX_DECODED_PAYLOAD_BYTES, encodeGzipPayload, parseStoredSeedJson } = await import('../scripts/_seed-payload-codec.mjs');
const { readRedisJson: readResolutionsJson } = await import('../scripts/seed-forecast-resolutions.mjs');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Ledger-shaped and compressible like the real one: repeated keys, URLs and
// question text across ~6MB of entries.
function largeLedger(minBytes = MAX_PAYLOAD_BYTES + 512 * 1024) {
  const ledger = {};
  let bytes = 0;
  for (let i = 0; bytes < minBytes; i++) {
    const entry = {
      key: `fc-conflict-${i.toString(16)}@${1786000000000 + i}`,
      status: 'resolved',
      outcome: i % 3 ? 'NO' : 'YES',
      spec: { kind: 'judged', question: `Will the conflict in region ${i % 40} escalate by the deadline?` },
      evidence: {
        archive: Array.from({ length: 6 }, (_, j) => ({
          id: `article-${(i * 7 + j) % 900}`,
          title: `Headline ${(i * 7 + j) % 900} about the regional conflict`,
          url: `https://news.example/${(i * 7 + j) % 900}`,
          source: 'Example Wire',
          publishedAt: 1786000000000 + j * 60_000,
        })),
      },
    };
    ledger[entry.key] = entry;
    bytes += JSON.stringify(entry).length;
  }
  return ledger;
}

function recordingFetch() {
  const commands = [];
  globalThis.fetch = async (_url, init) => {
    commands.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };
  return commands;
}

function storedValueFetch(stored) {
  globalThis.fetch = async () => new Response(JSON.stringify({ result: stored }), { status: 200 });
}

describe('compressed seed payloads', () => {
  it('publishes a ledger over the raw cap when the seeder opts into gzip', async () => {
    const ledger = largeLedger();
    const envelopeMeta = { fetchedAt: 1, recordCount: Object.keys(ledger).length, sourceVersion: 'v', schemaVersion: 1, state: 'OK' };
    assert.ok(JSON.stringify({ _seed: envelopeMeta, data: ledger }).length > MAX_PAYLOAD_BYTES);
    const commands = recordingFetch();

    const result = await atomicPublish('forecast:resolutions:v1', ledger, null, undefined, { envelopeMeta, compressPayload: true });

    assert.ok(result.payloadBytes <= MAX_PAYLOAD_BYTES);
    const sets = commands.filter((command) => command[0] === 'SET');
    assert.equal(sets.length, 2, 'staging SET + canonical SET');
    for (const [, , value] of sets) {
      assert.ok(value.startsWith(GZIP_PAYLOAD_PREFIX));
      assert.equal(Buffer.byteLength(value), result.payloadBytes);
    }
    const canonical = sets.find(([, key]) => key === 'forecast:resolutions:v1')[2];
    const decoded = JSON.parse(gunzipSync(Buffer.from(canonical.slice(GZIP_PAYLOAD_PREFIX.length), 'base64')).toString('utf8'));
    assert.deepEqual(decoded.data, ledger);
    assert.equal(decoded._seed.recordCount, Object.keys(ledger).length);
  });

  it('keeps the raw cap for seeders that do not opt in', async () => {
    recordingFetch();
    await assert.rejects(
      atomicPublish('forecast:resolutions:v1', largeLedger(), null, undefined, {}),
      /Payload too large/,
    );
  });

  it('applies the cap to the encoded bytes', async () => {
    const commands = recordingFetch();
    const incompressible = { blob: randomBytes(4 * 1024 * 1024).toString('base64') };
    await assert.rejects(
      atomicPublish('test:incompressible:v1', incompressible, null, undefined, { compressPayload: true }),
      /Payload too large/,
    );
    assert.equal(commands.length, 0, 'nothing written');
  });

  it('refuses to publish a compressed value its readers could not inflate', async () => {
    const commands = recordingFetch();
    const huge = { blob: 'a'.repeat(MAX_DECODED_PAYLOAD_BYTES) };
    assert.ok(encodeGzipPayload(JSON.stringify(huge)).length < MAX_PAYLOAD_BYTES, 'encoded value fits the publish cap');
    await assert.rejects(
      atomicPublish('test:huge:v1', huge, null, undefined, { compressPayload: true }),
      /Payload too large/,
    );
    assert.equal(commands.length, 0, 'nothing written');
  });

  it('stores a value that a JSON-only reader rejects instead of misreading', () => {
    const encoded = encodeGzipPayload(JSON.stringify({ a: 1 }));
    assert.throws(() => JSON.parse(encoded));
  });

  it('parseStoredSeedJson reads both encodings', () => {
    const value = { _seed: { fetchedAt: 1, recordCount: 2 }, data: { a: 1, b: 2 } };
    assert.deepEqual(parseStoredSeedJson(JSON.stringify(value)), value);
    assert.deepEqual(parseStoredSeedJson(encodeGzipPayload(JSON.stringify(value))), value);
    assert.throws(() => parseStoredSeedJson(`${GZIP_PAYLOAD_PREFIX}not-gzip`));
  });

  it('parseStoredSeedJson refuses to inflate past MAX_DECODED_PAYLOAD_BYTES', () => {
    const bomb = encodeGzipPayload(JSON.stringify('a'.repeat(MAX_DECODED_PAYLOAD_BYTES + 1)));
    assert.ok(bomb.length < MAX_PAYLOAD_BYTES, 'fits the publish cap');
    assert.throws(() => parseStoredSeedJson(bomb), { code: 'ERR_BUFFER_TOO_LARGE' });
  });

  it('shared seed readers decode a compressed canonical value', async () => {
    const value = { _seed: { fetchedAt: 1_700_000_000_000, recordCount: 2, sourceVersion: 'v' }, data: { a: 1, b: 2 } };
    storedValueFetch(encodeGzipPayload(JSON.stringify(value)));

    assert.deepEqual(await verifySeedKey('forecast:resolutions:v1'), value.data);
    assert.deepEqual(await readSeedSnapshot('forecast:resolutions:v1', { strict: true }), value.data);
    const meta = await readCanonicalEnvelopeMeta('forecast:resolutions:v1');
    assert.equal(meta.recordCount, 2);
    assert.equal(meta.fetchedAt, value._seed.fetchedAt);
  });

  it('the resolution seeder reads its own compressed ledger', async () => {
    const value = { _seed: { fetchedAt: 1, recordCount: 1 }, data: { 'k@1': { key: 'k@1', status: 'pending' } } };
    storedValueFetch(encodeGzipPayload(JSON.stringify(value)));
    assert.deepEqual(await readResolutionsJson('forecast:resolutions:v1'), value);
  });
});
