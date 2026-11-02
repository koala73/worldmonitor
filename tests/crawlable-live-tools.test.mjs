import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';

import {
  airportDisruptionViewModel,
  ciiRankingViewModel,
  chokepointCoverageMetrics,
  chokepointEvidenceNarrative,
  chokepointStatusViewModel,
  crisisTrackerViewModel,
  hasPublishedLivePulse,
  hazardPulseViewModel,
  loadChokepoint,
  loadCiiRanking,
  loadCountryRisk,
  loadHazards,
  cancelPizzIntRefresh,
  loadPizzInt,
  militaryFlightsViewModel,
  pizzIntRefreshDelay,
  pizzIntViewModel,
  resumePizzIntRefresh,
  pointInBounds,
  publishedTransitCountLabel,
  requestLiveJson,
  runLatestToolRequest,
  chokepointOfficialMetrics,
  formatBaselineShare,
  formatPortwatchDay,
  formatPortwatchRange,
} from '../scripts/crawlable-live-tools.mjs';
import { chokepointPulseRecord, renderChokepointLiveSection } from '../scripts/crawlable-chokepoint-live.mjs';

const NOW = Date.UTC(2026, 6, 24, 12);

function anonymousSessionResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ exp: Date.now() + 60 * 60 * 1000 }),
  };
}

