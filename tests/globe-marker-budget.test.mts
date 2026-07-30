/**
 * #5368 — the globe's HTML marker ceiling.
 *
 * These call the REAL `selectGlobeMarkers` (the function GlobeMap.flushMarkersImmediate
 * uses), and the headline cases feed it the marker counts a production census
 * actually measured on 2026-07-18 rather than counts invented here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBE_MARKER_BUDGET_DESKTOP,
  GLOBE_MARKER_BUDGET_MOBILE,
  proximityRank,
  selectGlobeMarkers,
  type GlobeMarkerGroup,
} from '../src/utils/globe-marker-budget.ts';

/**
 * Marker counts measured on www.worldmonitor.app/dashboard in globe mode,
 * 2026-07-18. The DOM total at the moment of the census was 2,319; these
 * per-feed figures sum to 2,318 because the AIS vessel feed was still arriving
 * over its websocket while the layers were being counted. Treated as a band,
 * not a fixed point — the live feeds move.
 */
const PROD_DESKTOP_CENSUS: Record<string, number> = {
  hotspots: 29,
  conflicts: 10,
  bases: 225,
  nuclear: 250,
  'military:flights': 32,
  'military:vessels': 1526,
  'military:clusters': 11,
  weather: 11,
  'natural:events': 8,
  'natural:earthquakes': 123,
  economic: 41,
  waterways: 13,
  'outages:outages': 9,
  'outages:traffic': 8,
  news: 22,
};

/** Same session with the Armed Conflict Events layer opted in. */
const PROD_UCDP_COUNT = 2000;

/**
 * Mobile first-load defaults (MOBILE_DEFAULT_MAP_LAYERS): 122 HTML markers total,
 * measured on an iPhone 14 Pro viewport against production. Per-feed figures are
 * the measured ones above (the same feeds); `natural` carries the measured
 * remainder, since that layer's split was not separately counted on mobile.
 */
const PROD_MOBILE_TOTAL = 122;
const PROD_MOBILE_CENSUS: Record<string, number> = {
  hotspots: 29,
  conflicts: 10,
  weather: 11,
  'outages:outages': 9,
  'outages:traffic': 8,
  news: 22,
  natural: 33,
};

interface Dot { id: string; severity: number; }

function group(layer: string, count: number, opts: Partial<GlobeMarkerGroup<Dot>> = {}): GlobeMarkerGroup<Dot> {
  return {
    layer: layer.split(':')[0],
    markers: Array.from({ length: count }, (_, i) => ({ id: `${layer}-${i}`, severity: i })),
    ...opts,
  };
}

const censusGroups = (census: Record<string, number>): GlobeMarkerGroup<Dot>[] =>
  Object.entries(census).map(([layer, count]) => group(layer, count));

const total = (census: Record<string, number>): number =>
  Object.values(census).reduce((a, b) => a + b, 0);

