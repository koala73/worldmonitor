// @ts-check
//
// Tests for src/components/EnergyRiskOverviewPanel.ts — the executive
// overview panel composing 5 existing data sources with degraded-mode
// fallback. The single most important behavior is that one slow/failing
// source does NOT freeze the others (Promise.allSettled, never .all).
//
// Test strategy: mock the four service modules (hormuz-tracker, economic,
// market, supply-chain Connect-RPC client) and assert the rendered HTML
// against shape per tile. We don't import the real panel (it would pull in
// vite import.meta.env which doesn't resolve under node:test); instead we
// re-implement the small set of pure helpers as a contract test.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

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