describe('crawlable live intelligence view models', () => {
  let previousSessionStorage;
  let storedSessionValues;

  beforeEach(() => {
    previousSessionStorage = globalThis.sessionStorage;
    storedSessionValues = new Map();
    globalThis.sessionStorage = {
      getItem: (key) => storedSessionValues.get(key) ?? null,
      setItem: (key, value) => storedSessionValues.set(key, value),
      removeItem: (key) => storedSessionValues.delete(key),
    };
  });

  afterEach(() => {
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  });

  it('matches the requested chokepoint and preserves partial transit coverage', () => {
    const payload = {
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      upstreamUnavailable: false,
      chokepoints: [
        { id: 'suez', disruptionScore: 8, status: 'green' },
        {
          id: 'hormuz_strait',
          disruptionScore: 72,
          status: 'red',
          congestionLevel: 'high',
          activeWarnings: 3,
          navigationalWarningsAvailable: true,
          aisDisruptions: 2,
          aisSnapshotAvailable: true,
          description: 'Shipping warning activity is elevated.',
          transitSummary: {
            dataAvailable: false,
            todayTotal: 0,
          },
        },
      ],
    };

    assert.deepEqual(chokepointStatusViewModel(payload, 'hormuz_strait', NOW), {
      disruptionScore: '72',
      status: 'Red',
      congestion: 'High',
      navigationalWarnings: '3 warnings',
      aisDisruptions: '2 AIS disruptions',
      description: 'Shipping warning activity is elevated.',
      officialLatestDate: null,
      officialLatestTotal: null,
      officialAvg7d: null,
      baselineAvgDaily: null,
      baselineFrom: null,
      baselineTo: null,
      weekMovement: null,
      fetchedAt: NOW - 60_000,
      partial: true,
    });
    // An absent upstream note yields null, never a placeholder sentence. The
    // generator turns null into `<p data-chokepoint-description hidden>`; a
    // sentence would be published as real body prose in <main>, and "No
    // additional status note was supplied." was the only live-section text 7 of
    // the 13 chokepoint pages carried (#7530).
    assert.equal(
      chokepointStatusViewModel(payload, 'suez', NOW).description,
      null,
      'a row with no description must report null, not a placeholder sentence',
    );
    assert.equal(
      chokepointStatusViewModel({
        ...payload,
        chokepoints: payload.chokepoints.map((row) => (
          row.id === 'suez' ? { ...row, description: '   ' } : row
        )),
      }, 'suez', NOW).description,
      null,
      'a whitespace-only description must report null too',
    );

    const responsePartial = chokepointStatusViewModel({
      ...payload,
      upstreamUnavailable: true,
      chokepoints: payload.chokepoints.map((row) => row.id === 'hormuz_strait'
        ? {
            ...row,
            transitSummary: {
              dataAvailable: true, todayTotal: 11, wowChangePct: 2.5,
              officialLatestDate: '2026-07-20', officialLatestTotal: 9, officialAvg7d: 8.4,
            },
          }
        : row),
    }, 'hormuz_strait', NOW);
    assert.equal(responsePartial.officialLatestTotal, 9);
    assert.equal(responsePartial.officialLatestDate, '2026-07-20');
    assert.equal(responsePartial.officialAvg7d, 8.4);
    assert.equal(responsePartial.baselineAvgDaily, null, 'no baseline fields means no baseline');
    assert.equal(responsePartial.weekMovement, '+2.5% vs prior week');
    assert.equal(
      responsePartial.navigationalWarnings,
      '3 warnings',
      'complete transit coverage must keep formatted warnings visible',
    );
    assert.equal(responsePartial.partial, true);
    assert.throws(
      () => chokepointStatusViewModel({ chokepoints: [], upstreamUnavailable: true }, 'hormuz_strait', NOW),
      /not present/i,
    );
    assert.throws(
      () => chokepointStatusViewModel(payload, 'panama', NOW),
      /not present/i,
    );
    assert.throws(
      () => chokepointStatusViewModel(
        { ...payload, fetchedAt: NOW - (49 * 60 * 60 * 1_000) },
        'hormuz_strait',
        NOW,
      ),
      /stale/i,
    );
  });

  it('keeps chokepoint source coverage independent', () => {
    const view = chokepointStatusViewModel({
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      upstreamUnavailable: false,
      chokepoints: [{
        id: 'hormuz_strait',
        disruptionScore: 72,
        status: 'red',
        congestionLevel: 'normal',
        activeWarnings: 3,
        navigationalWarningsAvailable: true,
        aisDisruptions: 0,
        aisSnapshotAvailable: false,
        description: 'Active conflict.',
        transitSummary: {
          dataAvailable: true,
          todayTotal: 0,
          todayCountsAvailable: false,
          wowChangePct: 12.9,
        },
      }],
    }, 'hormuz_strait', NOW);

    assert.equal(view.navigationalWarnings, '3 warnings');
    assert.equal(view.aisDisruptions, null);
    assert.equal(view.congestion, null);
    assert.equal(view.officialLatestTotal, null);
    assert.equal(view.weekMovement, '+12.9% vs prior week');
    assert.equal(view.partial, true);
  });

  // Production 2026-10-22: /chokepoints/strait-of-hormuz/ answered "Is the
  // Strait of Hormuz open right now?" with "the observed transit count ... is
  // 38" and a "Today's transits: 38" tile. That 38 was the relay's AIS
  // zone-exit count for a 2-degree circle that includes Dubai, Fujairah and
  // Bandar Abbas port traffic -- not strait crossings. IMF PortWatch, whose
  // daily series the same payload already carries, counted 4 on its latest
  // published day against a 87.4-a-day year-earlier average. The page must
  // headline the official figure and never present the relay number as transits.
  const HORMUZ_PORTWATCH_PAYLOAD = Object.freeze({
    fetchedAt: new Date(NOW - 60_000).toISOString(),
    upstreamUnavailable: false,
    chokepoints: [{
      id: 'hormuz_strait',
      disruptionScore: 85,
      status: 'red',
      congestionLevel: 'normal',
      activeWarnings: 0,
      navigationalWarningsAvailable: true,
      aisDisruptions: 0,
      aisSnapshotAvailable: true,
      description: 'Active conflict — Iran-Israel war',
      transitSummary: {
        dataAvailable: true,
        todayTotal: 38,
        todayTanker: 20,
        todayCargo: 10,
        todayOther: 8,
        todayCountsAvailable: true,
        wowChangePct: -10.3,
        officialLatestDate: '2026-10-18',
        officialLatestTotal: 4,
        officialAvg7d: 3.7,
        baselineAvgDaily: 87.4,
        baselineFrom: '2024-10-22',
        baselineTo: '2025-10-21',
      },
    }],
  });

  // Review on #9550: fewer than 7 published days gives a latest day but no
  // 7-day mean. The wire omits the mean; the page must not print "0 a day" or
  // "0%" of the baseline, which would read as a traffic halt.
  it('withholds the 7-day average and baseline share when the wire omits the mean', () => {
    const transitSummary = { ...HORMUZ_PORTWATCH_PAYLOAD.chokepoints[0].transitSummary };
    delete transitSummary.officialAvg7d;
    const payload = { ...HORMUZ_PORTWATCH_PAYLOAD, chokepoints: [{ ...HORMUZ_PORTWATCH_PAYLOAD.chokepoints[0], transitSummary }] };
    const view = chokepointStatusViewModel(payload, 'hormuz_strait', NOW);
    assert.equal(view.officialLatestTotal, 4);
    assert.equal(view.officialAvg7d, null);
    const html = renderChokepointLiveSection({
      chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
      pulse: chokepointPulseRecord(view),
      live: true,
    });
    const { document } = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    document.body.innerHTML = html;
    const passage = document.querySelector('[data-chokepoint-open-status]').textContent;
    assert.match(passage, /IMF PortWatch counted 4 transits/);
    assert.doesNotMatch(passage, /7-day average|% of the/);
    assert.doesNotMatch(document.body.textContent, /\b0 a day\b|\b0% of\b/);
  });

  it('headlines the IMF PortWatch daily count and never publishes the relay AIS count as transits (Hormuz 2026-10-22)', async (t) => {
    // The page prints its reading time, and /\b38\b/ below would match a
    // clock minute of :38. Pin the clock so the check sees only data.
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const view = chokepointStatusViewModel(HORMUZ_PORTWATCH_PAYLOAD, 'hormuz_strait', NOW);
    assert.equal(view.officialLatestDate, '2026-10-18');
    assert.equal(view.officialLatestTotal, 4);
    assert.equal(view.officialAvg7d, 3.7);
    assert.equal(view.baselineAvgDaily, 87.4);
    assert.equal(view.baselineFrom, '2024-10-22');
    assert.equal(view.baselineTo, '2025-10-21');
    assert.equal(view.weekMovement, '-10.3% vs prior week');
    assert.equal(view.partial, false, 'every source reported, so the pulse is complete');
    assert.equal('todayTransits' in view, false, 'the relay AIS count must not reach the page view');
    assert.doesNotMatch(JSON.stringify(view), /\b38\b/);

    const pulse = chokepointPulseRecord(view);
    assert.equal(pulse.officialLatestTotal, 4);
    assert.equal(pulse.baselineAvgDaily, 87.4);
    assert.equal('todayTransits' in pulse, false);
    assert.equal('todayCountsAvailable' in pulse, false);

    const expectedPassage = 'As of Jul 24, 2026, 11:59 AM UTC, IMF PortWatch counted 4 transits through the Strait of Hormuz'
      + ' on Oct 18, 2026 (latest published day). The 7-day average is 3.7 a day, 4% of the 87.4-a-day average'
      + ' for Oct 2024–Oct 2025. The Red disruption score is a risk signal; it does not verify unrestricted'
      + ' passage or operational closure.';
    for (const live of [false, true]) {
      const html = renderChokepointLiveSection({
        chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
        pulse,
        live,
      });
      const { document } = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
      document.body.innerHTML = html;
      assert.equal(document.querySelector('[data-chokepoint-open-status]').textContent, expectedPassage);
      assert.match(
        document.querySelector('[data-chokepoint-score-driver]').textContent,
        /Context only \(not score inputs\): AIS event count \(0 AIS disruptions\); IMF PortWatch latest daily count \(4 on Oct 18, 2026\)\.$/,
      );
      assert.equal(document.querySelector('[data-chokepoint-official-transits]').textContent, '4');
      assert.equal(document.querySelector('[data-chokepoint-official-date]').textContent, 'Oct 18, 2026');
      assert.equal(document.querySelector('[data-chokepoint-official-average]').textContent, '3.7 a day · 4% of 87.4');
      assert.equal(document.querySelector('[data-chokepoint-movement]').textContent, '-10.3% vs prior week');
      assert.match(html, /<span>Latest daily transits \(IMF PortWatch\)<\/span>/);
      assert.match(html, /<span>7-day average vs year-earlier<\/span>/);
      assert.match(html, /<span>Week-over-week movement<\/span>/);
      assert.match(html, /IMF PortWatch/, 'the source is attributed by name');
      assert.doesNotMatch(html, /\b38\b/, 'the relay zone-exit count must not appear anywhere on the page');
      assert.doesNotMatch(html, /Today's transits|observed transit count|data-chokepoint-transits\b|Transit counts require observed AIS crossings/);
      assert.equal(document.querySelector('[data-live-chokepoint]').dataset.state, 'ready');
    }

    // The client hydrate sets the same elements from the same payload.
    const { document } = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    document.body.innerHTML = renderChokepointLiveSection({
      chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
      pulse: null,
    });
    const tool = document.querySelector('[data-live-chokepoint]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => (String(url).includes('get-chokepoint-status')
      ? { ok: true, status: 200, json: async () => ({ ...HORMUZ_PORTWATCH_PAYLOAD, fetchedAt: new Date(Date.now() - 60_000).toISOString() }) }
      : anonymousSessionResponse());
    try {
      await loadChokepoint(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.match(
      tool.querySelector('[data-chokepoint-open-status]').textContent,
      /IMF PortWatch counted 4 transits through the Strait of Hormuz on Oct 18, 2026 \(latest published day\)\. The 7-day average is 3\.7 a day, 4% of the 87\.4-a-day average for Oct 2024–Oct 2025\./,
    );
    assert.equal(tool.querySelector('[data-chokepoint-official-transits]').textContent, '4');
    assert.equal(tool.querySelector('[data-chokepoint-official-date]').textContent, 'Oct 18, 2026');
    assert.equal(tool.querySelector('[data-chokepoint-official-average]').textContent, '3.7 a day · 4% of 87.4');
    assert.equal(tool.querySelector('[data-chokepoint-movement]').textContent, '-10.3% vs prior week');
    assert.doesNotMatch(tool.outerHTML, /\b38\b/);
    assert.equal(tool.dataset.state, 'ready');
  });

  it('omits the year-earlier comparison when the PortWatch baseline is missing', () => {
    const payload = structuredClone(HORMUZ_PORTWATCH_PAYLOAD);
    Object.assign(payload.chokepoints[0].transitSummary, { baselineAvgDaily: 0, baselineFrom: '', baselineTo: '' });
    const view = chokepointStatusViewModel(payload, 'hormuz_strait', NOW);
    assert.equal(view.baselineAvgDaily, null);
    assert.equal(view.baselineFrom, null);
    assert.equal(view.officialLatestTotal, 4);
    assert.equal(view.partial, false, 'a missing baseline is not missing coverage');
    const html = renderChokepointLiveSection({
      chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
      pulse: chokepointPulseRecord(view),
    });
    const { document } = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    document.body.innerHTML = html;
    const passage = document.querySelector('[data-chokepoint-open-status]').textContent;
    assert.match(passage, /counted 4 transits through the Strait of Hormuz on Oct 18, 2026 \(latest published day\)\. The 7-day average is 3\.7 a day\. The Red disruption score/);
    assert.doesNotMatch(passage, /% of|a-day average/);
    assert.equal(document.querySelector('[data-chokepoint-official-average]').textContent, '3.7 a day');
  });

  it('withholds the official count and comparison when PortWatch has no history', () => {
    const payload = structuredClone(HORMUZ_PORTWATCH_PAYLOAD);
    Object.assign(payload.chokepoints[0].transitSummary, {
      dataAvailable: false, wowChangePct: 0,
      officialLatestDate: '', officialLatestTotal: 0, officialAvg7d: 0,
      baselineAvgDaily: 0, baselineFrom: '', baselineTo: '',
    });
    const view = chokepointStatusViewModel(payload, 'hormuz_strait', NOW);
    for (const field of ['officialLatestDate', 'officialLatestTotal', 'officialAvg7d', 'baselineAvgDaily', 'baselineFrom', 'baselineTo', 'weekMovement']) {
      assert.equal(view[field], null, `${field} must be withheld, not a proto zero`);
    }
    assert.equal(view.partial, true);
    const html = renderChokepointLiveSection({
      chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
      pulse: chokepointPulseRecord(view),
    });
    const { document } = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    document.body.innerHTML = html;
    const passage = document.querySelector('[data-chokepoint-open-status]').textContent;
    assert.match(passage, /source coverage for the Strait of Hormuz is partial\. No IMF PortWatch daily transit count is published for this snapshot\. World Monitor cannot verify operational passage status from this snapshot\./);
    assert.equal(document.querySelector('[data-chokepoint-official-transits]').textContent, '—');
    assert.equal(document.querySelector('[data-chokepoint-official-date]').textContent, '');
    assert.equal(document.querySelector('[data-chokepoint-official-average]').textContent, '—');
    assert.equal(document.querySelector('[data-chokepoint-movement]').textContent, '—');
    assert.doesNotMatch(html, /data-chokepoint-official-transits>0</);
    assert.doesNotMatch(html, /\b38\b/);
  });

  it('renders a legacy frozen pulse record without the PortWatch fields by withholding them', () => {
    // Pulse snapshots frozen before these fields existed carry the relay count
    // instead; the page must render, drop that count, and withhold the official one.
    const legacy = {
      disruptionScore: '70', status: 'Red', congestion: 'Normal',
      navigationalWarnings: '0 warnings', navigationalWarningsAvailable: true,
      aisDisruptions: '0 AIS disruptions', aisSnapshotAvailable: true,
      description: 'Active conflict.', todayTransits: '38', todayCountsAvailable: true,
      weekMovement: '-14.3% vs prior week', partial: false, asOf: '2026-10-12T05:02:00.000Z',
    };
    const html = renderChokepointLiveSection({
      chokepoint: { id: 'hormuz_strait', displayName: 'Strait of Hormuz' },
      pulse: legacy,
    });
    const { document } = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    document.body.innerHTML = html;
    assert.doesNotMatch(html, /\b38\b/);
    assert.equal(document.querySelector('[data-chokepoint-official-transits]').textContent, '—');
    assert.equal(document.querySelector('[data-chokepoint-official-average]').textContent, '—');
    assert.equal(document.querySelector('[data-chokepoint-movement]').textContent, '-14.3% vs prior week');
    assert.match(
      document.querySelector('[data-chokepoint-open-status]').textContent,
      /^As of Oct 12, 2026, 5:02 AM UTC, source coverage for the Strait of Hormuz is partial\. No IMF PortWatch daily transit count is published for this snapshot\./,
    );
    assert.equal(document.querySelector('[data-live-chokepoint]').dataset.state, 'partial');
    assert.equal(document.querySelector('[data-chokepoint-score]').textContent, '70');
  });

  it('normalizes and ranks a complete current CII response', () => {
    const view = ciiRankingViewModel({
      ciiScores: [
        {
          region: 'IR',
          combinedScore: 67,
          dynamicScore: 7,
          trend: 'TREND_DIRECTION_RISING',
          computedAt: NOW - 60_000,
          methodologyVersion: 'v8',
        },
        {
          region: 'UA',
          combinedScore: 78,
          dynamicScore: -2,
          trend: 'TREND_DIRECTION_FALLING',
          computedAt: NOW - 120_000,
          methodologyVersion: 'v8',
        },
      ],
      degraded: false,
      stale: false,
    }, NOW);

    assert.deepEqual(view, {
      rows: [
        {
          code: 'UA',
          score: '78',
          scoreValue: 78,
          band: 'High',
          trend: 'Falling -2',
          computedAt: NOW - 120_000,
          methodologyVersion: 'v8',
        },
        {
          code: 'IR',
          score: '67',
          scoreValue: 67,
          band: 'High',
          trend: 'Rising +7',
          computedAt: NOW - 60_000,
          methodologyVersion: 'v8',
        },
      ],
      updatedAt: NOW - 60_000,
      methodologyVersion: 'v8',
    });
  });

  it('rejects incomplete, stale, or degraded CII ranking responses', () => {
    const score = {
      region: 'IR',
      combinedScore: 67,
      dynamicScore: 7,
      trend: 'TREND_DIRECTION_RISING',
      computedAt: NOW - 60_000,
      methodologyVersion: 'v8',
    };

    assert.throws(() => ciiRankingViewModel({ ciiScores: [], degraded: false, stale: false }, NOW), /unavailable/i);
    assert.throws(() => ciiRankingViewModel({ ciiScores: [score], degraded: true, stale: false }, NOW), /degraded/i);
    assert.throws(
      () => ciiRankingViewModel({
        ciiScores: [{ ...score, computedAt: NOW - (49 * 60 * 60 * 1_000) }],
        degraded: false,
        stale: false,
      }, NOW),
      /timestamp/i,
    );
    assert.throws(
      () => ciiRankingViewModel({ ciiScores: [score, score], degraded: false, stale: false }, NOW),
      /duplicate/i,
    );
  });

  it('keeps same-score CII rows in payload order instead of ISO code order', () => {
    const score = {
      combinedScore: 50,
      dynamicScore: 0,
      trend: 'TREND_DIRECTION_STABLE',
      computedAt: NOW - 60_000,
      methodologyVersion: 'v8',
    };
    const view = ciiRankingViewModel({
      ciiScores: [
        { ...score, region: 'VE' },
        { ...score, region: 'AE' },
        { ...score, region: 'BR' },
      ],
      degraded: false,
      stale: false,
    }, NOW);

    assert.deepEqual(view.rows.map((row) => row.code), ['VE', 'AE', 'BR']);
  });

  it('does not read the relay AIS zone-exit count as a transit count under any availability flag', () => {
    // Before the PortWatch headline, a todayTotal of 0 with todayCountsAvailable
    // unset was the #7457 zero-fill and a todayTotal of 38 with the flag set
    // was the 2026-10-22 Hormuz page. Neither is a strait crossing count; the
    // view model ignores the field whatever the flag says.
    for (const [todayTotal, todayCountsAvailable] of [[0, undefined], [0, true], [38, true], [38, false]]) {
      const view = chokepointStatusViewModel({
        fetchedAt: new Date(NOW - 60_000).toISOString(),
        upstreamUnavailable: false,
        chokepoints: [{
          id: 'hormuz_strait',
          disruptionScore: 70,
          status: 'red',
          congestionLevel: 'normal',
          activeWarnings: 0,
          aisDisruptions: 0,
          description: 'Active conflict.',
          transitSummary: { dataAvailable: true, todayTotal, todayCountsAvailable, wowChangePct: 12.9 },
        }],
      }, 'hormuz_strait', NOW);
      assert.equal('todayTransits' in view, false);
      assert.equal('todayCountsAvailable' in view, false);
      assert.equal(view.officialLatestTotal, null, 'no PortWatch day means no official count');
      assert.doesNotMatch(JSON.stringify(view), /\b38\b/);
      assert.equal(view.weekMovement, '+12.9% vs prior week');
      assert.equal(view.navigationalWarnings, null);
      assert.equal(view.aisDisruptions, null);
      assert.equal(view.congestion, null);
      assert.equal(view.partial, true);
    }
  });

  it('hydrates a measured PortWatch zero with warnings and movement', async () => {
    // PortWatch published 0 transits for Hormuz on 2026-10-17. An official 0
    // is a measurement and renders as "0"; only an absent day withholds.
    const window = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="hormuz_strait" data-chokepoint-name="Strait of Hormuz" data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid>
          <div class="metric"><strong><span data-chokepoint-score>70</span><small data-chokepoint-band>Red</small></strong></div>
          <div class="metric"><strong data-chokepoint-congestion>Normal</strong></div>
          <div class="metric"><strong data-chokepoint-warnings>0 warnings</strong></div>
          <div class="metric"><strong data-chokepoint-ais-disruptions>0 AIS disruptions</strong></div>
          <div class="metric"><strong><span data-chokepoint-official-transits>—</span><small data-chokepoint-official-date></small></strong></div>
          <div class="metric"><strong data-chokepoint-official-average>—</strong></div>
          <div class="metric"><strong data-chokepoint-movement>+12.9% vs prior week</strong></div>
        </div>
        <p data-chokepoint-description>Active conflict.</p>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
      </section>
    `;

    const tool = document.querySelector('[data-live-chokepoint]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('get-chokepoint-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
            upstreamUnavailable: false,
            chokepoints: [{
              id: 'hormuz_strait',
              disruptionScore: 70,
              status: 'red',
              congestionLevel: 'normal',
              activeWarnings: 0,
              navigationalWarningsAvailable: true,
              aisDisruptions: 0,
              aisSnapshotAvailable: true,
              description: 'Active conflict.',
              transitSummary: {
                dataAvailable: true,
                todayTotal: 0,
                todayCountsAvailable: true,
                wowChangePct: 12.9,
                officialLatestDate: '2026-10-17',
                officialLatestTotal: 0,
                officialAvg7d: 0,
                baselineAvgDaily: 87.4,
                baselineFrom: '2024-10-21',
                baselineTo: '2025-10-20',
              },
            }],
          }),
        };
      }
      return anonymousSessionResponse();
    };
    try {
      await loadChokepoint(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(tool.querySelector('[data-chokepoint-official-transits]').textContent, '0');
    assert.equal(tool.querySelector('[data-chokepoint-official-date]').textContent, 'Oct 17, 2026');
    assert.equal(tool.querySelector('[data-chokepoint-official-average]').textContent, '0 a day · 0% of 87.4');
    assert.equal(tool.querySelector('[data-chokepoint-movement]').textContent, '+12.9% vs prior week');
    assert.equal(tool.querySelector('[data-chokepoint-warnings]').textContent, '0 warnings');
    assert.equal(tool.querySelector('[data-chokepoint-ais-disruptions]').textContent, '0 AIS disruptions');
  });

  it('derives the coverage tuple from explicit availability', () => {
    const tuple = {
      navigationalWarnings: '2 warnings',
      navigationalWarningsAvailable: true,
      aisDisruptions: '0 AIS disruptions',
      aisSnapshotAvailable: true,
      congestionLevel: 'normal',
      weekMovement: '+3% vs prior week',
    };
    assert.deepEqual(chokepointCoverageMetrics(tuple), {
      navigationalWarnings: '2 warnings',
      aisDisruptions: '0 AIS disruptions',
      congestion: 'Normal',
      weekMovement: '+3% vs prior week',
    });
    assert.deepEqual(
      chokepointCoverageMetrics({ ...tuple, navigationalWarningsAvailable: undefined, aisSnapshotAvailable: undefined }),
      { navigationalWarnings: null, aisDisruptions: null, congestion: null, weekMovement: '+3% vs prior week' },
    );
  });

  it('labels the official PortWatch figures and withholds each one its inputs cannot support', () => {
    const hormuz = {
      officialLatestDate: '2026-10-18', officialLatestTotal: 4, officialAvg7d: 3.7,
      baselineAvgDaily: 87.4, baselineFrom: '2024-10-22', baselineTo: '2025-10-21',
    };
    assert.deepEqual(chokepointOfficialMetrics(hormuz), {
      latestTransits: '4',
      latestDate: 'Oct 18, 2026',
      averageLabel: '3.7 a day',
      baselineShare: '4%',
      baselineAverage: '87.4',
      baselineRange: 'Oct 2024–Oct 2025',
      average: '3.7 a day · 4% of 87.4',
    });
    // Dover: thousands separators and a share near parity.
    assert.equal(
      chokepointOfficialMetrics({ ...hormuz, officialLatestTotal: 1203, officialAvg7d: 171.9, baselineAvgDaily: 174.3 }).average,
      '171.9 a day · 99% of 174.3',
    );
    assert.equal(chokepointOfficialMetrics({ ...hormuz, officialLatestTotal: 1203 }).latestTransits, '1,203');
    // A measured 0 day publishes; an absent day withholds everything.
    assert.equal(chokepointOfficialMetrics({ ...hormuz, officialLatestTotal: 0 }).latestTransits, '0');
    const absent = chokepointOfficialMetrics({ ...hormuz, officialLatestDate: null, officialLatestTotal: null });
    assert.deepEqual(absent, {
      latestTransits: null, latestDate: null, averageLabel: null,
      baselineShare: null, baselineAverage: null, baselineRange: null, average: null,
    });
    assert.deepEqual(chokepointOfficialMetrics({}), absent, 'a legacy record with no fields withholds everything');
    // Missing baseline: the average publishes alone, no comparison is invented.
    const noBaseline = chokepointOfficialMetrics({ ...hormuz, baselineAvgDaily: null, baselineFrom: null, baselineTo: null });
    assert.equal(noBaseline.average, '3.7 a day');
    assert.equal(noBaseline.baselineShare, null);
    assert.equal(noBaseline.baselineRange, null);
    assert.equal(chokepointOfficialMetrics({ ...hormuz, baselineAvgDaily: 0 }).average, '3.7 a day', 'a proto zero baseline is absent');
    assert.equal(chokepointOfficialMetrics({ ...hormuz, baselineTo: '' }).average, '3.7 a day', 'a baseline without its window is absent');
    // Malformed inputs withhold instead of rendering garbage.
    assert.equal(chokepointOfficialMetrics({ ...hormuz, officialLatestDate: '18/10/2026' }).latestTransits, null);
    assert.equal(chokepointOfficialMetrics({ ...hormuz, officialLatestTotal: -1 }).latestTransits, null);
    assert.equal(chokepointOfficialMetrics({ ...hormuz, officialLatestTotal: 0.4 }).latestTransits, null);

    assert.equal(formatPortwatchDay('2026-10-18'), 'Oct 18, 2026');
    assert.equal(formatPortwatchDay('2026-13-45'), null);
    assert.equal(formatPortwatchRange('2024-10-22', '2025-10-21'), 'Oct 2024–Oct 2025');
    assert.equal(formatPortwatchRange('2025-10-01', '2025-10-21'), 'Oct 2025');
    assert.equal(formatBaselineShare(3.7, 87.4), '4%');
    assert.equal(formatBaselineShare(0.3, 87.4), '0.3%', 'a near-closure keeps one decimal instead of rounding to 0%');
    assert.equal(formatBaselineShare(0, 87.4), '0%');
    assert.equal(formatBaselineShare(171.9, 174.3), '99%');
    assert.equal(formatBaselineShare(3.7, 0), null, 'a zero baseline is not a comparison');
    assert.equal(formatBaselineShare(null, 87.4), null);
  });

  it('hydrates formatted warnings when transit coverage is complete', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="hormuz_strait" data-chokepoint-name="Strait of Hormuz" data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid>
          <div class="metric"><strong><span data-chokepoint-score>—</span><small data-chokepoint-band></small></strong></div>
          <div class="metric" hidden><strong data-chokepoint-congestion></strong></div>
          <div class="metric" hidden><strong data-chokepoint-warnings></strong></div>
          <div class="metric" hidden><strong data-chokepoint-ais-disruptions></strong></div>
          <div class="metric"><strong><span data-chokepoint-official-transits>—</span><small data-chokepoint-official-date></small></strong></div>
          <div class="metric"><strong data-chokepoint-official-average>—</strong></div>
          <div class="metric"><strong data-chokepoint-movement>—</strong></div>
        </div>
        <p data-chokepoint-description></p>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
      </section>
    `;

    const tool = document.querySelector('[data-live-chokepoint]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('get-chokepoint-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
            upstreamUnavailable: false,
            chokepoints: [{
              id: 'hormuz_strait',
              disruptionScore: 72,
              status: 'red',
              congestionLevel: 'high',
              activeWarnings: 3,
              navigationalWarningsAvailable: true,
              aisDisruptions: 2,
              aisSnapshotAvailable: true,
              description: 'Elevated shipping warnings.',
              transitSummary: {
                dataAvailable: true,
                todayTotal: 11,
                wowChangePct: 2.5,
                officialLatestDate: '2026-08-26',
                officialLatestTotal: 11,
                officialAvg7d: 12.3,
              },
            }],
          }),
        };
      }
      return anonymousSessionResponse();
    };
    try {
      await loadChokepoint(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(tool.querySelector('[data-chokepoint-official-transits]').textContent, '11');
    assert.equal(tool.querySelector('[data-chokepoint-official-date]').textContent, 'Aug 26, 2026');
    assert.equal(tool.querySelector('[data-chokepoint-official-average]').textContent, '12.3 a day');
    assert.equal(
      tool.querySelector('[data-chokepoint-warnings]').textContent,
      '3 warnings',
    );
    assert.equal(tool.querySelector('[data-chokepoint-ais-disruptions]').textContent, '2 AIS disruptions');
    assert.equal(tool.querySelector('[data-chokepoint-warnings]').closest('.metric').hidden, false);
    assert.equal(tool.querySelector('[data-chokepoint-ais-disruptions]').closest('.metric').hidden, false);
    assert.equal(tool.querySelector('[data-chokepoint-congestion]').closest('.metric').hidden, false);
    assert.equal(tool.querySelector('[data-chokepoint-movement]').textContent, '+2.5% vs prior week');
  });

  it('refreshes the passage evidence and score driver together on live update (#7613)', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="hormuz_strait" data-chokepoint-name="Strait of Hormuz" data-state="ready">
        <h2>Is Strait of Hormuz open right now?</h2>
        <p data-chokepoint-open-status>Old passage evidence.</p>
        <p data-chokepoint-score-driver>Old score inputs.</p>
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid>
          <div class="metric"><strong><span data-chokepoint-score>35</span><small data-chokepoint-band>Yellow</small></strong></div>
          <div class="metric"><strong><span data-chokepoint-official-transits>—</span><small data-chokepoint-official-date></small></strong></div>
          <div class="metric"><strong data-chokepoint-official-average>—</strong></div>
          <div class="metric"><strong data-chokepoint-movement>—</strong></div>
        </div>
        <p data-chokepoint-description></p>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
      </section>
    `;

    const tool = document.querySelector('[data-live-chokepoint]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('get-chokepoint-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
            upstreamUnavailable: false,
            chokepoints: [{
              id: 'hormuz_strait',
              disruptionScore: 70,
              status: 'red',
              congestionLevel: 'normal',
              activeWarnings: 0,
              navigationalWarningsAvailable: true,
              aisDisruptions: 0,
              aisSnapshotAvailable: true,
              description: 'Active conflict.',
              transitSummary: {
                dataAvailable: true,
                todayTotal: 6,
                todayCountsAvailable: true,
                wowChangePct: -14.3,
                officialLatestDate: '2026-08-26',
                officialLatestTotal: 6,
                officialAvg7d: 5.1,
                baselineAvgDaily: 87.4,
                baselineFrom: '2024-08-30',
                baselineTo: '2025-08-29',
              },
            }],
          }),
        };
      }
      return anonymousSessionResponse();
    };
    try {
      await loadChokepoint(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.match(
      tool.querySelector('[data-chokepoint-open-status]').textContent,
      /IMF PortWatch counted 6 transits through the Strait of Hormuz on Aug 26, 2026 \(latest published day\)\. The 7-day average is 5\.1 a day, 6% of the 87\.4-a-day average for Aug 2024–Aug 2025\. The Red disruption score is a risk signal; it does not verify unrestricted passage or operational closure\./,
    );
    assert.match(
      tool.querySelector('[data-chokepoint-score-driver]').textContent,
      /Configured geopolitical baseline: Active conflict\. Observed score inputs: 0 warnings; maximum AIS congestion severity Normal\. Context only \(not score inputs\): AIS event count \(0 AIS disruptions\); IMF PortWatch latest daily count \(6 on Aug 26, 2026\)\./,
    );
  });

  it('does not hydrate a definitive passage status from partial source coverage', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/chokepoints/taiwan-strait/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="taiwan_strait" data-chokepoint-name="Taiwan Strait" data-state="ready">
        <p data-chokepoint-open-status>Old passage evidence.</p>
        <p data-chokepoint-score-driver>Old score inputs.</p>
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid>
          <div class="metric"><strong><span data-chokepoint-score>20</span><small data-chokepoint-band>Yellow</small></strong></div>
          <div class="metric"><strong data-chokepoint-congestion>Low</strong></div>
          <div class="metric"><strong data-chokepoint-warnings>0 warnings</strong></div>
          <div class="metric"><strong data-chokepoint-ais-disruptions>1 AIS disruption</strong></div>
          <div class="metric"><strong><span data-chokepoint-official-transits>12</span><small data-chokepoint-official-date>Aug 26, 2026</small></strong></div>
          <div class="metric"><strong data-chokepoint-official-average>12 a day</strong></div>
          <div class="metric"><strong data-chokepoint-movement>Stable</strong></div>
        </div>
        <p data-chokepoint-description></p>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
      </section>
    `;
    const tool = document.querySelector('[data-live-chokepoint]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('get-chokepoint-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
            upstreamUnavailable: false,
            chokepoints: [{
              id: 'taiwan_strait',
              disruptionScore: 20,
              status: 'yellow',
              congestionLevel: 'low',
              activeWarnings: 0,
              navigationalWarningsAvailable: false,
              aisDisruptions: 1,
              aisSnapshotAvailable: true,
              description: 'Cross-strait military tensions',
              transitSummary: {
                dataAvailable: true,
                todayTotal: 12,
                todayCountsAvailable: true,
                wowChangePct: 0,
                officialLatestDate: '2026-08-26',
                officialLatestTotal: 12,
                officialAvg7d: 12,
              },
            }],
          }),
        };
      }
      return anonymousSessionResponse();
    };
    try {
      await loadChokepoint(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const passage = tool.querySelector('[data-chokepoint-open-status]').textContent;
    assert.match(passage, /source coverage for the Taiwan Strait is partial/);
    assert.match(passage, /IMF PortWatch counted 12 transits on Aug 26, 2026 \(latest published day\)\. The 7-day average is 12 a day\./);
    assert.match(passage, /cannot verify operational passage status/);
    assert.doesNotMatch(passage, / is (?:open|restricted|effectively closed) /);
    assert.match(
      tool.querySelector('[data-chokepoint-score-driver]').textContent,
      /Observed score inputs: maximum AIS congestion severity Low\. Unavailable score inputs: navigational warning count\./,
    );
  });

  // The mirror-parity test this replaces could not do its job: of its ten
  // values only `11` reached a formatter, and it renders identically under
  // every variant, so deleting the formatter outright still passed. The mirror
  // is gone (one source now), and these are the cases that actually bite.
  it('publishes a supplied transit count and withholds every unsupplied shape', () => {
    // Positive control. The corpus suite derives this from whichever
    // chokepoints have AIS traffic on the freeze date, which the monthly
    // refresh can take to zero; this one is synthetic and always runs.
    assert.equal(publishedTransitCountLabel(7), '7');
    assert.equal(publishedTransitCountLabel('7'), '7');
    assert.equal(publishedTransitCountLabel(1), '1', 'a single crossing is a real measurement');
    assert.equal(publishedTransitCountLabel(1234), '1,234', 'counts are thousands-separated');
    assert.equal(publishedTransitCountLabel('1,234'), '1,234', 'an already-formatted string round-trips');
    assert.equal(publishedTransitCountLabel(1234567), '1,234,567');
    assert.equal(publishedTransitCountLabel(0, { allowZero: true }), '0');

    // Withheld: absent, empty, and the zero-fill this exists to stop.
    for (const value of [null, undefined, '', '0', 0, -1, '-3', 'Unavailable', NaN, Infinity]) {
      assert.equal(publishedTransitCountLabel(value), null, `${String(value)} must withhold`);
    }

    // A fraction clears a bare `> 0` gate and then formats to the literal "0".
    assert.equal(publishedTransitCountLabel(0.4), null, 'a sub-1 fraction must not render as "0"');
    assert.equal(publishedTransitCountLabel(0.6), null);
    assert.equal(publishedTransitCountLabel(0.4, { allowZero: true }), null);
    assert.equal(publishedTransitCountLabel(-1, { allowZero: true }), null);

    // Strings are re-formatted from the parsed number, never echoed, so a
    // malformed upstream value cannot reach the page verbatim.
    assert.equal(publishedTransitCountLabel('1e3'), '1,000');
    assert.equal(publishedTransitCountLabel('12abc'), null);
  });

  it('withholds the official figures when PortWatch dropped the chokepoint, whatever the relay counted', () => {
    // dataAvailable is PortWatch history presence. PortWatch dropped two
    // chokepoints for ~4.5h on 2026-08-25; while it is out there is no official
    // day to publish, and the relay's AIS window count is not a substitute.
    const payload = {
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      upstreamUnavailable: false,
      chokepoints: [{
        id: 'suez',
        disruptionScore: 30,
        status: 'yellow',
        congestionLevel: 'normal',
        activeWarnings: 0,
        aisDisruptions: 0,
        description: 'Normal.',
        transitSummary: {
          dataAvailable: false, todayTotal: 9, todayCountsAvailable: true, wowChangePct: 0,
          // A stale cached row can still carry official fields; without
          // PortWatch history they are not current and must not publish.
          officialLatestDate: '2026-07-20', officialLatestTotal: 40, officialAvg7d: 38.2,
        },
      }],
    };

    const view = chokepointStatusViewModel(payload, 'suez', NOW);
    assert.equal(view.officialLatestTotal, null);
    assert.equal(view.officialLatestDate, null);
    assert.equal(view.weekMovement, null, 'week movement still needs PortWatch and must stay withheld');
    assert.equal(view.partial, true, 'missing PortWatch history is still a partial pulse');
    assert.doesNotMatch(JSON.stringify(view), /\b9\b|\b40\b/);
  });

  it('withholds the official count in prose without blaming a feed, and recovers on the next reading', async (t) => {
    // The page prints its reading time, and /\b38\b/ below would match a
    // clock minute of :38. Pin the clock so the check sees only data.
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const window = new Window({ url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/' });
    window.document.body.innerHTML = `<section data-live-chokepoint data-chokepoint-id="hormuz_strait"
      data-chokepoint-name="Strait of Hormuz"><p data-chokepoint-open-status></p>
      <strong><span data-chokepoint-official-transits></span><small data-chokepoint-official-date></small></strong>
      <strong data-chokepoint-official-average></strong><strong data-chokepoint-movement></strong></section>`;
    const tool = window.document.querySelector('section');
    const originalFetch = globalThis.fetch;
    let available = false;
    globalThis.fetch = async url => String(url).includes('get-chokepoint-status')
      ? { ok: true, status: 200, json: async () => ({
        fetchedAt: new Date().toISOString(), upstreamUnavailable: false,
        chokepoints: [{ id: 'hormuz_strait', disruptionScore: 70, status: 'red',
          transitSummary: {
            todayTotal: 38, todayCountsAvailable: true, dataAvailable: true, wowChangePct: -10.3,
            officialLatestDate: available ? '2026-10-18' : '', officialLatestTotal: available ? 2 : 0, officialAvg7d: available ? 3.7 : 0,
          } }],
      }) }
      : anonymousSessionResponse();
    try {
      await loadChokepoint(tool);
      const withheld = tool.querySelector('[data-chokepoint-open-status]').textContent;
      assert.match(withheld, /No IMF PortWatch daily transit count is published for this snapshot/);
      assert.doesNotMatch(withheld, /AIS feed|relay/, 'the absence is not attributed to a feed outage');
      assert.equal(tool.querySelector('[data-chokepoint-official-transits]').textContent, '—');
      assert.equal(tool.querySelector('[data-chokepoint-official-date]').textContent, '');
      assert.equal(tool.querySelector('[data-chokepoint-official-average]').textContent, '—');
      assert.equal(tool.querySelector('[data-chokepoint-movement]').textContent, '-10.3% vs prior week');
      assert.doesNotMatch(tool.outerHTML, /\b38\b/);
      available = true;
      await loadChokepoint(tool);
      assert.equal(tool.querySelector('[data-chokepoint-official-transits]').textContent, '2');
      assert.equal(tool.querySelector('[data-chokepoint-official-date]').textContent, 'Oct 18, 2026');
      assert.equal(tool.querySelector('[data-chokepoint-official-average]').textContent, '3.7 a day');
      assert.match(tool.querySelector('[data-chokepoint-open-status]').textContent, /IMF PortWatch counted 2 transits on Oct 18, 2026/);
      assert.doesNotMatch(tool.outerHTML, /\b38\b/);
    } finally {
      globalThis.fetch = originalFetch;
      window.close();
    }
  });

  it('keeps maximum AIS congestion severity as a score input and AIS event count as context', () => {
    const narrative = chokepointEvidenceNarrative({
      displayName: 'Suez Canal',
      score: '35',
      bandLabel: 'Yellow',
      description: 'JWC Listed Area',
      asOfText: 'Sep 3, 2026, 6:25 AM UTC',
      partial: false,
      warningsLabel: '1 warning',
      congestionLabel: 'High',
      aisEventCountLabel: '7 AIS disruptions',
      officialLatestDate: '2026-08-30',
      officialLatestTotal: 1,
      officialAvg7d: 36.9,
      baselineAvgDaily: 37.5,
      baselineFrom: '2024-09-03',
      baselineTo: '2025-09-02',
    });
    assert.deepEqual(narrative, {
      passage: 'As of Sep 3, 2026, 6:25 AM UTC, IMF PortWatch counted 1 transit through the Suez Canal on Aug 30, 2026 (latest published day).'
        + ' The 7-day average is 36.9 a day, 98% of the 37.5-a-day average for Sep 2024–Sep 2025.'
        + ' The Yellow disruption score is a risk signal; it does not verify unrestricted passage or operational closure.',
      scoreDriver: 'The score of 35 (Yellow) has this evidence basis.'
        + ' Configured geopolitical baseline: JWC Listed Area.'
        + ' Observed score inputs: 1 warning; maximum AIS congestion severity High.'
        + ' Context only (not score inputs): AIS event count (7 AIS disruptions); IMF PortWatch latest daily count (1 on Aug 30, 2026).',
    });
    assert.doesNotMatch(narrative.scoreDriver, /Observed score inputs:[^.]*7 AIS disruptions/);
  });

  it('withholds definitive passage status for partial coverage and names one missing score source', () => {
    const narrative = chokepointEvidenceNarrative({
      displayName: 'Taiwan Strait',
      score: 20,
      bandLabel: 'Yellow',
      description: 'Cross-strait military tensions',
      asOfText: 'Sep 3, 2026, 6:25 AM UTC',
      partial: true,
      warningsLabel: null,
      congestionLabel: 'Low',
      aisEventCountLabel: '1 AIS disruption',
      officialLatestDate: '2026-08-30',
      officialLatestTotal: 12,
    });
    assert.match(narrative.passage, /source coverage for the Taiwan Strait is partial/);
    assert.match(narrative.passage, /IMF PortWatch counted 12 transits on Aug 30, 2026 \(latest published day\)\. World Monitor cannot verify/);
    assert.match(narrative.passage, /cannot verify operational passage status/);
    assert.doesNotMatch(narrative.passage, / is (?:open|restricted|effectively closed) /);
    assert.match(narrative.scoreDriver, /Observed score inputs: maximum AIS congestion severity Low\./);
    assert.match(narrative.scoreDriver, /Unavailable score inputs: navigational warning count\./);
    assert.doesNotMatch(narrative.scoreDriver, /unavailable[^.]*observed/i);
  });

  it('separates both missing score sources from observed inputs', () => {
    const narrative = chokepointEvidenceNarrative({
      displayName: 'Panama Canal',
      score: 0,
      bandLabel: 'Green',
      description: 'source coverage incomplete',
      partial: true,
      warningsLabel: null,
      congestionLabel: null,
      aisEventCountLabel: null,
    });
    assert.match(narrative.passage, /No IMF PortWatch daily transit count is published for this snapshot/);
    assert.match(narrative.passage, /cannot verify operational passage status/);
    assert.match(narrative.scoreDriver, /Observed score inputs: none available\./);
    assert.match(
      narrative.scoreDriver,
      /Unavailable score inputs: navigational warning count; maximum AIS congestion severity\./,
    );
    assert.match(narrative.scoreDriver, /AIS event count unavailable; IMF PortWatch latest daily count unavailable/);
  });

  it('keeps the traffic anomaly as a score input and filters coverage notes from the baseline', () => {
    for (const description of [
      'No active disruptions',
      'No active disruptions reported by available sources; source coverage incomplete',
      'Threat baseline last reviewed > 120 days ago — review recommended',
    ]) {
      const narrative = chokepointEvidenceNarrative({
        displayName: 'Panama Canal',
        score: 0,
        bandLabel: 'Green',
        description,
        partial: false,
        warningsLabel: '0 warnings',
        congestionLabel: 'Normal',
        aisEventCountLabel: '0 AIS disruptions',
      });
      assert.match(narrative.scoreDriver, /Configured geopolitical baseline: no additional threat weight\./);
      assert.doesNotMatch(narrative.scoreDriver, new RegExp(`baseline: ${description}`));
      assert.match(narrative.passage, /no IMF PortWatch daily transit count is published for the Panama Canal\. The Green disruption score/);
    }
    const anomaly = chokepointEvidenceNarrative({
      displayName: 'Strait of Hormuz',
      score: 80,
      bandLabel: 'Red',
      description: 'Active conflict — blockade risk; Traffic down 55% vs 30-day baseline, vessels may be transiting dark (AIS off)',
      partial: false,
      warningsLabel: '0 warnings',
      congestionLabel: 'Normal',
      aisEventCountLabel: '0 AIS disruptions',
    });
    assert.match(anomaly.scoreDriver, /Configured geopolitical baseline: Active conflict — blockade risk\./);
    assert.match(
      anomaly.scoreDriver,
      /Observed score inputs: 0 warnings; maximum AIS congestion severity Normal; PortWatch daily-transit anomaly: Traffic down 55%/,
    );
    assert.equal(chokepointEvidenceNarrative({ score: null }), null);
  });

  it('aggregates same-period crisis summaries and names missing coverage', () => {
    const countries = [
      { code: 'IR', name: 'Iran' },
      { code: 'IL', name: 'Israel' },
      { code: 'LB', name: 'Lebanon' },
    ];
    const results = [
      {
        code: 'IR',
        payload: {
          summary: {
            countryCode: 'IR',
            countryName: 'Iran',
            conflictEventsTotal: 12,
            conflictPoliticalViolenceEvents: 8,
            conflictFatalities: 4,
            conflictDemonstrations: 2,
            referencePeriod: '2026-06-01',
            updatedAt: NOW - 60_000,
          },
        },
      },
      {
        code: 'IL',
        payload: {
          summary: {
            countryCode: 'IL',
            countryName: 'Israel',
            conflictEventsTotal: 7,
            conflictPoliticalViolenceEvents: 5,
            conflictFatalities: 1,
            conflictDemonstrations: 1,
            referencePeriod: '2026-06-01',
            updatedAt: NOW - 120_000,
          },
        },
      },
      { code: 'LB', error: new Error('unavailable') },
    ];

    const view = crisisTrackerViewModel(results, countries, NOW);
    assert.equal(view.state, 'partial');
    assert.equal(view.eventsTotal, '19');
    assert.equal(view.fatalities, '5');
    assert.equal(view.politicalViolenceEvents, '13');
    assert.equal(view.referencePeriod, '2026-06-01');
    assert.deepEqual(view.missingCountries, ['Lebanon']);
    assert.equal(view.rows.length, 2);

    const mixed = crisisTrackerViewModel([
      results[0],
      {
        ...results[1],
        payload: {
          summary: {
            ...results[1].payload.summary,
            referencePeriod: '2026-05-01',
          },
        },
      },
    ], countries.slice(0, 2), NOW);
    assert.equal(mixed.state, 'partial');
    assert.equal(mixed.eventsTotal, null);
    assert.equal(mixed.referencePeriod, 'Mixed reference periods');
  });

  it('handles ordinary and antimeridian bounds without accepting missing coordinates', () => {
    assert.equal(pointInBounds(35, 140, [31, 129, 46, 146]), true);
    assert.equal(pointInBounds(35, 170, [31, 129, 46, 146]), false);
    assert.equal(pointInBounds(0, 179, [-10, 170, 10, -170]), true);
    assert.equal(pointInBounds(0, -179, [-10, 170, 10, -170]), true);
    assert.equal(pointInBounds(0, 0, [-10, 170, 10, -170]), false);
    assert.equal(pointInBounds(null, 140, [31, 129, 46, 146]), false);
  });

  it('distinguishes an authoritative zero hazard result from unavailable data', () => {
    const empty = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [],
    }, { now: NOW });
    assert.equal(empty.total, '0');
    assert.deepEqual(empty.events, []);

    assert.throws(
      () => hazardPulseViewModel({
        dataAvailable: false,
        fetchedAt: 0,
        events: [],
      }, { now: NOW }),
      /unavailable/i,
    );

    const filtered = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [
        {
          id: 'jp-quake',
          title: 'Offshore earthquake',
          category: 'earthquakes',
          categoryTitle: 'Earthquakes',
          lat: 35,
          lon: 140,
          date: NOW - 3_600_000,
          magnitude: 6.2,
          magnitudeUnit: 'Mw',
          sourceName: 'USGS',
          closed: false,
        },
        {
          id: 'old-closed',
          title: 'Closed storm',
          category: 'severeStorms',
          categoryTitle: 'Severe Storms',
          lat: 34,
          lon: 139,
          date: NOW - 7_200_000,
          sourceName: 'GDACS',
          closed: true,
        },
        {
          id: 'outside',
          title: 'Distant volcano',
          category: 'volcanoes',
          categoryTitle: 'Volcanoes',
          lat: 0,
          lon: 0,
          date: NOW - 1_800_000,
          sourceName: 'EONET',
          closed: false,
        },
      ],
    }, { now: NOW, bounds: [31, 129, 46, 146] });
    assert.equal(filtered.total, '1');
    assert.equal(filtered.categories, 'Earthquakes 1');
    assert.equal(filtered.strongest, '6.2 Mw');
    assert.equal(filtered.events[0].source, 'USGS');

    assert.throws(
      () => hazardPulseViewModel({
        dataAvailable: true,
        fetchedAt: NOW - 60_000,
        events: [{ id: 'malformed', closed: false, lat: null, lon: 140, date: NOW - 60_000 }],
      }, { now: NOW }),
      /observations are malformed/i,
    );

    const boundedZero = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [{ id: 'outside-stale', closed: false, lat: 0, lon: 0, date: 0 }],
    }, { now: NOW, bounds: [31, 129, 46, 146] });
    assert.equal(boundedZero.total, '0');

    const mixedUnits = hazardPulseViewModel({
      dataAvailable: true,
      fetchedAt: NOW - 60_000,
      events: [
        {
          id: 'quake',
          title: 'Earthquake',
          categoryTitle: 'Earthquakes',
          lat: 35,
          lon: 140,
          date: NOW - 60_000,
          magnitude: 6.2,
          magnitudeUnit: 'Mw',
          sourceName: 'USGS',
        },
        {
          id: 'storm',
          title: 'Storm',
          categoryTitle: 'Severe Storms',
          lat: 34,
          lon: 139,
          date: NOW - 120_000,
          magnitude: 80,
          magnitudeUnit: 'kt',
          sourceName: 'NHC',
        },
      ],
    }, { now: NOW });
    assert.equal(mixedUnits.strongest, 'Mixed units — see events');
  });

  it('keeps unknown airport coverage separate from disruption', () => {
    const view = airportDisruptionViewModel({
      alerts: [
        {
          iata: 'NRT',
          name: 'Narita',
          location: { latitude: 35.77, longitude: 140.39 },
          severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
          avgDelayMinutes: 55,
          reason: 'Weather',
          source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
          updatedAt: NOW - 60_000,
        },
        {
          iata: 'HND',
          name: 'Haneda',
          location: { latitude: 35.55, longitude: 139.78 },
          severity: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
          source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
          updatedAt: NOW - 60_000,
        },
        {
          iata: 'KIX',
          name: 'Kansai',
          location: { latitude: 34.43, longitude: 135.24 },
          severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
          source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
          updatedAt: NOW - 60_000,
        },
        {
          iata: 'NGO',
          name: 'Chubu Centrair',
          location: { latitude: 34.86, longitude: 136.81 },
          severity: 'FLIGHT_DELAY_SEVERITY_FUTURE_VALUE',
          source: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
          updatedAt: NOW - 60_000,
        },
      ],
    }, [31, 129, 46, 146], NOW);

    assert.equal(view.monitored, '4');
    assert.equal(view.disrupted, '1');
    assert.equal(view.normal, '1');
    assert.equal(view.unknown, '2');
    assert.equal(view.alerts[0].iata, 'NRT');

    assert.throws(
      () => airportDisruptionViewModel({
        alerts: [{
          iata: 'NRT',
          name: 'Narita',
          location: { latitude: 35.77, longitude: 140.39 },
          severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
          avgDelayMinutes: 55,
          source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
          updatedAt: NOW - (25 * 60 * 60 * 1_000),
        }],
      }, [31, 129, 46, 146], NOW),
      /coverage is unavailable/i,
    );

    assert.throws(
      () => airportDisruptionViewModel({
        alerts: [
          {
            iata: 'NRT',
            name: 'Narita',
            location: { latitude: 35.77, longitude: 140.39 },
            severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
            updatedAt: NOW - (25 * 60 * 60 * 1_000),
          },
          {
            iata: 'LAX',
            name: 'Los Angeles',
            location: { latitude: 33.94, longitude: -118.4 },
            severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
            updatedAt: NOW - 60_000,
          },
        ],
      }, [31, 129, 46, 146], NOW),
      /coverage is unavailable/i,
      'fresh observations outside the selected bounds must not validate stale in-bounds coverage',
    );
  });

  it('treats an empty military response as unavailable and labels returned observations', () => {
    assert.throws(
      () => militaryFlightsViewModel({ flights: [] }, NOW),
      /unavailable/i,
    );

    const view = militaryFlightsViewModel({
      flights: [
        {
          id: 'A1',
          callsign: 'RCH123',
          aircraftType: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT',
          operator: 'MILITARY_OPERATOR_USAF',
          lastSeenAt: NOW - 60_000,
          isInteresting: false,
        },
        {
          id: 'A2',
          callsign: 'FORTE10',
          aircraftType: 'MILITARY_AIRCRAFT_TYPE_RECONNAISSANCE',
          operator: 'MILITARY_OPERATOR_USAF',
          lastSeenAt: NOW - 30_000,
          isInteresting: true,
        },
      ],
    }, NOW);

    assert.equal(view.returned, '2');
    assert.equal(view.interesting, '1');
    assert.equal(view.latestSeenAt, NOW - 30_000);
    assert.equal(view.flights[0].aircraftType, 'Reconnaissance');
  });

  it('mints an anonymous session before a session-gated live request', async () => {
    const calls = [];
    const responses = [
      anonymousSessionResponse(),
      { ok: true, status: 200, json: async () => ({ value: 42 }) },
    ];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET', credentials: options.credentials });
      return responses.shift();
    };

    const payload = await requestLiveJson('/api/example', {
      fetchImpl,
      preflightSession: true,
    });
    assert.deepEqual(payload, { value: 42 });
    assert.deepEqual(calls, [
      { url: '/api/wm-session', method: 'POST', credentials: 'include' },
      { url: '/api/example', method: 'GET', credentials: 'include' },
    ]);
  });

  it('reuses a fresh anonymous session for serial protected requests', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url === '/api/wm-session') return anonymousSessionResponse();
      return { ok: true, status: 200, json: async () => ({ url }) };
    };

    await requestLiveJson('/api/one', { fetchImpl, preflightSession: true });
    await requestLiveJson('/api/two', { fetchImpl, preflightSession: true });
    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/wm-session',
      '/api/one',
      '/api/two',
    ]);
  });

  it('reuses a fresh anonymous session when browser storage is unavailable', async () => {
    globalThis.sessionStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url === '/api/wm-session') return anonymousSessionResponse();
      return { ok: true, status: 200, json: async () => ({ url }) };
    };

    await requestLiveJson('/api/one', { fetchImpl, preflightSession: true });
    await requestLiveJson('/api/two', { fetchImpl, preflightSession: true });
    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/wm-session',
      '/api/one',
      '/api/two',
    ]);
  });

  it('refreshes a stored session after a protected request returns 401', async () => {
    globalThis.sessionStorage.setItem(
      'wm-session-exp',
      JSON.stringify({ exp: Date.now() + 60 * 60 * 1000 }),
    );
    const calls = [];
    const responses = [
      { ok: false, status: 401 },
      anonymousSessionResponse(),
      { ok: true, status: 200, json: async () => ({ value: 42 }) },
    ];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      return responses.shift();
    };

    assert.deepEqual(
      await requestLiveJson('/api/example', { fetchImpl, preflightSession: true }),
      { value: 42 },
    );
    assert.deepEqual(calls, [
      { url: '/api/example', method: 'GET' },
      { url: '/api/wm-session', method: 'POST' },
      { url: '/api/example', method: 'GET' },
    ]);
  });

  it('does not send a session-gated live request when session minting fails', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET', credentials: options.credentials });
      return { ok: false, status: 503 };
    };

    await assert.rejects(
      requestLiveJson('/api/example', { fetchImpl, preflightSession: true }),
      /Anonymous session request failed \(503\)/,
    );
    assert.deepEqual(calls, [
      { url: '/api/wm-session', method: 'POST', credentials: 'include' },
    ]);
  });

  it('coalesces concurrent session preflights before protected request fan-out', async () => {
    const calls = [];
    let releaseSession;
    const sessionResponse = new Promise((resolve) => {
      releaseSession = resolve;
    });
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET', credentials: options.credentials });
      if (url === '/api/wm-session') return sessionResponse;
      return { ok: true, status: 200, json: async () => ({ url }) };
    };

    const requests = [
      requestLiveJson('/api/one', { fetchImpl, preflightSession: true }),
      requestLiveJson('/api/two', { fetchImpl, preflightSession: true }),
    ];
    await Promise.resolve();
    assert.equal(
      calls.filter(({ url }) => url === '/api/wm-session').length,
      1,
      'concurrent protected calls should share one session mint',
    );

    releaseSession(anonymousSessionResponse());
    assert.deepEqual(await Promise.all(requests), [
      { url: '/api/one' },
      { url: '/api/two' },
    ]);
    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/wm-session',
      '/api/one',
      '/api/two',
    ]);
  });

  it('does not remint for a late 401 after another request refreshed the session', async () => {
    let resolveFirst;
    let resolveSecond;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    let resolveFirstRetryStarted;
    const firstRetryStarted = new Promise((resolve) => {
      resolveFirstRetryStarted = resolve;
    });
    const calls = [];
    const requestCounts = new Map();
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url === '/api/wm-session') return anonymousSessionResponse();
      const count = (requestCounts.get(url) || 0) + 1;
      requestCounts.set(url, count);
      if (count > 1) {
        if (url === '/api/one') resolveFirstRetryStarted();
        return { ok: true, status: 200, json: async () => ({ url }) };
      }
      return url === '/api/one' ? firstResponse : secondResponse;
    };

    const requests = [
      requestLiveJson('/api/one', { fetchImpl, preflightSession: true }),
      requestLiveJson('/api/two', { fetchImpl, preflightSession: true }),
    ];
    await Promise.resolve();
    resolveFirst({ ok: false, status: 401 });
    await firstRetryStarted;
    resolveSecond({ ok: false, status: 401 });
    assert.deepEqual(await Promise.all(requests), [
      { url: '/api/one' },
      { url: '/api/two' },
    ]);
    assert.equal(
      calls.filter(({ url }) => url === '/api/wm-session').length,
      2,
      'the late 401 should reuse the newer session generation',
    );
  });

  it('mints an anonymous session after a 401 and retries the original request once', async () => {
    const calls = [];
    const responses = [
      { ok: false, status: 401 },
      anonymousSessionResponse(),
      { ok: true, status: 200, json: async () => ({ value: 42 }) },
    ];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET', credentials: options.credentials });
      return responses.shift();
    };

    const payload = await requestLiveJson('/api/example', { fetchImpl });
    assert.deepEqual(payload, { value: 42 });
    assert.deepEqual(calls, [
      { url: '/api/example', method: 'GET', credentials: 'include' },
      { url: '/api/wm-session', method: 'POST', credentials: 'include' },
      { url: '/api/example', method: 'GET', credentials: 'include' },
    ]);
  });

  it('aborts a live request at the configured request bound', async () => {
    const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('request aborted')), {
        once: true,
      });
    });

    await assert.rejects(
      requestLiveJson('/api/slow', { fetchImpl, timeoutMs: 10 }),
      /timed out/i,
    );
  });

  it('keeps the request bound active while decoding the response body', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise((resolve) => {
        setTimeout(() => resolve({ tooLate: true }), 50);
      }),
    });

    await assert.rejects(
      requestLiveJson('/api/slow-body', { fetchImpl, timeoutMs: 10 }),
      /timed out/i,
    );
  });

  it('keeps the latest hazard handoff when its live request fails', async () => {
    const select = {
      value: 'JP',
      selectedOptions: [{ dataset: { bounds: '31,129,46,146' } }],
    };
    const dashboardLink = { href: '/dashboard?country=NO&expanded=1' };
    const tool = {
      dataset: {},
      querySelector(selector) {
        if (selector === '[data-country-select]') return select;
        return null;
      },
      querySelectorAll() {
        return [];
      },
      ownerDocument: {
        querySelector(selector) {
          return selector === '[data-dashboard-link]' ? dashboardLink : null;
        },
      },
    };
    const replacedUrls = [];
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href: 'https://www.worldmonitor.app/tools/natural-hazard-pulse/?country=NO' },
      history: {
        replaceState(_state, _title, url) {
          replacedUrls.push(url);
        },
      },
    };
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    try {
      await loadHazards(tool);
      assert.deepEqual(replacedUrls, ['/tools/natural-hazard-pulse/?country=JP']);
      assert.equal(dashboardLink.href, '/dashboard?country=JP&expanded=1');
      select.value = '';
      await loadHazards(tool);
      assert.equal(dashboardLink.href, '/dashboard');
      assert.equal(replacedUrls.at(-1), '/tools/natural-hazard-pulse/');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });

  it('labels a loaded country reading in plain words and stamps it in UTC', async () => {
    // The static page prints UTC. Formatting the live stamp in the reader's
    // zone put "GMT+4" next to a "UTC" header on the same page.
    const previousTz = process.env.TZ;
    process.env.TZ = 'Asia/Dubai';
    const window = new Window({ url: 'https://www.worldmonitor.app/countries/egypt/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-country-risk data-country-code="EG" data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid aria-busy="false">
          <div class="metric"><strong><span data-live-score>27</span><small data-live-band>Low</small></strong></div>
          <div class="metric"><strong data-live-trend>Falling -2</strong></div>
          <div class="metric"><strong data-live-advisory>Level 2</strong></div>
          <div class="metric"><strong data-live-sanctions>None in feed</strong></div>
        </div>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
      </section>
    `;
    const tool = document.querySelector('[data-live-country-risk]');
    const computedAt = Date.now() - 60_000;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('get-country-risk')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            advisoryLevel: 'caution',
            sanctionsActive: false,
            sanctionsCount: 0,
            fetchedAt: computedAt,
            cii: {
              combinedScore: 24,
              dynamicScore: 0,
              trend: 'TREND_DIRECTION_UNSPECIFIED',
              computedAt,
              methodologyVersion: 'v8',
            },
          }),
        };
      }
      return anonymousSessionResponse();
    };
    try {
      await loadCountryRisk(tool);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }

    assert.equal(tool.dataset.state, 'ready');
    assert.equal(tool.querySelector('[data-live-status]').textContent, 'Live reading');
    assert.equal(tool.querySelector('[data-live-trend]').textContent, 'No earlier reading');
    const stamp = tool.querySelector('[data-live-updated]').textContent;
    assert.match(stamp, /^Computed .+ UTC · methodology v8$/);
    assert.doesNotMatch(stamp, /GMT/);
  });

  it('preserves SSR country and chokepoint pulse values when live refresh fails', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/countries/ukraine/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-country-risk data-country-code="UA" data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid aria-busy="false">
          <div class="metric"><strong><span data-live-score>71.4</span><small data-live-band>Elevated</small></strong></div>
          <div class="metric"><strong data-live-trend>+1.2</strong></div>
          <div class="metric"><strong data-live-advisory>Level 4</strong></div>
          <div class="metric"><strong data-live-sanctions>12</strong></div>
        </div>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
        <button type="button" data-live-refresh>Refresh</button>
      </section>
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="hormuz_strait" data-state="ready">
        <h2>Is Strait of Hormuz open right now?</h2>
        <p data-chokepoint-open-status>Published passage evidence.</p>
        <p data-chokepoint-score-driver>Published score inputs.</p>
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid aria-busy="false">
          <div class="metric"><strong><span data-chokepoint-score>72</span><small data-chokepoint-band>Red</small></strong></div>
          <div class="metric"><strong data-chokepoint-congestion>High</strong></div>
          <div class="metric"><strong data-chokepoint-warnings>3 warnings</strong></div>
          <div class="metric"><strong><span data-chokepoint-official-transits>11</span><small data-chokepoint-official-date>Aug 26, 2026</small></strong></div>
          <div class="metric"><strong data-chokepoint-official-average>12.3 a day</strong></div>
          <div class="metric"><strong data-chokepoint-movement>+2.5%</strong></div>
        </div>
        <p data-chokepoint-description>Elevated shipping warnings.</p>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
        <button type="button" data-live-refresh>Refresh</button>
      </section>
    `;

    const country = document.querySelector('[data-live-country-risk]');
    const chokepoint = document.querySelector('[data-live-chokepoint]');
    assert.equal(hasPublishedLivePulse(country), true);
    assert.equal(hasPublishedLivePulse(chokepoint), true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    try {
      await loadCountryRisk(country);
      await loadChokepoint(chokepoint);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(country.querySelector('[data-live-score]').textContent, '71.4');
    assert.equal(country.querySelector('[data-live-band]').textContent, 'Elevated');
    assert.equal(country.querySelector('[data-live-updated]').getAttribute('datetime'), '2026-08-30T12:00:00.000Z');
    assert.match(country.querySelector('[data-live-status]').textContent, /published pulse/i);
    assert.equal(country.dataset.state, 'error');

    assert.equal(chokepoint.querySelector('[data-chokepoint-score]').textContent, '72');
    assert.equal(chokepoint.querySelector('[data-chokepoint-band]').textContent, 'Red');
    assert.equal(
      chokepoint.querySelector('[data-chokepoint-open-status]').textContent,
      'Published passage evidence.',
    );
    assert.equal(
      chokepoint.querySelector('[data-chokepoint-score-driver]').textContent,
      'Published score inputs.',
    );
    assert.equal(chokepoint.querySelector('[data-live-updated]').getAttribute('datetime'), '2026-08-30T12:00:00.000Z');
    assert.match(chokepoint.querySelector('[data-live-status]').textContent, /published pulse/i);
    assert.equal(chokepoint.dataset.state, 'error');
  });

  it('preserves published CII rankings when live refresh fails before hydrate', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/country-instability-index/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-cii-ranking data-cii-methodology-version="v8" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div data-live-grid aria-busy="false">
          <table data-cii-ranking>
            <tbody data-cii-ranking-body>
              <tr data-cii-country="BR"><td>Brazil</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
              <tr data-cii-country="AE"><td>United Arab Emirates</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
            </tbody>
          </table>
        </div>
        <time data-cii-ranking-updated datetime="2026-08-30T12:00:00.000Z">Latest published score Aug 30, 2026</time>
      </section>
    `;
    const tool = document.querySelector('[data-live-cii-ranking]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    try {
      await loadCiiRanking(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const codes = [...tool.querySelectorAll('[data-cii-country]')].map((row) => row.dataset.ciiCountry);
    assert.deepEqual(codes, ['BR', 'AE']);
    assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').textContent, '50');
    assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').getAttribute('value'), '50');
    assert.equal(
      tool.querySelector('[data-cii-country="AE"] [data-cii-updated]').getAttribute('datetime'),
      '2026-08-30T12:00:00.000Z',
    );
    assert.equal(
      tool.querySelector('[data-live-status]').textContent,
      'Live refresh unavailable — showing published rankings',
    );
    assert.equal(tool.dataset.state, 'error');
  });

  it('keeps last loaded CII rankings after a later failed refresh', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/country-instability-index/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-cii-ranking data-cii-methodology-version="v8" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div data-live-grid aria-busy="false">
          <table data-cii-ranking>
            <tbody data-cii-ranking-body>
              <tr data-cii-country="BR"><td>Brazil</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
              <tr data-cii-country="AE"><td>United Arab Emirates</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
            </tbody>
          </table>
        </div>
        <time data-cii-ranking-updated datetime="2026-08-30T12:00:00.000Z">Latest published score Aug 30, 2026</time>
      </section>
    `;
    const tool = document.querySelector('[data-live-cii-ranking]');
    const originalFetch = globalThis.fetch;
    let phase = 'hydrate';
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/wm-session')) return anonymousSessionResponse();
      if (phase === 'hydrate') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            degraded: false,
            stale: false,
            ciiScores: [
              {
                region: 'AE',
                combinedScore: 61,
                dynamicScore: 1.5,
                trend: 'TREND_DIRECTION_RISING',
                computedAt: Date.now() - 30_000,
                methodologyVersion: 'v8',
              },
              {
                region: 'BR',
                combinedScore: 61,
                dynamicScore: -0.5,
                trend: 'TREND_DIRECTION_FALLING',
                computedAt: Date.now() - 45_000,
                methodologyVersion: 'v8',
              },
            ],
          }),
        };
      }
      throw new Error('offline');
    };
    try {
      await loadCiiRanking(tool);
      assert.deepEqual(
        [...tool.querySelectorAll('[data-cii-country]')].map((row) => row.dataset.ciiCountry),
        ['BR', 'AE'],
        'tied live scores must keep the published country order',
      );
      assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').textContent, '61');
      assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').getAttribute('value'), '61');
      assert.equal(tool.dataset.ciiHydrated, 'true');
      assert.equal(tool.querySelector('[data-live-status]').textContent, 'Live reading · v8');

      phase = 'fail';
      await loadCiiRanking(tool);
      assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').textContent, '61');
      assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').getAttribute('value'), '61');
      assert.equal(
        tool.querySelector('[data-live-status]').textContent,
        'Live refresh unavailable — showing last loaded rankings',
      );
      assert.equal(tool.dataset.state, 'error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps published CII rows when the live country set does not match', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/country-instability-index/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-cii-ranking data-cii-methodology-version="v8" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div data-live-grid aria-busy="false">
          <table data-cii-ranking>
            <tbody data-cii-ranking-body>
              <tr data-cii-country="BR"><td>Brazil</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
              <tr data-cii-country="AE"><td>United Arab Emirates</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
            </tbody>
          </table>
        </div>
        <time data-cii-ranking-updated datetime="2026-08-30T12:00:00.000Z">Latest published score Aug 30, 2026</time>
      </section>
    `;
    const tool = document.querySelector('[data-live-cii-ranking]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/wm-session')) return anonymousSessionResponse();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          degraded: false,
          stale: false,
          ciiScores: [
            {
              region: 'IR',
              combinedScore: 67,
              dynamicScore: 7,
              trend: 'TREND_DIRECTION_RISING',
              computedAt: Date.now() - 60_000,
              methodologyVersion: 'v8',
            },
          ],
        }),
      };
    };
    try {
      await loadCiiRanking(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(
      [...tool.querySelectorAll('[data-cii-country]')].map((row) => row.dataset.ciiCountry),
      ['BR', 'AE'],
    );
    assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').textContent, '50');
    assert.equal(
      tool.querySelector('[data-live-status]').textContent,
      'Live refresh unavailable — showing published rankings',
    );
    assert.equal(tool.dataset.state, 'error');
  });

  it('keeps published CII rows when the live methodology does not match', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/country-instability-index/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-cii-ranking data-cii-methodology-version="v8" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div data-live-grid aria-busy="false">
          <table data-cii-ranking>
            <tbody data-cii-ranking-body>
              <tr data-cii-country="BR"><td>Brazil</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
              <tr data-cii-country="AE"><td>United Arab Emirates</td><td><data data-cii-score value="50">50</data></td><td data-cii-trend>Stable</td><td data-cii-band>Normal</td><td><time data-cii-updated datetime="2026-08-30T12:00:00.000Z">Aug 30, 2026</time></td></tr>
            </tbody>
          </table>
        </div>
        <time data-cii-ranking-updated datetime="2026-08-30T12:00:00.000Z">Latest published score Aug 30, 2026</time>
      </section>
    `;
    const tool = document.querySelector('[data-live-cii-ranking]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/wm-session')) return anonymousSessionResponse();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          degraded: false,
          stale: false,
          ciiScores: [
            {
              region: 'AE',
              combinedScore: 61,
              dynamicScore: 1.5,
              trend: 'TREND_DIRECTION_RISING',
              computedAt: Date.now() - 30_000,
              methodologyVersion: 'v9',
            },
            {
              region: 'BR',
              combinedScore: 60,
              dynamicScore: -0.5,
              trend: 'TREND_DIRECTION_FALLING',
              computedAt: Date.now() - 45_000,
              methodologyVersion: 'v9',
            },
          ],
        }),
      };
    };
    try {
      await loadCiiRanking(tool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(
      [...tool.querySelectorAll('[data-cii-country]')].map((row) => row.dataset.ciiCountry),
      ['BR', 'AE'],
    );
    assert.equal(tool.querySelector('[data-cii-country="AE"] [data-cii-score]').textContent, '50');
    assert.equal(tool.querySelector('[data-cii-ranking-updated]').getAttribute('datetime'), '2026-08-30T12:00:00.000Z');
    assert.equal(tool.dataset.ciiHydrated, undefined);
    assert.equal(tool.dataset.state, 'error');
  });

  it('keeps SSR datetime after an undated partial country hydrate so later soft failures preserve sub-signals', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/countries/andorra/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-country-risk data-country-code="AD" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid aria-busy="false">
          <div class="metric"><strong><span data-live-score>—</span><small data-live-band>No current score</small></strong></div>
          <div class="metric"><strong data-live-trend>Unavailable</strong></div>
          <div class="metric"><strong data-live-advisory>Exercise Normal Precautions</strong></div>
          <div class="metric"><strong data-live-sanctions>None in feed</strong></div>
        </div>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
        <button type="button" data-live-refresh>Refresh</button>
      </section>
    `;
    const tool = document.querySelector('[data-live-country-risk]');
    const originalFetch = globalThis.fetch;
    let phase = 'partial';
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/wm-session')) return anonymousSessionResponse();
      if (phase === 'partial') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upstreamUnavailable: false,
            advisoryLevel: 'Exercise Increased Caution',
            sanctionsCount: 2,
            fetchedAt: 0,
            cii: undefined,
          }),
        };
      }
      throw new Error('offline');
    };
    try {
      await loadCountryRisk(tool);
      assert.equal(
        tool.querySelector('[data-live-updated]').getAttribute('datetime'),
        '2026-08-30T12:00:00.000Z',
        'undated partial must retain the SSR datetime marker',
      );
      assert.equal(tool.querySelector('[data-live-advisory]').textContent, 'Exercise Increased Caution');
      assert.equal(hasPublishedLivePulse(tool), true);

      phase = 'fail';
      await loadCountryRisk(tool);
      assert.equal(tool.querySelector('[data-live-advisory]').textContent, 'Exercise Increased Caution');
      assert.equal(tool.querySelector('[data-live-sanctions]').textContent, '2 designated entities');
      // This tile has no numeric score on screen (it SSR'd partial), so the
      // status must not claim the published pulse is being shown.
      assert.equal(
        tool.querySelector('[data-live-status]').textContent,
        'Live refresh unavailable — advisory and sanctions only',
      );
      assert.equal(tool.dataset.state, 'error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not claim a published pulse is shown after a partial hydrate wiped the score', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/countries/ukraine/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-country-risk data-country-code="UA" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid aria-busy="false">
          <div class="metric"><strong><span data-live-score>62</span><small data-live-band>Elevated</small></strong></div>
          <div class="metric"><strong data-live-trend>+1.2</strong></div>
          <div class="metric"><strong data-live-advisory>Do Not Travel</strong></div>
          <div class="metric"><strong data-live-sanctions>12 designated entities</strong></div>
        </div>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
        <button type="button" data-live-refresh>Refresh</button>
      </section>
    `;
    const tool = document.querySelector('[data-live-country-risk]');
    const originalFetch = globalThis.fetch;
    let phase = 'ready';
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/wm-session')) return anonymousSessionResponse();
      if (phase === 'ready') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upstreamUnavailable: false,
            advisoryLevel: 'Do Not Travel',
            sanctionsCount: 12,
            fetchedAt: Date.now(),
            cii: undefined,
          }),
        };
      }
      throw new Error('offline');
    };
    try {
      // Positive control: while the published score is still on screen, the
      // preserve path may legitimately claim it.
      assert.match(tool.querySelector('[data-live-score]').textContent, /\d/);

      // A partial hydrate replaces the published score with an em-dash...
      await loadCountryRisk(tool);
      assert.equal(tool.querySelector('[data-live-score]').textContent, '—');

      // ...so a later soft failure must not assert the published pulse is visible.
      phase = 'fail';
      await loadCountryRisk(tool);
      assert.equal(
        tool.querySelector('[data-live-status]').textContent,
        'Live refresh unavailable — advisory and sanctions only',
        'must not claim "showing published pulse" once the score has been wiped',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('labels a retained SSR stamp as the published pulse, not a live retrieval', async () => {
    const window = new Window({ url: 'https://www.worldmonitor.app/countries/andorra/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-country-risk data-country-code="AD" data-published-pulse data-state="ready">
        <span class="live-status" data-live-status>Published pulse</span>
        <div class="grid" data-live-grid aria-busy="false">
          <div class="metric"><strong><span data-live-score>—</span><small data-live-band>No current score</small></strong></div>
          <div class="metric"><strong data-live-trend>Unavailable</strong></div>
          <div class="metric"><strong data-live-advisory>Exercise Normal Precautions</strong></div>
          <div class="metric"><strong data-live-sanctions>None in feed</strong></div>
        </div>
        <time data-live-updated datetime="2026-08-30T12:00:00.000Z">Published pulse Aug 30, 2026</time>
        <button type="button" data-live-refresh>Refresh</button>
      </section>
    `;
    const tool = document.querySelector('[data-live-country-risk]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/wm-session')) return anonymousSessionResponse();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          upstreamUnavailable: false,
          advisoryLevel: 'Exercise Increased Caution',
          sanctionsCount: 2,
          fetchedAt: 0,
          cii: undefined,
        }),
      };
    };
    try {
      await loadCountryRisk(tool);
      const updated = tool.querySelector('[data-live-updated]').textContent;
      // The advisory below was fetched just now; the retained stamp belongs to
      // the published pulse, so it must not be labelled "Retrieved".
      assert.doesNotMatch(updated, /^Retrieved/, `stale stamp labelled as a live retrieval: ${updated}`);
      assert.match(updated, /^Published pulse /);
      assert.match(updated, /refreshed live/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('commits counters, URL, and dashboard link only for the latest request', async () => {
    const tool = {};
    const rendered = {
      counter: null,
      url: null,
      dashboardLink: null,
    };
    let resolveFirst;

    const first = runLatestToolRequest(
      tool,
      () => new Promise((resolve) => {
        resolveFirst = resolve;
      }),
      (value) => Object.assign(rendered, value),
    );
    const second = runLatestToolRequest(
      tool,
      async () => ({
        counter: 2,
        url: '/tools/natural-hazard-pulse/?country=JP',
        dashboardLink: '/dashboard?country=JP&expanded=1',
      }),
      (value) => Object.assign(rendered, value),
    );

    await second;
    resolveFirst({
      counter: 99,
      url: '/tools/natural-hazard-pulse/?country=US',
      dashboardLink: '/dashboard?country=US&expanded=1',
    });
    await first;

    assert.deepEqual(rendered, {
      counter: 2,
      url: '/tools/natural-hazard-pulse/?country=JP',
      dashboardLink: '/dashboard?country=JP&expanded=1',
    });
  });
});

describe('Pentagon Pizza Index live reading', () => {
  const UPDATED = NOW - 10 * 60_000;

  function venue(overrides) {
    return {
      placeId: overrides.name,
      address: '',
      currentPopularity: 40,
      percentageOfUsual: 100,
      hasBaseline: true,
      noLiveSignal: false,
      isSpike: false,
      dataSource: 'besttime',
      recordedAt: new Date(UPDATED).toISOString(),
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      isClosedNow: false,
      ...overrides,
    };
  }

  function payload(overrides = {}, venues = null) {
    return {
      pizzint: {
        defconLevel: 4,
        defconLabel: 'Above Normal',
        aggregateActivity: 52,
        activeSpikes: 1,
        locationsMonitored: 6,
        locationsOpen: 4,
        updatedAt: UPDATED,
        dataFreshness: 'DATA_FRESHNESS_FRESH',
        locations: venues ?? [
          venue({ name: 'Spike Pizza', percentageOfUsual: 190, isSpike: true }),
          venue({ name: 'Busy Pizza', percentageOfUsual: 142 }),
          venue({ name: 'Quiet Pizza', percentageOfUsual: 64 }),
          venue({ name: 'Usual Pizza', percentageOfUsual: 108 }),
          venue({ name: 'Closed Pizza', isClosedNow: true, currentPopularity: 0, percentageOfUsual: 0 }),
          venue({ name: 'Dark Pizza', noLiveSignal: true, currentPopularity: 0, percentageOfUsual: 0 }),
          venue({ name: 'Live-only Pizza', hasBaseline: false, percentageOfUsual: 0 }),
          venue({ name: 'Empty Pizza', percentageOfUsual: 0 }),
        ],
        ...overrides,
      },
      tensionPairs: [],
    };
  }

  it('labels the level and every venue the way the dashboard header does', () => {
    const view = pizzIntViewModel(payload(), NOW);
    assert.equal(view.available, true);
    assert.equal(view.level, '4');
    assert.equal(view.label, 'Above Normal');
    assert.equal(view.updatedAt, UPDATED);
    assert.deepEqual(view.venues, [
      { name: 'Spike Pizza', status: 'Spike +90%' },
      { name: 'Busy Pizza', status: '+42% vs usual' },
      { name: 'Quiet Pizza', status: '−36% vs usual' },
      { name: 'Usual Pizza', status: 'Normal' },
      { name: 'Closed Pizza', status: 'Closed' },
      { name: 'Dark Pizza', status: 'No data' },
      { name: 'Live-only Pizza', status: 'No baseline' },
      // A valid zero against a known forecast is a measured -100%, not missing.
      { name: 'Empty Pizza', status: '−100% vs usual' },
    ]);
  });

  it('takes the activity label from the level, not the payload text', () => {
    const view = pizzIntViewModel(payload({ defconLevel: 1, defconLabel: 'anything' }), NOW);
    assert.equal(view.level, '1');
    assert.equal(view.label, 'Maximum Activity');
  });

  it('reports no current reading when the seed has expired', () => {
    // The relay publishes nothing without a live reading, so the seed expires
    // and the API answers with tension pairs only (observed 2026-10-16).
    const view = pizzIntViewModel({ tensionPairs: [] }, NOW);
    assert.equal(view.available, false);
    assert.equal(view.level, '—');
    assert.equal(view.label, 'No current reading');
    assert.deepEqual(view.venues, []);
  });

  it('needs a fresh open venue before a level counts as current', () => {
    // The relay publishes closed-only polls (tests/pizzint-seed-publication.test.mjs)
    // but does not treat them as live; the page FAQ promises the same rule.
    const closedOnly = payload({ defconLevel: 5 }, [
      venue({ name: 'Closed A', isClosedNow: true, currentPopularity: 0, percentageOfUsual: 0 }),
      venue({ name: 'Closed B', isClosedNow: true, currentPopularity: 0, percentageOfUsual: 0 }),
      venue({ name: 'Dark C', noLiveSignal: true, currentPopularity: 0, percentageOfUsual: 0 }),
      venue({ name: 'Stale D', dataFreshness: 'DATA_FRESHNESS_STALE', percentageOfUsual: 120 }),
    ]);
    assert.equal(pizzIntViewModel(closedOnly, NOW).available, false);
  });

  it('marks a stale venue row as no data inside a current reading', () => {
    const view = pizzIntViewModel(payload({}, [
      venue({ name: 'Fresh Pizza', percentageOfUsual: 130 }),
      venue({ name: 'Stale Pizza', dataFreshness: 'DATA_FRESHNESS_STALE', percentageOfUsual: 150 }),
      venue({ name: 'Stale Closed', dataFreshness: 'DATA_FRESHNESS_STALE', isClosedNow: true }),
    ]), NOW);
    assert.equal(view.available, true);
    assert.deepEqual(view.venues.map((row) => row.status), ['+30% vs usual', 'No data', 'No data']);
  });

  it('refreshes before a shown reading outlives its age limit', () => {
    const fresh = { available: true, updatedAt: NOW - 55 * 60_000 };
    assert.equal(pizzIntRefreshDelay(fresh, NOW), 5 * 60_000);
    assert.equal(pizzIntRefreshDelay({ available: true, updatedAt: NOW - 60_000 }, NOW), 15 * 60_000);
    assert.equal(pizzIntRefreshDelay({ available: false, updatedAt: null }, NOW), 15 * 60_000);
    // A reading 30 s from its limit reloads then, not after the 1-minute floor.
    assert.equal(pizzIntRefreshDelay({ available: true, updatedAt: NOW - (60 * 60_000 - 30_000) }, NOW), 30_000);
    // Never a tight loop, even for a reading already at its limit.
    assert.equal(pizzIntRefreshDelay({ available: true, updatedAt: NOW - 70 * 60_000 }, NOW), 60_000);
  });

  it('does not present a stale or old reading as current', () => {
    assert.equal(pizzIntViewModel(payload({ dataFreshness: 'DATA_FRESHNESS_STALE' }), NOW).available, false);
    assert.equal(pizzIntViewModel(payload({ updatedAt: NOW - 61 * 60_000 }), NOW).available, false);
    assert.equal(pizzIntViewModel(payload({ locationsMonitored: 0 }, []), NOW).available, false);
  });

  it('rejects a malformed level instead of guessing one', () => {
    assert.throws(() => pizzIntViewModel(payload({ defconLevel: 0 }), NOW));
    assert.throws(() => pizzIntViewModel(payload({ defconLevel: '3' }), NOW));
    assert.throws(() => pizzIntViewModel({ pizzint: 'busy' }, NOW));
  });

  function pizzaTool() {
    const window = new Window({ url: 'https://www.worldmonitor.app/blog/glossary/pentagon-pizza-index/' });
    const { document } = window;
    document.body.innerHTML = `
      <section class="live-tool" data-live-pizzint data-state="loading">
        <span data-live-status>Loading the live level…</span>
        <p data-live-fallback>The live level loads in your browser.</p>
        <div data-live-grid hidden aria-busy="true">
          <strong data-pizzint-level>—</strong>
          <span data-pizzint-label></span>
          <ul data-pizzint-venues></ul>
        </div>
        <time data-live-updated></time>
        <button type="button" data-live-refresh>Refresh</button>
      </section>
    `;
    return document.querySelector('[data-live-pizzint]');
  }

  async function withFetch(handler, run) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('hydrates the level, venues, and UTC stamp through the session-gated route', async () => {
    const tool = pizzaTool();
    const fresh = payload({ updatedAt: Date.now() - 5 * 60_000 });
    const requested = [];
    await withFetch(async (url) => {
      requested.push(String(url));
      if (String(url).includes('get-pizzint-status')) {
        return { ok: true, status: 200, json: async () => fresh };
      }
      return anonymousSessionResponse();
    }, () => loadPizzInt(tool));

    assert.deepEqual(requested, ['/api/wm-session', '/api/intelligence/v1/get-pizzint-status']);
    assert.equal(tool.dataset.state, 'ready');
    assert.equal(tool.querySelector('[data-live-status]').textContent, 'Live reading');
    assert.equal(tool.querySelector('[data-pizzint-level]').textContent, '4');
    assert.equal(tool.querySelector('[data-pizzint-level]').hidden, false);
    assert.equal(tool.querySelector('[data-pizzint-label]').textContent, 'Above Normal');
    assert.equal(tool.querySelector('[data-live-grid]').hidden, false);
    assert.equal(tool.querySelector('[data-live-fallback]').hidden, true);
    const venues = [...tool.querySelectorAll('[data-pizzint-venues] li')].map((item) => item.textContent);
    assert.equal(venues[0], 'Spike Pizza · Spike +90%');
    assert.equal(venues.length, 8);
    assert.match(tool.querySelector('[data-live-updated]').textContent, /^Updated .+ UTC$/);
  });

  it('says plainly when no venue is reporting', async () => {
    const tool = pizzaTool();
    await withFetch(async (url) => (String(url).includes('get-pizzint-status')
      ? { ok: true, status: 200, json: async () => ({ tensionPairs: [] }) }
      : anonymousSessionResponse()), () => loadPizzInt(tool));

    assert.equal(tool.dataset.state, 'empty');
    assert.equal(tool.querySelector('[data-live-status]').textContent, 'Live feed checked');
    assert.equal(tool.querySelector('[data-pizzint-level]').hidden, true);
    assert.equal(tool.querySelector('[data-pizzint-label]').textContent, 'No current reading');
    assert.match(
      tool.querySelector('[data-pizzint-venues] li').textContent,
      /No venue is reporting live busyness right now/,
    );
    // Dated by the check itself, never by an expired reading.
    assert.match(tool.querySelector('[data-live-updated]').textContent, /^Checked .+ UTC$/);
  });

  it('reloads an overdue reading when a background tab becomes visible', async () => {
    const tool = pizzaTool();
    let statusRequests = 0;
    const handler = async (url) => {
      if (String(url).includes('get-pizzint-status')) {
        statusRequests += 1;
        return { ok: true, status: 200, json: async () => payload({ updatedAt: Date.now() - 5 * 60_000 }) };
      }
      return anonymousSessionResponse();
    };
    await withFetch(handler, async () => {
      await loadPizzInt(tool);
      assert.equal(statusRequests, 1);
      // Not yet due: nothing to do on resume.
      resumePizzIntRefresh(tool, Date.now());
      assert.equal(statusRequests, 1);
      // Throttled timers in a hidden tab: the refresh is overdue on return.
      resumePizzIntRefresh(tool, Date.now() + 16 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(statusRequests, 2);
    });
    cancelPizzIntRefresh(tool);
  });

  it('marks the reading unavailable when the request fails', async () => {
    const tool = pizzaTool();
    await withFetch(async () => {
      throw new Error('offline');
    }, () => loadPizzInt(tool));

    assert.equal(tool.dataset.state, 'error');
    assert.equal(tool.querySelector('[data-live-status]').textContent, 'Temporarily unavailable');
    assert.equal(tool.querySelector('[data-pizzint-level]').hidden, true);
    assert.equal(tool.querySelector('[data-pizzint-label]').textContent, 'Unavailable');
    assert.equal(tool.querySelector('[data-pizzint-venues]').children.length, 0);
  });
});
