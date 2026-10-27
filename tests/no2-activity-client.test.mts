// The browser reads the NO2 activity route into one closed per-region state
// (strengthening, weakening, unchanged, pending, excluded) at the client
// boundary, so the map fill, the legend, the tooltip and the country brief line
// branch on that state rather than on direction and exclusion separately.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GetNo2ActivityResponse, No2ActivityRegion } from '../src/generated/client/worldmonitor/economic/v1/service_client.ts';
import { EconomicServiceClient } from '../src/generated/client/worldmonitor/economic/v1/service_client.ts';
import { COUNTRY_READERS } from '../shared/country-brief-host.ts';
import {
  countryNo2Activity,
  fetchNo2Activity,
  no2ActivityState,
  projectNo2ActivitySnapshot,
  type No2ActivityRegionView,
} from '../src/services/economic/no2-activity.ts';
import {
  NO2_ACTIVITY_COLORS,
  NO2_ACTIVITY_LEGEND,
  NO2_ACTIVITY_STATE_LABELS,
  formatNo2Change,
  no2ActivityFill,
  no2ActivityTooltip,
} from '../src/components/map/no2-activity-style.ts';

const ATTRIBUTION = 'Contains modified Copernicus Sentinel data 2023-2026';

function region(overrides: Partial<No2ActivityRegion> = {}): No2ActivityRegion {
  return {
    id: 'country-de',
    kind: 'NO2_REGION_KIND_COUNTRY',
    label: 'Germany',
    countryCode: 'DE',
    bbox: [5.87, 47.27, 15.04, 55.06],
    current: { windowStart: '2026-08-29', windowEnd: '2026-10-23', validDays: 31, meanNo2MolM2: 1.2e-4 },
    baselineYears: [2025, 2024, 2023],
    baselineMeanNo2MolM2: 1.1e-4,
    changePercent: 12.4,
    direction: 'NO2_DIRECTION_STRENGTHENING',
    exclusion: 'NO2_REGION_EXCLUSION_UNSPECIFIED',
    ...overrides,
  };
}

function wire(overrides: Partial<GetNo2ActivityResponse> = {}): GetNo2ActivityResponse {
  return {
    regions: [
      region(),
      region({ id: 'ruhr-rhine', kind: 'NO2_REGION_KIND_CLUSTER', label: 'Ruhr-Rhine', changePercent: -15, direction: 'NO2_DIRECTION_WEAKENING' }),
      region({ id: 'country-fr', label: 'France', countryCode: 'FR', baselineYears: [], changePercent: undefined, direction: 'NO2_DIRECTION_UNSPECIFIED', exclusion: 'NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING', current: { windowStart: '2026-08-29', windowEnd: '2026-10-23', validDays: 28 } }),
      region({ id: 'country-gb', label: 'United Kingdom', countryCode: 'GB', changePercent: undefined, direction: 'NO2_DIRECTION_UNSPECIFIED', exclusion: 'NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS', current: { windowStart: '2026-08-29', windowEnd: '2026-10-23', validDays: 6 } }),
      region({ id: 'gulf-states', kind: 'NO2_REGION_KIND_CLUSTER', label: 'Gulf states', countryCode: '', changePercent: 3, direction: 'NO2_DIRECTION_UNCHANGED' }),
    ],
    generatedAt: '2026-10-26T06:10:00.000Z',
    stale: false,
    methodVersion: 'no2-activity/v1',
    attribution: ATTRIBUTION,
    unavailableReason: 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED',
    upstreamUnavailable: false,
    ...overrides,
  };
}

describe('no2ActivityState', () => {
  it('maps every direction and exclusion onto one closed state', () => {
    assert.equal(no2ActivityState('NO2_DIRECTION_STRENGTHENING', 'NO2_REGION_EXCLUSION_UNSPECIFIED'), 'strengthening');
    assert.equal(no2ActivityState('NO2_DIRECTION_WEAKENING', 'NO2_REGION_EXCLUSION_UNSPECIFIED'), 'weakening');
    assert.equal(no2ActivityState('NO2_DIRECTION_UNCHANGED', 'NO2_REGION_EXCLUSION_UNSPECIFIED'), 'unchanged');
    assert.equal(no2ActivityState('NO2_DIRECTION_UNSPECIFIED', 'NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING'), 'pending');
    for (const exclusion of ['NO2_REGION_EXCLUSION_REQUEST_FAILED', 'NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS', 'NO2_REGION_EXCLUSION_INSUFFICIENT_BASELINE_YEARS'] as const) {
      assert.equal(no2ActivityState('NO2_DIRECTION_UNSPECIFIED', exclusion), 'excluded', exclusion);
    }
    assert.equal(no2ActivityState('NO2_DIRECTION_UNSPECIFIED', 'NO2_REGION_EXCLUSION_UNSPECIFIED'), 'excluded', 'no direction and no exclusion is not a reading');
  });
});

