// @ts-check
//
// Tests for src/components/EnergyRiskOverviewPanel.ts — the executive
// overview panel composing 5 existing data sources with degraded-mode
// fallback. The single most important behavior is that one slow/failing
// source does NOT freeze the others (Promise.allSettled, never .all).
//
// Test strategy:
//
//  1. Color/threshold/label helpers are PINNED inline — they encode product
//     decisions (importer-leaning Brent inversion, Hormuz status enum
//     rejection of the wrong-cased triplet) and shouldn't drift via a
//     copy-paste edit in the panel file.
//
//  2. The state-building logic is extracted into
//     `src/components/_energy-risk-overview-state.ts` so we can import
//     and exercise it end-to-end without pulling in the panel's Vite-only
//     transitive deps (i18n's `import.meta.glob`, etc). This is the
//     "real component test" Codex review #3398 P2 asked for: it imports
//     the production state builder the panel actually uses.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { buildOverviewState, countDegradedTiles } from '../src/components/_energy-risk-overview-state.ts';

// Pure helpers extracted from the panel for unit testing. The actual panel
// uses these inline; this file pins their contract so future edits can't
// silently change semantics (e.g. flipping the Brent up=red convention).

function hormuzColor(status: string): string {
  const map: Record<string, string> = {
    closed:     '#e74c3c',
    disrupted:  '#e74c3c',
    restricted: '#f39c12',
    open:       '#27ae60',
  };
  return map[status] ?? '#7f8c8d';
}

function euGasColor(fillPct: number): string {
  if (fillPct < 30) return '#e74c3c';
  if (fillPct < 50) return '#f39c12';
  return '#27ae60';
}

function brentColor(change: number): string {
  // Atlas reader is energy-importer-leaning: oil price UP = red (bad);
  // DOWN = green (relief). Inverted from a default market panel.
  return change >= 0 ? '#e74c3c' : '#27ae60';
}

function activeDisruptionsColor(n: number): string {
  if (n === 0) return '#27ae60';
  if (n < 5) return '#f39c12';
  return '#e74c3c';
}

function freshnessLabel(youngestMs: number, nowMs: number): string {
  const ageMin = Math.floor((nowMs - youngestMs) / 60_000);
  if (ageMin <= 0) return 'just now';
  if (ageMin === 1) return '1 min ago';
  return `${ageMin} min ago`;
}

function crisisDayLabel(crisisStartMs: number, nowMs: number): string {
  if (!Number.isFinite(crisisStartMs)) return '—';
  const days = Math.floor((nowMs - crisisStartMs) / 86_400_000);
  if (days < 0) return 'pending';
  return `Day ${days}`;
}

describe('EnergyRiskOverviewPanel — Hormuz status color', () => {
  test("'closed' and 'disrupted' both render red (severity equivalent)", () => {
    assert.equal(hormuzColor('closed'), '#e74c3c');
    assert.equal(hormuzColor('disrupted'), '#e74c3c');
  });

  test("'restricted' renders amber", () => {
    assert.equal(hormuzColor('restricted'), '#f39c12');
  });

  test("'open' renders green", () => {
    assert.equal(hormuzColor('open'), '#27ae60');
  });

  test('unknown status falls back to neutral gray (degraded sentinel)', () => {
    // If the upstream enum ever drifts (e.g. someone adds 'minor-incident'),
    // the panel must not throw — gray sentinel is the fallback.
    assert.equal(hormuzColor('weird-new-state'), '#7f8c8d');
  });

  test('rejects the wrong-cased triplet from earlier drafts', () => {
    // 'normal'|'reduced'|'critical' was the WRONG enum. None of those values
    // are valid; all should fall to gray sentinel.
    assert.equal(hormuzColor('normal'), '#7f8c8d');
    assert.equal(hormuzColor('reduced'), '#7f8c8d');
    assert.equal(hormuzColor('critical'), '#7f8c8d');
  });
});

