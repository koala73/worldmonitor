import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import {
  assembleBootstrapTierPayload,
  buildBootstrapPayloadByteLedger,
  publishBootstrapTier,
  runPublisherLoop,
} from '../scripts/publish-bootstrap-tiers.mjs';

const execFileAsync = promisify(execFile);
const TEST_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token',
};

function pipelineResponse(results, status = 200) {
  return new Response(JSON.stringify(results), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function raw(value) {
  return { result: JSON.stringify(value) };
}

describe('bootstrap tier payload assembly', () => {
  it('measures the exact public payload and ordered key entries in UTF-8 bytes', () => {
    const payload = {
      data: {
        first: { label: 'é' },
        second: ['🌍'],
      },
      missing: ['missingValue'],
    };

    const ledger = buildBootstrapPayloadByteLedger(payload);

    assert.equal(ledger.totalBytes, Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    assert.deepEqual(ledger.keys.map(({ key }) => key), ['first', 'second']);
    assert.deepEqual(
      ledger.keys.map(({ key, bytes, valueBytes }) => ({ key, bytes, valueBytes })),
      Object.entries(payload.data).map(([key, value]) => ({
        key,
        bytes: Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)}`, 'utf8'),
        valueBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
      })),
    );
  });

  it('preserves ordered names, envelope stripping, missing values, and public transforms', async () => {
    const registry = {
      forecasts: 'forecast:key',
      wildfires: 'wildfire:key',
      xFeed: 'x-feed:key',
      missingValue: 'missing:key',
      malformedValue: 'malformed:key',
      negativeValue: 'negative:key',
    };
    const detections = Array.from({ length: 501 }, (_, index) => ({
      brightness: index,
      detectedAt: index,
    }));
    const fetchFn = async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), Object.values(registry).map(key => ['GET', key]));
      return pipelineResponse([
        raw({ _seed: { fetchedAt: 1 }, data: { value: 1, enrichmentMeta: { secret: true } } }),
        raw({ fireDetections: detections }),
        raw({
          count: 2,
          items: [{ id: '1', text: 'R4_POST_BODY_MUST_NOT_BE_PUBLISHED', permalink: 'https://x.com/a/status/1' }],
          pollState: { cursorByAccountId: { '1': '9' } },
        }),
        { result: null },
        { result: '{not json' },
        raw('__WM_NEG__'),
      ]);
    };

    const payload = await assembleBootstrapTierPayload(registry, { env: TEST_ENV, fetchFn });

    assert.deepEqual(Object.keys(payload.data), ['forecasts', 'wildfires', 'xFeed']);
    assert.deepEqual(payload.data.forecasts, { value: 1 });
    assert.equal(payload.data.wildfires.fireDetections.length, 500);
    // R4 (#6654): seed-internal cursor state AND the post body are stripped;
    // the permalink survives. xFeed is not a registered bootstrap key, so this
    // exercises the regression guard that keeps bodies out if it is re-added.
    assert.deepEqual(payload.data.xFeed, {
      count: 2,
      items: [{ id: '1', permalink: 'https://x.com/a/status/1' }],
    });
    assert.doesNotMatch(JSON.stringify(payload), /R4_POST_BODY_MUST_NOT_BE_PUBLISHED/);
    assert.deepEqual(payload.missing, ['missingValue', 'malformedValue', 'negativeValue']);

    const ledger = buildBootstrapPayloadByteLedger(payload);
    assert.deepEqual(ledger.keys.map(({ key }) => key), ['forecasts', 'wildfires', 'xFeed']);
    assert.equal(ledger.keys.some(({ key }) => payload.missing.includes(key)), false);
  });

  for (const [name, fetchFn] of [
    ['transport failure', async () => { throw new Error('network down'); }],
    ['wrong result count', async () => pipelineResponse([])],
    ['command error', async () => pipelineResponse([{ result: null, error: 'boom' }])],
  ]) {
    it(`rejects the whole assembly on ${name}`, async () => {
      await assert.rejects(
        assembleBootstrapTierPayload({ example: 'example:key' }, { env: TEST_ENV, fetchFn }),
        /pipeline|network down/i,
      );
    });
  }
});

describe('publishBootstrapTier', () => {
  it('writes one fresh tier envelope to the exact object key', async () => {
    const writes = [];
    const result = await publishBootstrapTier('fast', {
      env: TEST_ENV,
      now: () => 1_721_000_000_000,
      resolveRegistry: () => ({ fast: { example: 'example:key' } }),
      fetchFn: async () => pipelineResponse([raw({ answer: 42 })]),
      resolveStorage: () => ({ mode: 's3' }),
      putObject: async (...args) => { writes.push(args); return { bytes: 10 }; },
    });

    assert.equal(result.tier, 'fast');
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], 'fast.json');
    assert.deepEqual(writes[0][2], {
      generatedAt: 1_721_000_000_000,
      tier: 'fast',
      payload: { data: { example: { answer: 42 } }, missing: [] },
    });
    assert.equal(
      result.payloadBytes,
      Buffer.byteLength(JSON.stringify({ data: { example: { answer: 42 } }, missing: [] }), 'utf8'),
    );
    assert.deepEqual(result.largestKeys, [{ key: 'example', bytes: 23 }]);
  });

  it('returns only the five largest key-size fields without payload values', async () => {
    const registry = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => [key, `${key}:redis`]),
    );
    const values = ['x', 'xx', 'xxx', 'xxxx', 'xxxxx', 'xxxxxx'];
    const result = await publishBootstrapTier('fast', {
      env: TEST_ENV,
      resolveRegistry: () => ({ fast: registry }),
      fetchFn: async () => pipelineResponse(values.map(raw)),
      resolveStorage: () => ({ mode: 's3' }),
      putObject: async () => ({ bytes: 100 }),
    });

    assert.equal(result.largestKeys.length, 5);
    assert.deepEqual(result.largestKeys.map(({ key }) => key), ['f', 'e', 'd', 'c', 'b']);
    assert.equal(JSON.stringify(result.largestKeys).includes('xxxxxx'), false);
  });

  it('performs no PUT when Redis assembly fails', async () => {
    let puts = 0;
    await assert.rejects(publishBootstrapTier('slow', {
      env: TEST_ENV,
      resolveRegistry: () => ({ slow: { example: 'example:key' } }),
      fetchFn: async () => pipelineResponse([], 503),
      resolveStorage: () => ({ mode: 's3' }),
      putObject: async () => { puts += 1; },
    }), /pipeline/i);
    assert.equal(puts, 0);
  });

  it('rejects an unknown tier before reading or writing', async () => {
    await assert.rejects(publishBootstrapTier('medium', {}), /unknown tier/i);
  });

  it('fails closed when the shared tier-shape flag is not explicit', async () => {
    await assert.rejects(
      publishBootstrapTier('fast', { env: TEST_ENV }),
      /requires explicit IRAN_EVENTS_ENABLED=true\|false/,
    );
  });
});

describe('runPublisherLoop', () => {
  it('starts both tiers serially and keeps deadlines anchored after slow and failed cycles', async () => {
    let nowMs = 0;
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const publishTier = async tier => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push([tier, nowMs]);
      nowMs += tier === 'fast' ? 30_000 : 90_000;
      active -= 1;
      if (calls.length === 3) throw new Error('transient');
    };
    const sleep = async ms => { nowMs += ms; };

    await runPublisherLoop({
      publishTier,
      now: () => nowMs,
      sleep,
      maxPublishes: 6,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(calls.map(([tier]) => tier), ['fast', 'slow', 'fast', 'fast', 'fast', 'fast']);
    assert.deepEqual(calls.map(([, at]) => at), [0, 30_000, 120_000, 240_000, 360_000, 480_000]);
  });

  it('does not begin another publish after shutdown is requested', async () => {
    const controller = new AbortController();
    const calls = [];
    await runPublisherLoop({
      signal: controller.signal,
      publishTier: async tier => {
        calls.push(tier);
        controller.abort();
      },
      now: () => 0,
      sleep: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.deepEqual(calls, ['fast']);
  });
});

describe('publisher deployment boundaries', () => {
  it('imports the canonical shared registry without crossing into api, src, or server', async () => {
    const source = await readFile(new URL('../scripts/publish-bootstrap-tiers.mjs', import.meta.url), 'utf8');
    assert.match(source, /from '\.\.\/shared\/bootstrap-tier-keys\.js'/);
    assert.doesNotMatch(source, /from ['"]\.\.\/(?:api|src|server)\//);
  });

  it('exits nonzero for an unknown one-shot tier before touching infrastructure', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/publish-bootstrap-tiers.mjs', '--tier=medium'], {
        cwd: new URL('..', import.meta.url),
      }),
      error => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /unknown tier/i);
        return true;
      },
    );
  });
});
