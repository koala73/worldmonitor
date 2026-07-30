import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/client.js', () => ({ query: mockQuery }));

const { buildMoversSnapshot, isPlausiblePriceMove, MAX_MOVE_RATIO } = await import(
  './worldmonitor.js'
);

describe('isPlausiblePriceMove', () => {
  it('rejects the parse-artifact movers reported in #5445', () => {
    expect(isPlausiblePriceMove(874.68)).toBe(false); // White Sugar 1kg, lulu_ae
    expect(isPlausiblePriceMove(608.86)).toBe(false); // Whole Chicken, spinneys_ae
    expect(isPlausiblePriceMove(-99.25)).toBe(false); // Yaumi bread
  });

  it('keeps realistic weekly moves', () => {
    expect(isPlausiblePriceMove(0)).toBe(true);
    expect(isPlausiblePriceMove(12.5)).toBe(true);
    expect(isPlausiblePriceMove(-40)).toBe(true);
  });

  it('gates exactly at the bilateral MAX_MOVE_RATIO bound', () => {
    expect(MAX_MOVE_RATIO).toBe(4);
    // upper bound: new price = 4x past -> +300%
    expect(isPlausiblePriceMove(300)).toBe(true);
    expect(isPlausiblePriceMove(300.1)).toBe(false);
    // lower bound: new price = 0.25x past -> -75%
    expect(isPlausiblePriceMove(-75)).toBe(true);
    expect(isPlausiblePriceMove(-75.1)).toBe(false);
  });

  it('rejects non-finite change values', () => {
    expect(isPlausiblePriceMove(Number.NaN)).toBe(false);
    expect(isPlausiblePriceMove(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('buildMoversSnapshot', () => {
  const row = (id: string, changePct: string) => ({
    product_id: id,
    raw_title: `Product ${id}`,
    category_text: 'grocery',
    retailer_slug: 'lulu_ae',
    current_price: '10.00',
    currency_code: 'AED',
    change_pct: changePct,
  });

  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockQuery.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('ranks risers/fallers over the gated set, not the raw rows (#5445)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        row('1', '874.68'), // White Sugar 1kg artifact — must be dropped
        row('2', '-99.25'), // Yaumi bread artifact — must be dropped
        row('3', '12.5'),
        row('4', '-40'),
      ],
    });

    const snap = await buildMoversSnapshot('ae', 7);

    expect(snap.risers.map((m) => m.productId)).toEqual(['3']);
    expect(snap.fallers.map((m) => m.productId)).toEqual(['4']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('dropped 2/4');
  });

  it('publishes an empty snapshot when every fetched row is implausible', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row('1', '874.68'), row('2', '608.86'), row('3', '-99.25')],
    });

    const snap = await buildMoversSnapshot('ae', 7);

    expect(snap.risers).toEqual([]);
    expect(snap.fallers).toEqual([]);
    expect(snap.upstreamUnavailable).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain('dropped 3/3');
  });

  it('does not warn when every mover is plausible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row('1', '12.5'), row('2', '-40')] });

    const snap = await buildMoversSnapshot('ae', 7);

    expect(snap.risers).toHaveLength(1);
    expect(snap.fallers).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
