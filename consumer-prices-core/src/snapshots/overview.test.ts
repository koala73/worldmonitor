import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client.js', () => ({ query }));
const { buildOverviewSnapshot } = await import('./worldmonitor.js');

// Answers each overview query from the latest-date metrics; every other query is empty.
function serve(latest: Array<[string, number]>) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT b.id FROM baskets')) return { rows: [] };
    if (sql.includes('ci.metric_key, ci.metric_value') && !sql.includes('INTERVAL')) {
      return { rows: latest.map(([metric_key, v]) => ({ metric_key, metric_value: String(v) })) };
    }
    return { rows: [] };
  });
}

beforeEach(() => { query.mockReset(); });

it('publishes an emptied basket as unavailable, not as its last index', async () => {
  serve([['coverage_pct', 0]]);
  const overview = await buildOverviewSnapshot('in');
  expect(overview).toMatchObject({ upstreamUnavailable: true, essentialsIndex: 0, coveragePct: 0 });
});

it('publishes a market that was never aggregated as unavailable', async () => {
  serve([]);
  expect((await buildOverviewSnapshot('ke')).upstreamUnavailable).toBe(true);
});

it('publishes covered rows with no current-methodology index as unavailable, not as 100', async () => {
  serve([['coverage_pct', 80]]);
  expect(await buildOverviewSnapshot('in')).toMatchObject({ upstreamUnavailable: true, essentialsIndex: 0 });
});

it('publishes a covered basket', async () => {
  serve([['essentials_index', 104.2], ['value_index', 101], ['coverage_pct', 80]]);
  expect(await buildOverviewSnapshot('ae')).toMatchObject({
    upstreamUnavailable: false, essentialsIndex: 104.2, coveragePct: 80,
  });
});