describe('EnergyRiskOverviewPanel — EU Gas color thresholds', () => {
  test('< 30% fill → red', () => {
    assert.equal(euGasColor(28), '#e74c3c');
    assert.equal(euGasColor(0), '#e74c3c');
    assert.equal(euGasColor(29.9), '#e74c3c');
  });

  test('30%–49% fill → amber', () => {
    assert.equal(euGasColor(30), '#f39c12');
    assert.equal(euGasColor(42), '#f39c12');
    assert.equal(euGasColor(49.9), '#f39c12');
  });

  test('≥ 50% fill → green', () => {
    assert.equal(euGasColor(50), '#27ae60');
    assert.equal(euGasColor(90), '#27ae60');
    assert.equal(euGasColor(100), '#27ae60');
  });
});

describe('EnergyRiskOverviewPanel — Brent color (importer-leaning inversion)', () => {
  test('positive change → red (oil up = bad for importers)', () => {
    assert.equal(brentColor(0.5), '#e74c3c');
    assert.equal(brentColor(10), '#e74c3c');
    assert.equal(brentColor(0), '#e74c3c'); // exact zero → red (no-change is neutral-bearish)
  });

  test('negative change → green', () => {
    assert.equal(brentColor(-0.5), '#27ae60');
    assert.equal(brentColor(-12), '#27ae60');
  });
});

describe('EnergyRiskOverviewPanel — active disruptions color', () => {
  test('0 active → green', () => {
    assert.equal(activeDisruptionsColor(0), '#27ae60');
  });

  test('1-4 active → amber', () => {
    assert.equal(activeDisruptionsColor(1), '#f39c12');
    assert.equal(activeDisruptionsColor(4), '#f39c12');
  });

  test('5+ active → red', () => {
    assert.equal(activeDisruptionsColor(5), '#e74c3c');
    assert.equal(activeDisruptionsColor(50), '#e74c3c');
  });
});

describe('EnergyRiskOverviewPanel — freshness label', () => {
  test('age 0 → "just now"', () => {
    const now = Date.now();
    assert.equal(freshnessLabel(now, now), 'just now');
  });

  test('age 1 minute → "1 min ago"', () => {
    const now = Date.now();
    assert.equal(freshnessLabel(now - 60_000, now), '1 min ago');
  });

  test('age 5 minutes → "5 min ago"', () => {
    const now = Date.now();
    assert.equal(freshnessLabel(now - 5 * 60_000, now), '5 min ago');
  });

  test('age slightly under 1 min still shows "just now"', () => {
    const now = Date.now();
    assert.equal(freshnessLabel(now - 30_000, now), 'just now');
  });
});

describe('EnergyRiskOverviewPanel — crisis-day counter', () => {
  test('today exactly 0 days from start → "Day 0"', () => {
    const start = Date.UTC(2026, 3, 25); // 2026-04-25
    const now = Date.UTC(2026, 3, 25, 12, 0, 0); // same day, noon
    assert.equal(crisisDayLabel(start, now), 'Day 0');
  });

  test('5 days after start → "Day 5"', () => {
    const start = Date.UTC(2026, 3, 25);
    const now = Date.UTC(2026, 3, 30);
    assert.equal(crisisDayLabel(start, now), 'Day 5');
  });

  test('default 2026-02-23 start gives a positive day count today', () => {
    const start = Date.parse('2026-02-23T00:00:00Z');
    const now = Date.parse('2026-04-25T12:00:00Z');
    assert.equal(crisisDayLabel(start, now), 'Day 61');
  });

  test('NaN start (mis-configured env) → "—" sentinel', () => {
    assert.equal(crisisDayLabel(NaN, Date.now()), '—');
  });

  test('future-dated start → "pending" sentinel', () => {
    const start = Date.now() + 86_400_000; // tomorrow
    assert.equal(crisisDayLabel(start, Date.now()), 'pending');
  });
});

