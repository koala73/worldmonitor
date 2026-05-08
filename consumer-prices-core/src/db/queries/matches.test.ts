// Unit tests for the matches.ts query contract — focuses on the new
// getDisabledPinsForRecovery query added in PR #3627 (the recovery-probe
// path that prevents sticky-disable monotonic decay; see migration 009 +
// memory `sticky-disable-without-auto-recovery-decays`).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../client.js', () => ({ query: mockQuery }));

const { getDisabledPinsForRecovery } = await import('./matches.js');

beforeEach(() => mockQuery.mockReset());

describe('getDisabledPinsForRecovery', () => {
  it('queries only DISABLED pins (pin_disabled_at IS NOT NULL) — opposite of active pin filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getDisabledPinsForRecovery('retailer-id', 10);

    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;

    // Critical: this query must INCLUDE pin_disabled_at IS NOT NULL
    // (the inverse of getPinnedUrlsForRetailer, which excludes them).
    // If a future refactor accidentally inverts this, recovery-probe
    // re-includes already-active pins → wasted scrape budget AND no
    // recovery for the actual disabled pins.
    expect(sql).toContain('pm.pin_disabled_at IS NOT NULL');
    expect(sql).not.toContain('pm.pin_disabled_at IS NULL');

    // No counter exclusions — the original gate uses < 3 thresholds, but
    // this query targets the disabled set; counter values are irrelevant.
    expect(sql).not.toContain('consecutive_out_of_stock < 3');
    expect(sql).not.toContain('pin_error_count < 3');
  });

  it('includes only auto/approved matches (review/rejected stay out of recovery)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getDisabledPinsForRecovery('retailer-id', 10);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("pm.match_status IN ('auto', 'approved')");
  });

  it('orders by oldest disable first (FIFO fairness across the disabled set)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getDisabledPinsForRecovery('retailer-id', 10);

    const sql = mockQuery.mock.calls[0][0] as string;
    // FIFO ensures every disabled pin gets a recovery turn within ceil(N/limit)
    // cycles — none sits permanently at the back of the queue.
    expect(sql).toContain('pm.pin_disabled_at ASC');
  });

  it('honors the limit parameter (bounded scrape budget)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getDisabledPinsForRecovery('retailer-id', 5);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT $2');
    expect(mockQuery.mock.calls[0][1]).toEqual(['retailer-id', 5]);
  });

  it('returns Map<basketSlug:canonicalName, {sourceUrl, productId, matchId}> — same shape as getPinnedUrlsForRetailer', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { canonical_name: 'Eggs 6 Pack', basket_slug: 'essentials-ae', source_url: 'https://example.com/eggs', product_id: 'p1', match_id: 'm1' },
        { canonical_name: 'Rice 1kg', basket_slug: 'essentials-ae', source_url: 'https://example.com/rice', product_id: 'p2', match_id: 'm2' },
      ],
    });
    const result = await getDisabledPinsForRecovery('retailer-id', 10);

    // Shape parity with getPinnedUrlsForRetailer is critical — scrape.ts
    // merges both Maps into a single pinnedUrls argument for the adapter.
    expect(result.size).toBe(2);
    expect(result.get('essentials-ae:Eggs 6 Pack')).toEqual({
      sourceUrl: 'https://example.com/eggs',
      productId: 'p1',
      matchId: 'm1',
    });
    expect(result.get('essentials-ae:Rice 1kg')).toEqual({
      sourceUrl: 'https://example.com/rice',
      productId: 'p2',
      matchId: 'm2',
    });
  });

  it('returns empty map when no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getDisabledPinsForRecovery('retailer-id', 10);
    expect(result.size).toBe(0);
  });
});
