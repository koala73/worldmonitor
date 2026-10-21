// Unit tests for the symmetric pin disable + auto-recovery logic in
// scrape.ts. Mocks the `query` function from db/client so we can exercise
// the SQL contract without a live database.
//
// Background: WM 2026-05-08 incident — 48.5% of all product_matches were
// sticky-disabled by the existing 3-strike OOS / pin-error rule because
// there was NO paired auto-recovery. Migration 009 + the new
// handleStaleOnInStock helper add the recovery half. These tests pin the
// CONTRACT (when does pin_disabled_at get cleared / set) so future
// refactors don't silently regress the decay protection.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db/client BEFORE importing the helpers (vi.mock is hoisted).
const mockQuery = vi.fn();
vi.mock('../db/client.js', () => ({
  query: mockQuery,
  closePool: vi.fn(),
}));

// Silence the local logger so test output stays clean. The helpers'
// success-log messages are still observable via the mockQuery call
// arguments + assertions below — we don't need stdout for test signal.
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

// Import AFTER mocks are set up so the imported module sees the mocks.
const { handleStaleOnInStock, handleStaleOnOutOfStock } = await import('./scrape-pin-recovery.js');

beforeEach(() => mockQuery.mockReset());

// ── handleStaleOnInStock ─────────────────────────────────────────────────

describe('handleStaleOnInStock', () => {
  it('increments consecutive_in_stock and resets the disable counters atomically', async () => {
    // First call returns the new in_stock_count = 1 (no recovery yet).
    mockQuery.mockResolvedValueOnce({ rows: [{ in_stock_count: '1' }] });
    await handleStaleOnInStock('p1', 'm1', 'target-1');
    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE retailer_products');
    // Counter is capped at the recovery threshold (3) so it doesn't grow
    // unbounded for always-active pins. The clear query is idempotent
    // (`WHERE pin_disabled_at IS NOT NULL`), so capping is behavior-neutral
    // — it only stops the unbounded INT growth flagged in PR #3633 review.
    expect(sql).toContain('consecutive_in_stock = LEAST(consecutive_in_stock + 1, 3)');
    expect(sql).toContain('consecutive_out_of_stock = 0');
    expect(sql).toContain('pin_error_count = 0');
    expect(sql).toContain('RETURNING consecutive_in_stock AS in_stock_count');
    expect(mockQuery.mock.calls[0][1]).toEqual(['p1']);
  });

  it('does NOT clear pin_disabled_at when in_stock_count < 3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ in_stock_count: '2' }] });
    await handleStaleOnInStock('p1', 'm1', 'target-1');
    expect(mockQuery).toHaveBeenCalledOnce();     // only the counter UPDATE — no clear
  });

  it('clears pin_disabled_at when in_stock_count reaches 3 (mirror of disable threshold)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ in_stock_count: '3' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await handleStaleOnInStock('p-cape', 'm-cape', 'target-cape');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const clearSql = mockQuery.mock.calls[1][0] as string;
    expect(clearSql).toContain('UPDATE product_matches');
    expect(clearSql).toContain('SET pin_disabled_at = NULL');
    // Idempotency guard: only touch rows that actually have the marker set.
    expect(clearSql).toContain('AND pin_disabled_at IS NOT NULL');
    expect(mockQuery.mock.calls[1][1]).toEqual(['m-cape']);
  });

  it('clears pin_disabled_at on every subsequent in_stock observation past threshold (idempotent)', async () => {
    // Verifies the helper doesn't gate the clear on "first time crossing"
    // — operationally, after threshold the clear should be safely re-fired
    // each scrape (idempotent via WHERE pin_disabled_at IS NOT NULL).
    mockQuery.mockResolvedValueOnce({ rows: [{ in_stock_count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });    // already cleared (no-op match)
    await handleStaleOnInStock('p1', 'm1', 'target-1');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('handles missing/null in_stock_count by treating as 0 (defensive)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await handleStaleOnInStock('p1', 'm1', 'target-1');
    expect(mockQuery).toHaveBeenCalledOnce();     // 0 < 3 → no clear attempt
  });
});

// ── handleStaleOnOutOfStock ──────────────────────────────────────────────

describe('handleStaleOnOutOfStock', () => {
  it('increments OOS counter and resets in_stock counter atomically', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '1' }] });
    await handleStaleOnOutOfStock('p1', 'm1', 'target-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('consecutive_out_of_stock = consecutive_out_of_stock + 1');
    // Symmetry: OOS is a failure → recovery counter must reset, otherwise
    // an OOS observation between in-stock observations would let the
    // recovery counter accumulate falsely.
    expect(sql).toContain('consecutive_in_stock = 0');
  });

  it('does NOT set pin_disabled_at until OOS count reaches 3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '2' }] });
    await handleStaleOnOutOfStock('p1', 'm1', 'target-1');
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it('sets pin_disabled_at when OOS count reaches the 3-strike threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '3' }] });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await handleStaleOnOutOfStock('p1', 'm-disabled', 'target-1');
    const disableSql = mockQuery.mock.calls[1][0] as string;
    expect(disableSql).toContain('UPDATE product_matches');
    expect(disableSql).toContain('SET pin_disabled_at = NOW()');
    expect(mockQuery.mock.calls[1][1]).toEqual(['m-disabled']);
  });
});

// ── Symmetry / contract assertion ────────────────────────────────────────

describe('disable + recovery thresholds are symmetric', () => {
  it('uses the same threshold (3) on both sides', async () => {
    // Disable side: 3 OOS triggers disable
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '3' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await handleStaleOnOutOfStock('p', 'm', 't');
    const disableCallCount = mockQuery.mock.calls.length;
    expect(disableCallCount).toBe(2);     // counter + disable

    mockQuery.mockReset();

    // Recovery side: 3 in-stock triggers clear
    mockQuery.mockResolvedValueOnce({ rows: [{ in_stock_count: '3' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await handleStaleOnInStock('p', 'm', 't');
    const recoverCallCount = mockQuery.mock.calls.length;
    expect(recoverCallCount).toBe(2);     // counter + clear
  });
});