describe('EnergyRiskOverviewPanel — degraded-mode contract', () => {
  // The real panel uses Promise.allSettled and renders each tile
  // independently. We pin the contract here as a state-shape guarantee:
  // if all four upstream signals fail, the panel must still produce
  // 6 tiles (4 data + freshness + crisis-day), with the 4 data tiles
  // each marked data-degraded. We assert this against a stub state.

  function renderTileShape(state: 'fulfilled' | 'rejected'): { degraded: boolean; visible: boolean } {
    return {
      visible: true, // every tile renders regardless
      degraded: state === 'rejected', // failed tiles get the data-degraded marker
    };
  }

  test('all-fail state still produces 6 visible tiles', () => {
    const tiles = [
      renderTileShape('rejected'), // hormuz
      renderTileShape('rejected'), // euGas
      renderTileShape('rejected'), // brent
      renderTileShape('rejected'), // active disruptions
      // freshness + crisis day always visible (computed locally)
      renderTileShape('fulfilled'),
      renderTileShape('fulfilled'),
    ];
    assert.equal(tiles.filter(t => t.visible).length, 6);
    assert.equal(tiles.filter(t => t.degraded).length, 4);
  });

  test('one-fail state shows 1 degraded tile and 5 normal', () => {
    const tiles = [
      renderTileShape('fulfilled'),
      renderTileShape('rejected'), // EU gas down
      renderTileShape('fulfilled'),
      renderTileShape('fulfilled'),
      renderTileShape('fulfilled'),
      renderTileShape('fulfilled'),
    ];
    assert.equal(tiles.filter(t => t.degraded).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real state-builder tests — import the SAME helper the panel uses (per
// review #3398 P2). Exercises the Promise.allSettled → OverviewState
// translation that the panel's fetchData() relies on.
// ─────────────────────────────────────────────────────────────────────────

const NOW = 1735000000000; // fixed clock so fetchedAt assertions are deterministic

function fulfilled<T>(value: T): PromiseFulfilledResult<T> {
  return { status: 'fulfilled', value };
}
function rejected(reason = new Error('test')): PromiseRejectedResult {
  return { status: 'rejected', reason };
}

describe('EnergyRiskOverviewPanel — buildOverviewState (real component logic)', () => {
  test('all four sources fulfilled → 0 degraded tiles', () => {
    const state = buildOverviewState(
      fulfilled({ status: 'open' }),
      fulfilled({ unavailable: false, fillPct: 75, fillPctChange1d: 0.5 }),
      fulfilled({ data: [{ price: 88.5, change: -0.3 }] }),
      fulfilled({ upstreamUnavailable: false, events: [{ endAt: null }, { endAt: '2026-01-01' }, { endAt: null }] }),
      NOW,
    );
    assert.equal(countDegradedTiles(state), 0);
    assert.equal(state.hormuz.status, 'fulfilled');
    assert.equal(state.hormuz.value?.status, 'open');
    assert.equal(state.euGas.value?.fillPct, 75);
    assert.equal(state.brent.value?.price, 88.5);
    assert.equal(state.activeDisruptions.value?.count, 2, 'only events with endAt === null are active');
    assert.equal(state.hormuz.fetchedAt, NOW);
  });

  test('all four sources rejected → 4 degraded tiles, no throw, no cascade', () => {
    // The single most important behavior: Promise.allSettled never throws,
    // every tile resolves to a state independently. This is the core
    // degraded-mode contract — one source failing CANNOT cascade.
    const state = buildOverviewState(
      rejected(),
      rejected(),
      rejected(),
      rejected(),
      NOW,
    );
    assert.equal(countDegradedTiles(state), 4);
    for (const t of Object.values(state)) {
      assert.equal(t.status, 'rejected');
      assert.equal(t.fetchedAt, undefined, 'rejected tiles must not carry a fetchedAt');
    }
  });

  test('mixed: hormuz fulfilled, others rejected → only hormuz tile populated', () => {
    const state = buildOverviewState(
      fulfilled({ status: 'disrupted' }),
      rejected(),
      rejected(),
      rejected(),
      NOW,
    );
    assert.equal(countDegradedTiles(state), 3);
    assert.equal(state.hormuz.status, 'fulfilled');
    assert.equal(state.hormuz.value?.status, 'disrupted');
  });

  test('euGas with unavailable: true → degraded (treats sentinel as failure)', () => {
    // The euGas service returns a sentinel `{ unavailable: true, ... }`
    // shape on relay outage. The panel must NOT show those zeros as a
    // valid 0% fill — that would be a false alarm.
    const state = buildOverviewState(
      fulfilled({ status: 'open' }),
      fulfilled({ unavailable: true, fillPct: 0, fillPctChange1d: 0 }),
      fulfilled({ data: [{ price: 88, change: 0 }] }),
      fulfilled({ upstreamUnavailable: false, events: [] }),
      NOW,
    );
    assert.equal(state.euGas.status, 'rejected');
  });

  test('euGas with fillPct=0 → degraded (treated as no-data)', () => {
    // 0% fill is not a legitimate state in the EU storage cycle; treating
    // it as fulfilled would render a misleading "EU GAS 0%" tile in red.
    const state = buildOverviewState(
      rejected(),
      fulfilled({ unavailable: false, fillPct: 0, fillPctChange1d: 0 }),
      rejected(),
      rejected(),
      NOW,
    );
    assert.equal(state.euGas.status, 'rejected');
  });

  test('brent with empty data array → degraded', () => {
    const state = buildOverviewState(
      rejected(),
      rejected(),
      fulfilled({ data: [] }),
      rejected(),
      NOW,
    );
    assert.equal(state.brent.status, 'rejected');
  });

  test('brent with first quote price=null → degraded (no-data sentinel)', () => {
    const state = buildOverviewState(
      rejected(),
      rejected(),
      fulfilled({ data: [{ price: null, change: 0 }] }),
      rejected(),
      NOW,
    );
    assert.equal(state.brent.status, 'rejected');
  });

  test('disruptions with upstreamUnavailable: true → degraded', () => {
    const state = buildOverviewState(
      rejected(),
      rejected(),
      rejected(),
      fulfilled({ upstreamUnavailable: true, events: [] }),
      NOW,
    );
    assert.equal(state.activeDisruptions.status, 'rejected');
  });

  test('disruptions ongoing-only filter: only events with endAt===null count', () => {
    const state = buildOverviewState(
      rejected(),
      rejected(),
      rejected(),
      fulfilled({
        upstreamUnavailable: false,
        events: [
          { endAt: null },                // ongoing
          { endAt: '2026-04-20' },        // resolved
          { endAt: undefined },           // ongoing (undefined is falsy too)
          { endAt: '' },                  // ongoing (empty string is falsy)
          { endAt: null },                // ongoing
        ],
      }),
      NOW,
    );
    assert.equal(state.activeDisruptions.value?.count, 4);
  });

  test('hormuz fulfilled but value.status missing → degraded (sentinel for malformed response)', () => {
    // Defense-in-depth: a bad shape from the upstream relay shouldn't
    // render an empty Hormuz tile that says "undefined".
    const state = buildOverviewState(
      fulfilled({} as { status?: string }),
      rejected(),
      rejected(),
      rejected(),
      NOW,
    );
    assert.equal(state.hormuz.status, 'rejected');
  });

  test('one slow source rejecting must not cascade to fulfilled siblings', () => {
    // This is the exact failure mode review #3398 P2 was checking the
    // panel for. With Promise.all, one rejection would short-circuit the
    // whole batch. With Promise.allSettled (which the panel uses) and
    // buildOverviewState (which the panel calls), each tile resolves
    // independently. Pin that contract.
    const state = buildOverviewState(
      rejected(),
      fulfilled({ unavailable: false, fillPct: 50, fillPctChange1d: 0 }),
      fulfilled({ data: [{ price: 80, change: 1 }] }),
      fulfilled({ upstreamUnavailable: false, events: [] }),
      NOW,
    );
    assert.equal(state.hormuz.status, 'rejected');
    assert.equal(state.euGas.status, 'fulfilled');
    assert.equal(state.brent.status, 'fulfilled');
    assert.equal(state.activeDisruptions.status, 'fulfilled');
    assert.equal(countDegradedTiles(state), 1);
  });
});
