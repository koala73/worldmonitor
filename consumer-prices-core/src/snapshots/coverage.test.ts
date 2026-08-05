import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/client.js', () => ({ query: mockQuery }));

const { buildCoverageSnapshot } = await import('./coverage.js');

beforeEach(() => mockQuery.mockReset());

describe('coverage snapshot persistence contract', () => {
  it('uses the latest terminal run for LKG coverage and exposes a running probe separately', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      slug: 'retailer-a',
      name: 'Retailer A',
      last_run_at: new Date('2026-08-01T00:00:00.000Z'),
      run_status: 'completed',
      pages_attempted: '12',
      pages_succeeded: '12',
      errors_count: '0',
      rejected_count: '0',
      active_started_at: new Date('2026-08-01T01:00:00.000Z'),
      active_pages_attempted: '4',
      active_pages_succeeded: '2',
      active_errors_count: '1',
      active_rejected_count: '1',
    }] });

    const snapshot = await buildCoverageSnapshot('ae');
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.retailers[0]).toMatchObject({
      lastRunAt: '2026-08-01T00:00:00.000Z',
      rejectedCount: 0,
      activeRun: {
        startedAt: '2026-08-01T01:00:00.000Z',
        pagesAttempted: 4,
        pagesSucceeded: 2,
        errorsCount: 1,
        rejectedCount: 1,
      },
    });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status IN ('completed', 'partial', 'failed')");
    expect(sql).toContain("status = 'running'");
    expect(mockQuery.mock.calls[0][1]).toEqual(['ae']);
  });
});