describe('selectGlobeMarkers — production census (#5368)', () => {
  it('cuts the real 2,319-marker desktop default view under the desktop budget', () => {
    const measured = total(PROD_DESKTOP_CENSUS);
    assert.ok(measured >= 2300 && measured <= 2350, `census drifted out of the measured band: ${measured}`);

    const { markers, truncated } = selectGlobeMarkers(
      censusGroups(PROD_DESKTOP_CENSUS),
      GLOBE_MARKER_BUDGET_DESKTOP,
    );

    assert.ok(
      markers.length <= GLOBE_MARKER_BUDGET_DESKTOP.total,
      `rendered ${markers.length} markers, budget is ${GLOBE_MARKER_BUDGET_DESKTOP.total}`,
    );
    assert.ok(markers.length < 2319, 'the budget must actually bite on the production payload');
    assert.ok(truncated.military, 'the 1,526-marker vessel feed must be reported as truncated');
  });

  it('trims the biggest feed rather than starving small layers', () => {
    const { markers } = selectGlobeMarkers(
      censusGroups(PROD_DESKTOP_CENSUS),
      GLOBE_MARKER_BUDGET_DESKTOP,
    );
    const kept = (prefix: string): number => markers.filter(m => m.id.startsWith(prefix)).length;

    // Every layer smaller than the fair-share cap survives whole, even though
    // one feed on its own is larger than the entire budget.
    assert.equal(kept('weather'), 11);
    assert.equal(kept('conflicts'), 10);
    assert.equal(kept('waterways'), 13);
    assert.equal(kept('news'), 22);
    assert.ok(kept('military:vessels') < 1526, 'the vessel feed is the one that must give way');
  });

  it('bounds the opt-in Armed Conflict Events view (4,319 markers on production)', () => {
    const groups = [...censusGroups(PROD_DESKTOP_CENSUS), group('ucdpEvents', PROD_UCDP_COUNT)];
    const measured = groups.reduce((n, g) => n + g.markers.length, 0);
    assert.ok(measured >= 4300 && measured <= 4350, `census drifted out of the measured band: ${measured}`);

    const { markers, truncated } = selectGlobeMarkers(groups, GLOBE_MARKER_BUDGET_DESKTOP);

    assert.ok(markers.length <= GLOBE_MARKER_BUDGET_DESKTOP.total);
    assert.equal(truncated.ucdpEvents.total, 2000);
    assert.ok(truncated.ucdpEvents.shown < 2000);
  });

  it('leaves the real mobile default view untouched — it is already small', () => {
    assert.equal(total(PROD_MOBILE_CENSUS), PROD_MOBILE_TOTAL, 'census drifted from the measured mobile total');

    const { markers, truncated } = selectGlobeMarkers(
      censusGroups(PROD_MOBILE_CENSUS),
      GLOBE_MARKER_BUDGET_MOBILE,
    );

    assert.equal(markers.length, PROD_MOBILE_TOTAL, 'the mobile default view must not lose markers');
    assert.deepEqual(truncated, {}, 'nothing should be reported as truncated');
  });

  it('bites on mobile only once a heavy layer is stacked on', () => {
    const groups = [...censusGroups(PROD_MOBILE_CENSUS), group('military:vessels', 1526)];
    const { markers, truncated } = selectGlobeMarkers(groups, GLOBE_MARKER_BUDGET_MOBILE);

    assert.ok(markers.length <= GLOBE_MARKER_BUDGET_MOBILE.total);
    assert.ok(truncated.military.total === 1526);
  });
});