describe('projectNo2ActivitySnapshot', () => {
  it('keeps the credit, freshness and every region with its state', () => {
    const snapshot = projectNo2ActivitySnapshot(wire());
    assert.ok(snapshot);
    assert.equal(snapshot.attribution, ATTRIBUTION);
    assert.equal(snapshot.generatedAt, '2026-10-26T06:10:00.000Z');
    assert.equal(snapshot.stale, false);
    assert.deepEqual(snapshot.regions.map((r) => [r.id, r.state, r.changePercent, r.exclusion]), [
      ['country-de', 'strengthening', 12.4, null],
      ['ruhr-rhine', 'weakening', -15, null],
      ['country-fr', 'pending', null, 'baseline_backfill_pending'],
      ['country-gb', 'excluded', null, 'insufficient_valid_days'],
      ['gulf-states', 'unchanged', 3, null],
    ]);
    const germany = snapshot.regions[0]!;
    assert.deepEqual(germany, {
      id: 'country-de', kind: 'country', label: 'Germany', countryCode: 'DE', bbox: [5.87, 47.27, 15.04, 55.06],
      state: 'strengthening', changePercent: 12.4, windowStart: '2026-08-29', windowEnd: '2026-10-23', validDays: 31,
      baselineYears: [2025, 2024, 2023], exclusion: null,
    });
    assert.equal(snapshot.regions[4]!.countryCode, null);
  });

  it('returns null on a fault and an empty snapshot when the filter is not covered', () => {
    assert.equal(projectNo2ActivitySnapshot(wire({ regions: [], attribution: '', unavailableReason: 'NO2_ACTIVITY_UNAVAILABLE_REASON_SEED_MISSING', upstreamUnavailable: true })), null);
    const notCovered = projectNo2ActivitySnapshot(wire({ regions: [], attribution: '', generatedAt: '', unavailableReason: 'NO2_ACTIVITY_UNAVAILABLE_REASON_NOT_COVERED' }));
    assert.deepEqual(notCovered, { generatedAt: '', stale: false, attribution: '', regions: [] });
  });

  it('drops a malformed region rather than painting it', () => {
    const snapshot = projectNo2ActivitySnapshot(wire({ regions: [region({ bbox: [1, 2] }), region({ id: 'ok' })] }));
    assert.deepEqual(snapshot?.regions.map((r) => r.id), ['ok']);
  });
});

describe('countryNo2Activity', () => {
  it('picks the country region, never a cluster inside it', () => {
    const snapshot = projectNo2ActivitySnapshot(wire())!;
    assert.equal(countryNo2Activity(snapshot, 'de')?.id, 'country-de');
    assert.equal(countryNo2Activity(snapshot, 'FR')?.state, 'pending');
    assert.equal(countryNo2Activity(snapshot, 'US'), null);
  });
});

describe('fetchNo2Activity', () => {
  it('projects the client response and reports a fault as null', async () => {
    const calls: unknown[] = [];
    const served = await fetchNo2Activity({ countryCode: 'DE', kind: 'NO2_REGION_KIND_COUNTRY' }, {
      getNo2Activity: async (req) => { calls.push(req); return wire({ regions: [region()] }); },
    });
    assert.deepEqual(calls, [{ countryCode: 'DE', regionId: '', kind: 'NO2_REGION_KIND_COUNTRY' }]);
    assert.equal(served?.regions[0]?.state, 'strengthening');
    const failed = await fetchNo2Activity({}, { getNo2Activity: async () => { throw new Error('network down'); } });
    assert.equal(failed, null);
  });
});

describe('no2-activity-style', () => {
  const states = ['strengthening', 'weakening', 'unchanged', 'pending', 'excluded'] as const;

  it('gives every state its own colour, label and legend entry', () => {
    assert.equal(new Set(states.map((s) => NO2_ACTIVITY_COLORS[s].join(','))).size, states.length);
    for (const state of states) assert.ok(NO2_ACTIVITY_STATE_LABELS[state].length > 0, state);
    assert.deepEqual(NO2_ACTIVITY_LEGEND.map((entry) => entry.state), states);
    assert.deepEqual(no2ActivityFill('pending', 120), [...NO2_ACTIVITY_COLORS.pending, 120]);
  });

  it('formats the change with its sign and one decimal', () => {
    assert.equal(formatNo2Change(12.44), '+12.4%');
    assert.equal(formatNo2Change(-15), '-15.0%');
    assert.equal(formatNo2Change(0), '0.0%');
    assert.equal(formatNo2Change(null), '');
  });

  it('writes a card with change, window, valid days, the exclusion and the credit, escaping every field', () => {
    const text = (value: unknown) => String(value).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c));
    const snapshot = projectNo2ActivitySnapshot(wire())!;
    const germany = no2ActivityTooltip(snapshot.regions[0]!, ATTRIBUTION, text);
    assert.match(germany, /Germany/);
    assert.match(germany, /\+12\.4%/);
    assert.match(germany, /2026-08-29/);
    assert.match(germany, /2026-10-23/);
    assert.match(germany, /31 valid days/);
    assert.match(germany, /Contains modified Copernicus Sentinel data 2023-2026/);
    const pending = no2ActivityTooltip(snapshot.regions[2]!, ATTRIBUTION, text);
    assert.match(pending, /Baseline backfill pending/);
    assert.doesNotMatch(pending, /%/);
    const cloudy = no2ActivityTooltip(snapshot.regions[3]!, ATTRIBUTION, text);
    assert.match(cloudy, /Insufficient valid days/);
    assert.match(cloudy, /6 valid days/);
    const hostile: No2ActivityRegionView = { ...snapshot.regions[0]!, label: '<img src=x onerror=alert(1)>' };
    assert.doesNotMatch(no2ActivityTooltip(hostile, '<b>credit</b>', text), /<img|<b>/);
  });
});

describe('host-mode country brief reader', () => {
  it('accepts the exact request the country brief sends for the NO2 line', async () => {
    let requested = '';
    const client = new EconomicServiceClient('https://www.worldmonitor.app', {
      fetch: (async (input: RequestInfo | URL) => { requested = String(input); throw new Error('captured'); }) as typeof fetch,
    });
    await client.getNo2Activity({ countryCode: 'DE', regionId: '', kind: 'NO2_REGION_KIND_COUNTRY' }).catch(() => {});
    const url = new URL(requested);
    const reader = Object.values(COUNTRY_READERS).find((entry) => entry.path === url.pathname && entry.args.safeParse(Object.fromEntries(url.searchParams)).success);
    assert.ok(reader, `no host reader accepts ${url.pathname}${url.search}`);
  });
});
