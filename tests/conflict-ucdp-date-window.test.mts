import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const conflictServiceSource = readFileSync(resolve(root, 'src/services/conflict/index.ts'), 'utf8');

let moduleCounter = 0;

function replaceRequired(source: string, search: string | RegExp, replacement: string, label: string): string {
  const patched = source.replace(search, replacement);
  assert.notEqual(patched, source, `failed to patch conflict service import: ${label}`);
  return patched;
}

async function loadUcdpDeriver() {
  let patched = replaceRequired(
    conflictServiceSource,
    "import { getRpcBaseUrl } from '@/services/rpc-client';",
    "const getRpcBaseUrl = () => '';",
    'rpc-client',
  );
  patched = replaceRequired(
    patched,
    /import \{\n[\s\S]*?\} from '@\/generated\/client\/worldmonitor\/conflict\/v1\/service_client';/,
    `class ConflictServiceClient {
  constructor(..._args: unknown[]) {}
  listAcledEvents() { return { events: [], pagination: undefined }; }
  listUcdpEvents() { return { events: [], pagination: undefined }; }
}
class ApiError extends Error {}
type AcledConflictEvent = any;
type UcdpViolenceEvent = any;
type HumanitarianCountrySummary = any;
type ListAcledEventsResponse = any;
type ListUcdpEventsResponse = any;
type GetHumanitarianSummaryResponse = any;
type GetHumanitarianSummaryBatchResponse = any;
type IranEvent = any;
type ListIranEventsResponse = any;`,
    'generated conflict client',
  );
  patched = replaceRequired(
    patched,
    "import type { UcdpGeoEvent, UcdpEventType } from '@/types';",
    'type UcdpGeoEvent = any; type UcdpEventType = any;',
    'types',
  );
  patched = replaceRequired(
    patched,
    "import { createCircuitBreaker } from '@/utils';",
    'const createCircuitBreaker = (_config: unknown) => ({ execute: async (_fn: unknown, fallback: unknown) => fallback });',
    'utils',
  );
  patched = replaceRequired(
    patched,
    "import { getHydratedData } from '@/services/bootstrap';",
    'const getHydratedData = (_key: string) => null;',
    'bootstrap',
  );
  patched = replaceRequired(
    patched,
    "import { toApiUrl } from '@/services/runtime';",
    'const toApiUrl = (path: string) => path;',
    'runtime',
  );
  patched = `${patched}\nexport { deriveUcdpClassifications };\n`;

  const transformed = transformSync(patched, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}#${++moduleCounter}`;
  return (await import(dataUrl)) as {
    deriveUcdpClassifications: (events: any[]) => Map<string, { intensity: string }>;
  };
}

function ucdpEvent(country: string, deathsBest: number, dateStart: number) {
  return {
    country,
    deathsBest,
    dateStart,
    violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  };
}

describe('frontend UCDP classification date guard', () => {
  it('ignores future and non-finite dates while preserving valid current/past rows', async () => {
    const { deriveUcdpClassifications } = await loadUcdpDeriver();
    const now = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const twoYearsMs = 2 * 365 * dayMs;
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, now + 365 * dayMs)]).get('Ukraine')?.intensity,
        'none',
        'future-dated high-death UCDP rows must not classify as war',
      );
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, Number.NaN)]).get('Ukraine')?.intensity,
        'none',
        'non-finite UCDP dates must fail closed',
      );
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, now)]).get('Ukraine')?.intensity,
        'war',
        'current UCDP rows must still classify',
      );
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, now - twoYearsMs + dayMs)]).get('Ukraine')?.intensity,
        'war',
        'past UCDP rows inside the trailing window must still classify',
      );
    } finally {
      Date.now = originalDateNow;
    }
  });
});
