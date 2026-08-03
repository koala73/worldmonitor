import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';

const root = resolve(import.meta.dirname, '..');
const serviceSource = readFileSync(resolve(root, 'src/services/wingbits.ts'), 'utf8');
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

  it('keeps the client cap at or below the bound the generated validator enforces', () => {
    const maxItems = GENERATED_MESSAGE_RULES[
      'worldmonitor.military.v1.GetAircraftDetailsBatchRequest'
    ]?.fields?.icao24s?.repeatedMaxItems;

    assert.equal(typeof maxItems, 'number', 'generated rules must still declare icao24s.repeatedMaxItems');

    const capMatch = serviceSource.match(/const MAX_AIRCRAFT_DETAILS_BATCH = (\d+);/);
    assert.ok(capMatch, 'MAX_AIRCRAFT_DETAILS_BATCH must stay a literal the drift guard can read');
    const cap = Number(capMatch[1]);

    assert.ok(
      cap <= (maxItems as number),
      `MAX_AIRCRAFT_DETAILS_BATCH (${cap}) exceeds the validator's max_items (${maxItems}); the browser would emit requests the RPC validator rejects with HTTP 400`,
    );
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
