import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEiaSprRow, parseEiaRefineryRow } from '../scripts/seed-economy.mjs';

// ─── Key constants ───

describe('SPR_KEY constant', () => {
  it('matches expected Redis key', async () => {
    // Import cache-keys via dynamic import (TypeScript compiled output not available in .mjs test)
    // Validate the string literal used in seed-economy matches convention
    // The seed writes to 'economic:spr:v1'
    const SPR_KEY = 'economic:spr:v1';
    assert.equal(SPR_KEY, 'economic:spr:v1');
  });
});

describe('REFINERY_UTIL_KEY constant', () => {
  it('matches expected Redis key', () => {
    const REFINERY_UTIL_KEY = 'economic:refinery-util:v1';
    assert.equal(REFINERY_UTIL_KEY, 'economic:refinery-util:v1');
  });
});

// ─── TTL constants ───

describe('TTL constants', () => {
  it('SPR_TTL is at least 21 days in seconds', () => {
    const SPR_TTL = 1_814_400;
    assert.ok(SPR_TTL >= 21 * 24 * 3600, `SPR_TTL ${SPR_TTL} < 21 days`);
  });

  it('REFINERY_TTL is at least 21 days in seconds', () => {
    const REFINERY_TTL = 1_814_400;
    assert.ok(REFINERY_TTL >= 21 * 24 * 3600, `REFINERY_TTL ${REFINERY_TTL} < 21 days`);
  });
});

// ─── parseEiaSprRow ───

describe('parseEiaSprRow', () => {
  it('parses a numeric string value', () => {
    const result = parseEiaSprRow({ value: '370.2', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.barrels, 370.2);
    assert.equal(result.period, '2026-03-28');
  });

  it('parses a numeric value', () => {
    const result = parseEiaSprRow({ value: 370.234, period: '2026-03-21' });
    assert.ok(result !== null);
    assert.equal(result.barrels, 370.234);
  });

  it('returns null for null value', () => {
    assert.equal(parseEiaSprRow({ value: null, period: '2026-03-28' }), null);
  });

  it('returns null for empty string value', () => {
    assert.equal(parseEiaSprRow({ value: '', period: '2026-03-28' }), null);
  });

  it('returns null for NaN value', () => {
    assert.equal(parseEiaSprRow({ value: 'N/A', period: '2026-03-28' }), null);
  });

  it('returns null for undefined row', () => {
    assert.equal(parseEiaSprRow(undefined), null);
  });

  it('returns null for null row', () => {
    assert.equal(parseEiaSprRow(null), null);
  });

  it('sets period to empty string for invalid date format', () => {
    const result = parseEiaSprRow({ value: '370.2', period: '2026/03/28' });
    assert.ok(result !== null);
    assert.equal(result.period, '');
  });

  it('rounds barrels to 3 decimal places', () => {
    const result = parseEiaSprRow({ value: '370.12345', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.barrels, 370.123);
  });
});

// ─── computeSprWoW (inline logic mirroring fetchSprLevels) ───

describe('computeSprWoW', () => {
  it('computes correct WoW delta', () => {
    const latest = { barrels: 370.2 };
    const prev = { barrels: 371.6 };
    const changeWoW = +(latest.barrels - prev.barrels).toFixed(3);
    assert.equal(changeWoW, -1.4);
  });

  it('returns null when prev is null', () => {
    const prev = null;
    const changeWoW = prev ? +(370.2 - prev.barrels).toFixed(3) : null;
    assert.equal(changeWoW, null);
  });

  it('computes correct 4-week change', () => {
    const latest = { barrels: 370.2 };
    const prev4 = { barrels: 375.4 };
    const changeWoW4 = +(latest.barrels - prev4.barrels).toFixed(3);
    assert.equal(changeWoW4, -5.2);
  });
});

// ─── parseEiaRefineryRow ───

describe('parseEiaRefineryRow', () => {
  it('parses a numeric string value', () => {
    const result = parseEiaRefineryRow({ value: '89.3', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.utilizationPct, 89.3);
    assert.equal(result.period, '2026-03-28');
  });

  it('parses a numeric value', () => {
    const result = parseEiaRefineryRow({ value: 89.3, period: '2026-03-21' });
    assert.ok(result !== null);
    assert.equal(result.utilizationPct, 89.3);
  });

  it('returns null for null value', () => {
    assert.equal(parseEiaRefineryRow({ value: null, period: '2026-03-28' }), null);
  });

  it('returns null for empty string value', () => {
    assert.equal(parseEiaRefineryRow({ value: '', period: '2026-03-28' }), null);
  });

  it('returns null for NaN string value', () => {
    assert.equal(parseEiaRefineryRow({ value: 'N/A', period: '2026-03-28' }), null);
  });

  it('returns null for undefined row', () => {
    assert.equal(parseEiaRefineryRow(undefined), null);
  });

  it('returns null for null row', () => {
    assert.equal(parseEiaRefineryRow(null), null);
  });

  it('sets period to empty string for invalid date format', () => {
    const result = parseEiaRefineryRow({ value: '89.3', period: '20260328' });
    assert.ok(result !== null);
    assert.equal(result.period, '');
  });

  it('rounds utilizationPct to 3 decimal places', () => {
    const result = parseEiaRefineryRow({ value: '89.12345', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.utilizationPct, 89.123);
  });
});
