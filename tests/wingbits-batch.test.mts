import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

import { AIRCRAFT_DETAILS_BATCH_LIMIT } from '../server/_shared/aircraft-details-batch.ts';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';

const root = resolve(import.meta.dirname, '..');
const serviceSource = readFileSync(resolve(root, 'src/services/wingbits.ts'), 'utf8');
const handlerSource = readFileSync(
  resolve(root, 'server/worldmonitor/military/v1/get-aircraft-details-batch.ts'),
  'utf8',
);
let moduleCounter = 0;

function replaceRequired(source: string, search: string | RegExp, replacement: string, label: string): string {
  const patched = source.replace(search, replacement);
  assert.notEqual(patched, source, `failed to patch Wingbits service import: ${label}`);
  return patched;
}

async function loadWingbits(capture: (request: { icao24s: string[] }) => unknown) {
  const hookName = `__wmWingbitsBatchTest${++moduleCounter}`;
  (globalThis as Record<string, unknown>)[hookName] = capture;

  let patched = replaceRequired(
    serviceSource,
    "import { createCircuitBreaker, toUniqueSortedLowercase } from '@/utils';",
    `const createCircuitBreaker = () => ({ execute: async () => null });
    const toUniqueSortedLowercase = (values: string[]) => [...new Set(values.map((value) => value.toLowerCase()))].sort();`,
    'utilities',
  );
  // Inject the real shared bound, not a hand-written copy: a data: URL module
  // cannot resolve relative imports, but substituting the value the test read
  // from server/_shared keeps the module under test bound to the real constant.
  patched = replaceRequired(
    patched,
    "import { AIRCRAFT_DETAILS_BATCH_LIMIT } from '../../server/_shared/aircraft-details-batch';",
    `const AIRCRAFT_DETAILS_BATCH_LIMIT = ${AIRCRAFT_DETAILS_BATCH_LIMIT};`,
    'shared batch limit',
  );
  patched = replaceRequired(
    patched,
    "import { getRpcBaseUrl } from '@/services/rpc-client';",
    'const getRpcBaseUrl = () => "";',
    'RPC base URL',
  );
  patched = replaceRequired(
    patched,
    "import { dataFreshness } from './data-freshness';",
    `const dataFreshness = {
      setEnabled() {},
      recordUpdate() {},
      recordError() {},
    };`,
    'data freshness',
  );
  patched = replaceRequired(
    patched,
    "import { isFeatureAvailable } from './runtime-config';",
    'const isFeatureAvailable = () => true;',
    'runtime config',
  );
  patched = replaceRequired(
    patched,
    "import { MilitaryServiceClient } from '@/services/generated-rpc-clients';",
    `class MilitaryServiceClient {
      constructor(..._args: unknown[]) {}
      getAircraftDetailsBatch(req: { icao24s: string[] }) {
        const override = (globalThis as Record<string, unknown>)[${JSON.stringify(hookName)}](req);
        return Promise.resolve(override ?? { results: {}, fetched: 0, requested: req.icao24s.length, configured: true });
      }
    }`,
    'military RPC client',
  );

  const transformed = transformSync(patched, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${moduleCounter}`;

  try {
    const module = await import(dataUrl) as {
      getAircraftDetailsBatch(icao24List: string[]): Promise<Map<string, unknown>>;
      getWingbitsStatus(): { configured: boolean | null; cacheSize: number };
    };
    return {
      module,
      cleanup() {
        delete (globalThis as Record<string, unknown>)[hookName];
      },
    };
  } catch (error) {
    delete (globalThis as Record<string, unknown>)[hookName];
    throw error;
  }
}

describe('Wingbits aircraft-details batching', () => {
  it('caps unresolved keys before the generated RPC validator can reject the request', async () => {
    const calls: Array<{ icao24s: string[] }> = [];
    // Never assert inside this callback: the stub invokes it synchronously from
    // within getAircraftDetailsBatch's own try/catch, which swallows anything
    // thrown here into a console.warn. Record the verdict and assert after the
    // await, where a failure can actually fail the test.
    const verdicts: Array<ReturnType<typeof validateGeneratedRequest>> = [];
    const { module, cleanup } = await loadWingbits((request) => {
      calls.push(request);
      verdicts.push(validateGeneratedRequest('getAircraftDetailsBatch', request));
      return undefined;
    });

    try {
      const input = Array.from({ length: 25 }, (_, index) => (0xabc000 + index).toString(16).toUpperCase());
      const result = await module.getAircraftDetailsBatch(input);

      assert.equal(result.size, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.icao24s.length, 10);
      assert.deepEqual(
        calls[0]?.icao24s,
        input.map((value) => value.toLowerCase()).sort().slice(0, 10),
      );
      assert.deepEqual(
        verdicts,
        [undefined],
        'the browser must never generate an invalid aircraft-details batch',
      );
    } finally {
      cleanup();
    }
  });

  it('keeps the shared batch bound at or below what the generated validator enforces', () => {
    const maxItems = GENERATED_MESSAGE_RULES[
      'worldmonitor.military.v1.GetAircraftDetailsBatchRequest'
    ]?.fields?.icao24s?.repeatedMaxItems;

    assert.equal(typeof maxItems, 'number', 'generated rules must still declare icao24s.repeatedMaxItems');
    assert.ok(
      AIRCRAFT_DETAILS_BATCH_LIMIT <= (maxItems as number),
      `AIRCRAFT_DETAILS_BATCH_LIMIT (${AIRCRAFT_DETAILS_BATCH_LIMIT}) exceeds the validator's max_items (${maxItems}); the browser would emit requests the RPC validator rejects with HTTP 400`,
    );
  });

  it('derives both the client cap and the server work bound from the one shared constant', () => {
    // A literal on either side is how these drifted apart in the first place.
    assert.match(
      serviceSource,
      /const MAX_AIRCRAFT_DETAILS_BATCH = AIRCRAFT_DETAILS_BATCH_LIMIT;/,
      'the browser cap must derive from the shared bound, not a copied literal',
    );
    assert.match(
      serviceSource,
      /import \{ AIRCRAFT_DETAILS_BATCH_LIMIT \} from '\.\.\/\.\.\/server\/_shared\/aircraft-details-batch';/,
      'the browser must import the shared bound',
    );
    assert.match(
      handlerSource,
      /toUniqueSortedLimited\(normalized, AIRCRAFT_DETAILS_BATCH_LIMIT\)/,
      'the handler work bound must derive from the shared constant, not a copied literal',
    );
  });

  it('rotates to unattempted keys on the next refresh even when nothing got cached', async () => {
    // The starvation case: the RPC fails, so no key is positively or negatively
    // cached and `toFetch` is identical on the next refresh. Without a rotation
    // cursor the same lexicographic head is retried forever and every key past
    // the first batch is stranded. Failing (rather than succeeding) is what
    // isolates rotation from the ordinary cache-advances-the-queue path.
    const calls: Array<{ icao24s: string[] }> = [];
    const { module, cleanup } = await loadWingbits((request) => {
      calls.push(request);
      throw new Error('upstream down');
    });

    try {
      const input = Array.from({ length: 25 }, (_, index) => (0xabc000 + index).toString(16).toUpperCase());
      const sorted = input.map((value) => value.toLowerCase()).sort();

      await module.getAircraftDetailsBatch(input);
      await module.getAircraftDetailsBatch(input);
      await module.getAircraftDetailsBatch(input);

      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0]?.icao24s, sorted.slice(0, 10));
      assert.deepEqual(calls[1]?.icao24s, sorted.slice(10, 20), 'second refresh must advance past the first batch');
      // 5 remaining, then wrap to the head of the ring.
      assert.deepEqual(calls[2]?.icao24s, [...sorted.slice(20, 25), ...sorted.slice(0, 5)].sort());

      const attempted = new Set(calls.flatMap((call) => call.icao24s));
      assert.equal(attempted.size, 25, 'every key must be attempted within one sweep of the ring');
    } finally {
      cleanup();
    }
  });

  it('only negative-caches the keys it actually sent when the response omits a requested count', async () => {
    const calls: Array<{ icao24s: string[] }> = [];
    // No `requested` field: exercises the Number.isFinite fallback, the one path
    // where basing the negative-cache slice on batchKeys rather than toFetch
    // changes behaviour. Without it, the 15 keys never sent would be poisoned
    // with negative entries for a full LOCAL_CACHE_TTL.
    const { module, cleanup } = await loadWingbits((request) => {
      calls.push(request);
      return { results: {}, fetched: 0, configured: true };
    });

    try {
      const input = Array.from({ length: 25 }, (_, index) => (0xabc000 + index).toString(16).toUpperCase());
      await module.getAircraftDetailsBatch(input);

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.icao24s.length, 10);
      assert.equal(
        module.getWingbitsStatus().cacheSize,
        10,
        'negative entries must cover only the keys actually sent, not the truncated tail',
      );
    } finally {
      cleanup();
    }
  });
});
