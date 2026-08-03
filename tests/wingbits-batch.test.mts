import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

import { validateGeneratedRequest } from '../server/request-validator.ts';

const root = resolve(import.meta.dirname, '..');
const serviceSource = readFileSync(resolve(root, 'src/services/wingbits.ts'), 'utf8');
let moduleCounter = 0;

function replaceRequired(source: string, search: string | RegExp, replacement: string, label: string): string {
  const patched = source.replace(search, replacement);
  assert.notEqual(patched, source, `failed to patch Wingbits service import: ${label}`);
  return patched;
}

async function loadWingbits(capture: (request: { icao24s: string[] }) => void) {
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
        (globalThis as Record<string, unknown>)[${JSON.stringify(hookName)}](req);
        return Promise.resolve({ results: {}, fetched: 0, requested: req.icao24s.length, configured: true });
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
    const { module, cleanup } = await loadWingbits((request) => {
      calls.push(request);
      assert.equal(
        validateGeneratedRequest('getAircraftDetailsBatch', request),
        undefined,
        'the browser must never generate an invalid aircraft-details batch',
      );
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
    } finally {
      cleanup();
    }
  });
});
