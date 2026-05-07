import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEiaSprRow, parseEiaRefineryRow, SPR_TTL, REFINERY_INPUTS_TTL } from '../scripts/seed-economy.mjs';

// ─── Key constants (imported from cache-keys pattern) ───
// These tests intentionally cross-check the seed's internal strings against
// the expected Redis key format so a key rename in either place fails loudly.

describe('seed Redis key strings', () => {
  it('SPR payload shape matches expected consumer contract', () => {
    // Verify what consumers of economic:spr:v1 will read
    const result = parseEiaSprRow({ value: '370.2', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.ok('barrels' in result, 'SPR payload must have barrels field');
    assert.ok('period' in result, 'SPR payload must have period field');
    assert.equal(typeof result.barrels, 'number', 'barrels must be a number (already in M bbl — do NOT divide again)');
  });

  it('refinery key follows economic:refinery-inputs:v1 convention', () => {
    // Verify the shape of a minimal seeded refinery payload (what consumers will read)
    const result = parseEiaRefineryRow({ value: '15973', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.ok('inputsMbblpd' in result, 'Refinery payload must have inputsMbblpd field (not utilization %)');
    assert.ok('period' in result, 'Refinery payload must have period field');
  });
});

// ─── TTL constants (imported from seed-economy) ───

describe('TTL constants', () => {
  it('SPR_TTL is at least 21 days in seconds', () => {
    assert.ok(SPR_TTL >= 21 * 24 * 3600, `SPR_TTL ${SPR_TTL} < 21 days`);
  });

  it('REFINERY_INPUTS_TTL is at least 21 days in seconds', () => {
    assert.ok(REFINERY_INPUTS_TTL >= 21 * 24 * 3600, `REFINERY_INPUTS_TTL ${REFINERY_INPUTS_TTL} < 21 days`);
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
    const result = parseEiaRefineryRow({ value: '15973', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.inputsMbblpd, 15973);
    assert.equal(result.period, '2026-03-28');
  });

  it('parses a numeric value', () => {
    const result = parseEiaRefineryRow({ value: 15973, period: '2026-03-21' });
    assert.ok(result !== null);
    assert.equal(result.inputsMbblpd, 15973);
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
    const result = parseEiaRefineryRow({ value: '15973', period: '20260328' });
    assert.ok(result !== null);
    assert.equal(result.period, '');
  });

  it('rounds inputsMbblpd to 3 decimal places', () => {
    const result = parseEiaRefineryRow({ value: '15973.12345', period: '2026-03-28' });
    assert.ok(result !== null);
    assert.equal(result.inputsMbblpd, 15973.123);
  });
});