describe('selectGlobeMarkers — invariants', () => {
  const budget = { perLayer: 50, total: 120 };

  it('never exceeds either ceiling, for any group shape', () => {
    const shapes: number[][] = [
      [1000], [1000, 1000, 1000], [5, 5, 5], [200, 3, 3, 3], [49, 51, 50, 2], [0, 0, 1000], [],
    ];
    for (const shape of shapes) {
      const groups = shape.map((n, i) => group(`L${i}`, n));
      const { markers } = selectGlobeMarkers(groups, budget);
      assert.ok(markers.length <= budget.total, `total exceeded for shape ${JSON.stringify(shape)}`);
      for (let i = 0; i < shape.length; i++) {
        const kept = markers.filter(m => m.id.startsWith(`L${i}-`)).length;
        assert.ok(kept <= budget.perLayer, `perLayer exceeded for L${i} in ${JSON.stringify(shape)}`);
      }
    }
  });

  it('invents no markers and preserves each layer order', () => {
    const groups = [group('a', 200), group('b', 10)];
    const { markers } = selectGlobeMarkers(groups, budget);
    const ids = markers.map(m => m.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicates');

    const aIdx = markers.filter(m => m.id.startsWith('a-')).map(m => Number(m.id.slice(2)));
    assert.deepEqual(aIdx, [...aIdx].sort((x, y) => x - y), 'kept markers stay in source order');
  });

  it('keeps the highest-ranked markers when a rank is supplied', () => {
    const markers = Array.from({ length: 300 }, (_, i) => ({ id: `q-${i}`, severity: i }));
    const { markers: kept } = selectGlobeMarkers(
      [{ layer: 'quakes', markers, rank: m => m.severity }],
      { perLayer: 10, total: 10 },
    );
    assert.deepEqual(
      kept.map(m => m.severity),
      [290, 291, 292, 293, 294, 295, 296, 297, 298, 299],
      'the ten most severe survive, still in source order',
    );
  });

  it('exempts ephemeral markers from the budget', () => {
    const { markers } = selectGlobeMarkers(
      [group('bulk', 1000), { ...group('flash', 3), exempt: true }],
      budget,
    );
    assert.equal(markers.filter(m => m.id.startsWith('flash-')).length, 3, 'flash markers always render');
  });

  it('reports a layer total across all of its feeds', () => {
    // `military` is three separate feeds behind one toggle.
    const groups = [group('military:flights', 32), group('military:vessels', 1526), group('military:clusters', 11)];
    const { truncated } = selectGlobeMarkers(groups, budget);
    assert.equal(truncated.military.total, 32 + 1526 + 11);
  });
});


// ========================================================================
// Proximity ranking — the answer to "which markers survive the cut?" for
// layers with no severity of their own. Ranking these by raw array order
// silently drops whatever sorts last: on the alphabetical nuclear facility
// list that is Zaporizhzhia.
// ========================================================================

describe('proximityRank (#5368)', () => {
  const KYIV = { lat: 50.45, lng: 30.52 };
  const sites = [
    { id: 'sydney', lat: -33.87, lng: 151.21 },
    { id: 'zaporizhzhia', lat: 47.51, lng: 34.59 },
    { id: 'santiago', lat: -33.45, lng: -70.67 },
    { id: 'chornobyl', lat: 51.39, lng: 30.10 },
  ];
  const rank = proximityRank<typeof sites[number]>(KYIV, s => ({ lat: s.lat, lng: s.lng }));

  it('scores nearer markers above far ones', () => {
    const byScore = [...sites].sort((a, b) => rank(b) - rank(a)).map(s => s.id);
    assert.deepEqual(byScore, ['chornobyl', 'zaporizhzhia', 'santiago', 'sydney']);
  });

  it('keeps the sites near the view when a layer is capped', () => {
    const { markers } = selectGlobeMarkers(
      [{ layer: 'nuclear', markers: sites, rank }],
      { perLayer: 2, total: 2 },
    );
    assert.deepEqual(
      markers.map(m => m.id).sort(),
      ['chornobyl', 'zaporizhzhia'],
      'the two Ukrainian sites must survive a cap applied while looking at Ukraine',
    );
  });

  it('is view-relative: the same cap keeps different sites from another vantage', () => {
    const fromSantiago = proximityRank<typeof sites[number]>(
      { lat: -33.45, lng: -70.67 }, s => ({ lat: s.lat, lng: s.lng }),
    );
    const { markers } = selectGlobeMarkers(
      [{ layer: 'nuclear', markers: sites, rank: fromSantiago }],
      { perLayer: 1, total: 1 },
    );
    assert.deepEqual(markers.map(m => m.id), ['santiago']);
  });

  it('sorts markers with unusable coordinates last instead of poisoning the sort', () => {
    const withBad = [
      { id: 'bad', lat: Number.NaN, lng: 0 },
      { id: 'chornobyl', lat: 51.39, lng: 30.10 },
      { id: 'sydney', lat: -33.87, lng: 151.21 },
    ];
    const r = proximityRank<typeof withBad[number]>(KYIV, s => ({ lat: s.lat, lng: s.lng }));
    const { markers } = selectGlobeMarkers(
      [{ layer: 'nuclear', markers: withBad, rank: r }],
      { perLayer: 2, total: 2 },
    );
    assert.deepEqual(markers.map(m => m.id), ['chornobyl', 'sydney']);
  });
});

describe('selectGlobeMarkers — multi-feed layers and bad ranks', () => {
  it('budgets each feed of a shared layer key independently', () => {
    // `military` is flights + vessels + clusters behind one toggle.
    const groups = [
      { layer: 'military', markers: Array.from({ length: 32 }, (_, i) => ({ id: `f-${i}` })) },
      { layer: 'military', markers: Array.from({ length: 1526 }, (_, i) => ({ id: `v-${i}` })) },
      { layer: 'military', markers: Array.from({ length: 11 }, (_, i) => ({ id: `c-${i}` })) },
    ];
    const { markers, truncated } = selectGlobeMarkers(groups, { perLayer: 50, total: 200 });

    assert.ok(markers.length <= 200, 'the global ceiling still holds');
    assert.equal(markers.filter(m => m.id.startsWith('f-')).length, 32, 'small feeds survive whole');
    assert.equal(markers.filter(m => m.id.startsWith('c-')).length, 11);
    assert.ok(markers.filter(m => m.id.startsWith('v-')).length <= 50, 'each feed obeys perLayer');
    assert.equal(truncated.military.total, 32 + 1526 + 11, 'the layer reports all of its feeds');
  });

  it('does not drop markers when a rank returns NaN for every one of them', () => {
    const markers = Array.from({ length: 10 }, (_, i) => ({ id: `n-${i}` }));
    const { markers: kept } = selectGlobeMarkers(
      [{ layer: 'x', markers, rank: () => Number.NaN }],
      { perLayer: 4, total: 4 },
    );
    assert.equal(kept.length, 4, 'a useless rank must still yield a full, stable selection');
    assert.deepEqual(kept.map(m => m.id), ['n-0', 'n-1', 'n-2', 'n-3']);
  });

  it('handles a zero budget and an all-exempt input', () => {
    const zero = selectGlobeMarkers([{ layer: 'a', markers: [{ id: 'x' }] }], { perLayer: 0, total: 0 });
    assert.deepEqual(zero.markers, []);
    assert.equal(zero.truncated.a.shown, 0);

    const allExempt = selectGlobeMarkers(
      [{ layer: 'flash', markers: [{ id: 'f1' }, { id: 'f2' }], exempt: true }],
      { perLayer: 0, total: 0 },
    );
    assert.equal(allExempt.markers.length, 2, 'exempt groups render regardless of budget');
    assert.deepEqual(allExempt.truncated, {});
  });
});

describe('selectGlobeMarkers — tie-break (#5368)', () => {
  // A carrier-or-not rank leaves ~1,500 vessels on one score. Without a
  // tie-break the cut among them falls to feed order — the same arbitrary
  // selection proximity ranking exists to prevent.
  const vessels = [
    { id: 'tug-far', carrier: 0, near: -0.9 },
    { id: 'tug-near', carrier: 0, near: 0.9 },
    { id: 'carrier-far', carrier: 1, near: -0.8 },
    { id: 'frigate-mid', carrier: 0, near: 0.1 },
  ];

  it('lets severity decide first and nearness decide the rest', () => {
    const { markers } = selectGlobeMarkers(
      [{ layer: 'military', markers: vessels, rank: v => v.carrier, tieBreak: v => v.near }],
      { perLayer: 2, total: 2 },
    );
    assert.deepEqual(
      markers.map(m => m.id).sort(),
      ['carrier-far', 'tug-near'],
      'the carrier survives on severity; the remaining slot goes to the nearest, not the first',
    );
  });

  it('does not let the tie-break override a real rank difference', () => {
    const { markers } = selectGlobeMarkers(
      [{ layer: 'q', markers: [{ id: 'm5.2-far', mag: 5.2, near: -1 }, { id: 'm5.1-near', mag: 5.1, near: 1 }],
         rank: q => q.mag, tieBreak: q => q.near }],
      { perLayer: 1, total: 1 },
    );
    assert.deepEqual(markers.map(m => m.id), ['m5.2-far'], 'a 0.1 magnitude gap still outranks nearness');
  });

  it('falls back to source order when no tie-break is supplied', () => {
    const { markers } = selectGlobeMarkers(
      [{ layer: 'military', markers: vessels, rank: v => v.carrier }],
      { perLayer: 2, total: 2 },
    );
    assert.deepEqual(markers.map(m => m.id).sort(), ['carrier-far', 'tug-far']);
  });
});
