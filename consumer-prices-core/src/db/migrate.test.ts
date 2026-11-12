import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  clientQuery: vi.fn(async (_query: unknown, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
  release: vi.fn(),
  end: vi.fn(async () => undefined),
}));

vi.mock('dotenv/config', () => ({}));
vi.mock('./client.js', () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
    end: mocks.end,
  }),
}));

describe('migration runner', () => {
  it('lifts the request-path statement and query deadlines for each migration', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('./migrate.js');
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalled());

    const calls = mocks.clientQuery.mock.calls.map(([query]) => query as string | { text: string; query_timeout?: number });
    const begins = calls.flatMap((query, index) => (query === 'BEGIN' ? [index] : []));
    expect(begins.length).toBeGreaterThan(0);
    for (const begin of begins) {
      // The pool's 30s statement_timeout is for request paths, not schema changes.
      expect(calls[begin + 1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
      const migration = calls[begin + 2] as { text: string; query_timeout?: number };
      expect(typeof migration).toBe('object');
      // pg treats query_timeout 0 as unset and falls back to the pool's 35s.
      expect(migration.query_timeout).toBeGreaterThan(35_000);
    }
  });
});
