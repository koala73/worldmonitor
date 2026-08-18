import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    Pool: class MockPool {
      connect = mocks.connect;
      end = mocks.end;
      on = vi.fn();
    },
  },
}));

const { closePool, withTransaction } = await import('./client.js');

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost/consumer-prices-test');
  mocks.clientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.release.mockReset();
  mocks.connect.mockReset().mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.release,
  });
  mocks.end.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await closePool();
  vi.unstubAllEnvs();
});

describe('withTransaction', () => {
  it('commits work on one client', async () => {
    await withTransaction(async (execute) => {
      await execute('UPDATE product_matches SET match_status = $1', ['candidate']);
    });

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'UPDATE product_matches SET match_status = $1',
      'COMMIT',
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rolls back the match write when the observation write fails', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'INSERT observation') throw new Error('observation failed');
      return { rows: [], rowCount: 0 };
    });

    await expect(withTransaction(async (execute) => {
      await execute('UPDATE match');
      await execute('INSERT observation');
    })).rejects.toThrow('observation failed');

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'UPDATE match',
      'INSERT observation',
      'ROLLBACK',
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
