import { beforeEach, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/client.js', () => ({ query: mockQuery }));

const { buildOverviewSnapshot, buildBasketSeriesSnapshot, buildCategoriesSnapshot } = await import('./worldmonitor.js');
const { INDEX_METHODOLOGY_VERSION } = await import('../index-methodology.js');

type Period = 'today' | 'week' | 'month';
interface IndexRow { period: Period; metric_key: string; metric_value: string; methodology_version: string }

// Fake computed_indices: returns the rows a period query asks for, dropping
// essentials_index / value_index rows of other methodology versions ONLY when
// the SQL actually carries the version filter and binds the current version.
function overviewDb(rows: IndexRow[]) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (!sql.includes('FROM computed_indices ci') || !sql.includes('ci.category IS NULL')) return { rows: [] };
    const period: Period = sql.includes("INTERVAL '6 days'") ? 'week' : sql.includes("INTERVAL '29 days'") ? 'month' : 'today';
    const filtered = sql.includes("ci.metric_key NOT IN ('essentials_index', 'value_index') OR ci.methodology_version = $2");
    return {
      rows: rows.filter((r) => r.period === period &&
        (!filtered || !['essentials_index', 'value_index'].includes(r.metric_key) || r.methodology_version === params[1])),
    };
  });
}

beforeEach(() => { mockQuery.mockReset(); });

it('does not compare a version-2 index against version-1 fallback history', async () => {
  overviewDb([
    { period: 'today', metric_key: 'essentials_index', metric_value: '116.15', methodology_version: '2' },
    { period: 'today', metric_key: 'value_index', metric_value: '110', methodology_version: '2' },
    { period: 'today', metric_key: 'coverage_pct', metric_value: '80', methodology_version: '2' },
    { period: 'week', metric_key: 'essentials_index', metric_value: '100', methodology_version: '1' },
    { period: 'month', metric_key: 'essentials_index', metric_value: '100', methodology_version: '1' },
  ]);
  const o = await buildOverviewSnapshot('ae');
  expect(o.essentialsIndex).toBe(116.2);
  expect(o.valueBasketIndex).toBe(110);
  expect(o.wowPct).toBe(0);
  expect(o.momPct).toBe(0);
});

it('compares against version-2 history once it exists', async () => {
  overviewDb([
    { period: 'today', metric_key: 'essentials_index', metric_value: '110', methodology_version: '2' },
    { period: 'today', metric_key: 'coverage_pct', metric_value: '80', methodology_version: '2' },
    { period: 'week', metric_key: 'essentials_index', metric_value: '100', methodology_version: '2' },
    { period: 'month', metric_key: 'essentials_index', metric_value: '88', methodology_version: '2' },
  ]);
  const o = await buildOverviewSnapshot('ae');
  expect(o.wowPct).toBe(10);
  expect(o.momPct).toBe(25);
});

it('keeps non-index metrics from version-1 rows', async () => {
  overviewDb([
    { period: 'today', metric_key: 'essentials_index', metric_value: '100', methodology_version: '1' },
    { period: 'today', metric_key: 'essentials_index', metric_value: '103', methodology_version: '2' },
    { period: 'today', metric_key: 'coverage_pct', metric_value: '75', methodology_version: '1' },
  ]);
  const o = await buildOverviewSnapshot('ae');
  expect(o.coveragePct).toBe(75);
  expect(o.essentialsIndex).toBe(103);
});

it('series reads only current-methodology index points', async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await buildBasketSeriesSnapshot('ae', 'essentials-ae', '30d');
  const seriesCalls = mockQuery.mock.calls.filter(([sql]) => (sql as string).includes("ci.metric_key = '"));
  expect(seriesCalls).toHaveLength(2);
  for (const [sql, params] of seriesCalls) {
    expect(sql).toContain('ci.methodology_version = $4');
    expect((params as unknown[])[3]).toBe(INDEX_METHODOLOGY_VERSION);
  }
});

it('categories compare only current-methodology category indices', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'basket' }] }).mockResolvedValue({ rows: [] });
  await buildCategoriesSnapshot('ae', '7d');
  const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
  const today = sql.slice(sql.indexOf('WITH today AS'), sql.indexOf('prev_period AS'));
  const prev = sql.slice(sql.indexOf('prev_period AS'), sql.indexOf('item_counts AS'));
  for (const cte of [today, prev]) expect(cte).toContain("(metric_key <> 'essentials_index' OR methodology_version = $3)");
  expect(params[2]).toBe(INDEX_METHODOLOGY_VERSION);
});
