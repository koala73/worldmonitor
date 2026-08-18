import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../client.js', () => ({ query: mockQuery }));

const { hashPayload, insertObservation } = await import('./observations.js');

const input = {
  retailerProductId: 'product-1',
  scrapeRunId: 'run-1',
  price: 4.5,
  currencyCode: 'AED',
  rawPayloadJson: { title: 'White Bread', price: 4.5 },
};

beforeEach(() => mockQuery.mockReset());

describe('insertObservation', () => {
  it('deduplicates when the latest observation has the same payload', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'observation-1', raw_hash: hashPayload(input.rawPayloadJson) }],
    });

    await expect(insertObservation(input)).resolves.toBe('observation-1');

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY observed_at DESC, id DESC LIMIT 1');
    expect(mockQuery.mock.calls[0][0]).not.toContain('raw_hash = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual(['product-1']);
  });

  it('inserts a fresh row when an older payload recurs after different evidence', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'newer-observation', raw_hash: 'different-hash' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'fresh-observation' }] });

    await expect(insertObservation(input)).resolves.toBe('fresh-observation');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO price_observations');
    expect(mockQuery.mock.calls[1][0]).toContain('clock_timestamp()');
    expect(mockQuery.mock.calls[1][1][12]).toBe(hashPayload(input.rawPayloadJson));
  });
});
