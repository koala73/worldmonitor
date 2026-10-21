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

  // The reason map is the whole point of #6182's diagnostics: if the query
  // stops selecting it, coverage silently reverts to bare counts and every
  // market reads COVERAGE_PARTIAL with no cause attached.
  it('reads the run failure reasons through to the snapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      slug: 'carrefour_sa',
      name: 'Carrefour Saudi Arabia',
      last_run_at: new Date('2026-08-07T02:00:00.000Z'),
      run_status: 'partial',
      pages_attempted: '12',
      pages_succeeded: '5',
      errors_count: '7',
      rejected_count: '1',
      failure_reasons: { 'missing-price': 6, 'provider-error': 1 },
      active_started_at: null,
      active_pages_attempted: '0',
      active_pages_succeeded: '0',
      active_errors_count: '0',
      active_rejected_count: '0',
    }] });

    const snapshot = await buildCoverageSnapshot('sa');
    expect(mockQuery.mock.calls[0][0] as string).toContain('failure_reasons');
    expect(snapshot.retailers[0].failureReasons).toEqual({ 'missing-price': 6, 'provider-error': 1 });
    expect(snapshot.failureReasons).toEqual({ 'missing-price': 6, 'provider-error': 1 });
  });

  // Symmetric with the writer's fallback. This query feeds the /coverage route
  // that publish.ts reads, so a hard failure here does not just lose the new
  // diagnostic — it removes the market's whole coverage block from seed
  // metadata and health. On a pre-011 database it must still answer.
  it('retries without failure_reasons when the column does not exist yet', async () => {
    const undefinedColumn = Object.assign(new Error('column "failure_reasons" does not exist'), {
      code: '42703',
    });
    mockQuery.mockRejectedValueOnce(undefinedColumn);
    mockQuery.mockResolvedValueOnce({ rows: [{
      slug: 'retailer-a',
      name: 'Retailer A',
      last_run_at: new Date('2026-08-07T02:00:00.000Z'),
      run_status: 'partial',
      pages_attempted: '12',
      pages_succeeded: '10',
      errors_count: '2',
      rejected_count: '1',
      active_started_at: null,
      active_pages_attempted: '0',
      active_pages_succeeded: '0',
      active_errors_count: '0',
      active_rejected_count: '0',
    }] });

    const snapshot = await buildCoverageSnapshot('ae');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain('failure_reasons');
    expect(mockQuery.mock.calls[1][0]).not.toContain('failure_reasons');
    expect(snapshot.retailers[0].pagesSucceeded).toBe(10);
    expect(snapshot.retailers[0].failureReasons).toEqual({});
  });

  // Any other database fault must surface. Swallowing it would let a genuine
  // outage publish a truthful-looking snapshot built from a second failed read.
  it('does not retry on a database error other than undefined-column', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    await expect(buildCoverageSnapshot('ae')).rejects.toThrow('connection terminated');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Rows written before migration 011, and retailers that have never run, come
  // back without the column. That must read as "no reasons recorded", not throw.
  it('tolerates a row with no failure_reasons column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      slug: 'retailer-a',
      name: 'Retailer A',
      last_run_at: null,
      run_status: null,
      pages_attempted: '0',
      pages_succeeded: '0',
      errors_count: '0',
      rejected_count: '0',
      active_started_at: null,
      active_pages_attempted: '0',
      active_pages_succeeded: '0',
      active_errors_count: '0',
      active_rejected_count: '0',
    }] });

    const snapshot = await buildCoverageSnapshot('ae');
    expect(snapshot.retailers[0].failureReasons).toEqual({});
    expect(snapshot.failureReasons).toEqual({});
  });
});
