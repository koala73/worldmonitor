import assert from 'node:assert/strict';
import { readFileSync as originalReadFileSync } from 'node:fs';
function readFileSync(path: any, options?: any): any {
  const content = originalReadFileSync(path, options);
  if (typeof content === 'string') {
    return content.replace(/\r\n/g, '\n');
  }
  return content;
}
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const conflictServiceSource = readFileSync(resolve(root, 'src/services/conflict/index.ts'), 'utf8');
// index.ts delegates the UCDP classifier to a leaf module with no runtime imports
// (#5300), so the seeder's drift-parity test can load it without Vite. This harness
// evaluates index.ts as ONE self-contained module, so inline the leaf back in.
const ucdpClassifySource = readFileSync(resolve(root, 'src/services/conflict/ucdp-classify.ts'), 'utf8');
// The aggregate reconciler is also a dependency-free leaf. Keep this harness
// self-contained for the same reason as the classifier above.
const ucdpDedupeHarness = `
const UCDP_PROTO_VIOLENCE_TYPES = [
  'UCDP_VIOLENCE_TYPE_STATE_BASED',
  'UCDP_VIOLENCE_TYPE_NON_STATE',
  'UCDP_VIOLENCE_TYPE_ONE_SIDED',
];
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function isDuplicatedByAcled(ucdp, acledEvents) {
  for (const acled of acledEvents) {
    const aLat = Number(acled.latitude);
    const aLon = Number(acled.longitude);
    const aDate = new Date(acled.event_date).getTime();
    const aDeaths = Number(acled.fatalities) || 0;
    if (Math.abs(ucdp.dateMs - aDate) / (1000 * 60 * 60 * 24) > 7) continue;
    if (haversineKm(ucdp.latitude, ucdp.longitude, aLat, aLon) > 50) continue;
    if (ucdp.deathsBest === 0 && aDeaths === 0) return true;
    if (ucdp.deathsBest > 0 && aDeaths > 0) {
      const ratio = ucdp.deathsBest / aDeaths;
      if (ratio >= 0.5 && ratio <= 2.0) return true;
    }
  }
  return false;
}
function deduplicateUcdpProjectionAggregates(aggregates, dedupeIndex, acledEvents) {
  if (!acledEvents.length) return aggregates;
  const reconciled = Object.fromEntries(Object.entries(aggregates).map(([type, aggregate]) => [type, { ...aggregate }]));
  for (const [typeIndex, dateMs, latitude, longitude, deathsBest] of dedupeIndex) {
    const aggregate = reconciled[UCDP_PROTO_VIOLENCE_TYPES[typeIndex]];
    if (aggregate && isDuplicatedByAcled({ latitude, longitude, dateMs, deathsBest }, acledEvents)) {
      aggregate.count = Math.max(0, aggregate.count - 1);
      aggregate.totalDeaths = Math.max(0, aggregate.totalDeaths - deathsBest);
    }
  }
  return reconciled;
}
`;

let moduleCounter = 0;

function replaceRequired(source: string, search: string | RegExp, replacement: string, label: string): string {
  const patched = source.replace(search, replacement);
  assert.notEqual(patched, source, `failed to patch conflict service import: ${label}`);
  return patched;
}

async function loadUcdpDeriver() {
  let patched = replaceRequired(
    conflictServiceSource,
    "import { getRpcBaseUrl, getRpcErrorStatusCode } from '@/services/rpc-client';",
    "const getRpcBaseUrl = () => ''; const getRpcErrorStatusCode = (_err: unknown) => undefined;",
    'rpc-client',
  );
  patched = replaceRequired(
    patched,
    /import type \{[\s\S]*?\} from '@\/generated\/client\/worldmonitor\/conflict\/v1\/service_client';/,
    `type AcledConflictEvent = any;
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
    "import { ConflictServiceClient } from '@/services/generated-rpc-clients';",
    `class ConflictServiceClient {
  constructor(..._args: unknown[]) {}
  listAcledEvents() { return { events: [], pagination: undefined }; }
  listUcdpEvents() { return { events: [], pagination: undefined }; }
  getHumanitarianSummaryBatch() { return { results: {}, fetched: 0, requested: 0 }; }
  getHumanitarianSummary() { return { summary: undefined }; }
}`,
    'lazy conflict client',
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
  patched = replaceRequired(
    patched,
    /import \{ isDuplicatedByAcled \} from '\.\/ucdp-dedupe';\nimport type \{ AcledDedupEvent, UcdpDedupeIndexEntry, UcdpTabAggregate \} from '\.\/ucdp-dedupe';\nexport \{ deduplicateUcdpProjectionAggregates \} from '\.\/ucdp-dedupe';\nexport type \{ UcdpDedupeIndexEntry, UcdpTabAggregate \} from '\.\/ucdp-dedupe';/,
    ucdpDedupeHarness,
    'ucdp-dedupe leaf',
  );
  const inlinedClassifier = ucdpClassifySource
    .replace(/^import type .*$/m, '')   // type-only import — nothing to resolve
    .replace(/^export /gm, '');          // the harness re-exports the deriver below
  patched = replaceRequired(
    patched,
    /import \{ deriveUcdpClassifications \} from '\.\/ucdp-classify';\nimport type \{ UcdpConflictStatus \} from '\.\/ucdp-classify';\nexport \{ deriveUcdpClassifications \} from '\.\/ucdp-classify';\nexport type \{ ConflictIntensity, UcdpConflictStatus \} from '\.\/ucdp-classify';/,
    inlinedClassifier,
    'ucdp-classify leaf',
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

async function loadDeriveConflictHistory() {
  const mod = (await loadUcdpDeriver()) as unknown as {
    deriveConflictHistory: (
      zone: { center: [number, number]; startDate?: string },
      events: Array<{ latitude: number; longitude: number; deaths_best?: number }>,
    ) => { conflictSince: string | null; recordedFatalities: number };
  };
  return mod.deriveConflictHistory;
}

describe('deriveConflictHistory', () => {
  it('takes CONFLICT SINCE from the static startDate year, not the UCDP trailing window', async () => {
    const deriveConflictHistory = await loadDeriveConflictHistory();
    // UCDP feed is only a ~1yr trailing slice, so a 2026 event must NOT become "since".
    const events = [{ latitude: 48.5, longitude: 31, deaths_best: 100, date_start: '2026-01-01' }];
    const result = deriveConflictHistory({ center: [31, 48.5], startDate: 'Feb 24, 2022' }, events);
    assert.equal(result.conflictSince, '2022');
    assert.equal(result.recordedFatalities, 100);
  });

  it('returns null conflictSince when the zone has no startDate', async () => {
    const deriveConflictHistory = await loadDeriveConflictHistory();
    const result = deriveConflictHistory({ center: [31, 48.5] }, []);
    assert.equal(result.conflictSince, null);
    assert.equal(result.recordedFatalities, 0);
  });

  it('applies a cos(latitude) correction so the radius is isotropic in real distance', async () => {
    const deriveConflictHistory = await loadDeriveConflictHistory();
    // At 60°N, cos(lat)=0.5: an event 4° east is ~2° in real distance (inside the
    // 3° radius) and MUST be counted. A raw degree filter would wrongly exclude it.
    const events = [{ latitude: 60, longitude: 4, deaths_best: 50, date_start: '2024-01-01' }];
    const result = deriveConflictHistory({ center: [0, 60], startDate: 'Jan 1, 2020' }, events);
    assert.equal(result.recordedFatalities, 50);
  });
});
