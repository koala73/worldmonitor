import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  poolOptions: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    Pool: class MockPool {
      constructor(options: unknown) { mocks.poolOptions(options); }
      connect = mocks.connect;
      end = mocks.end;
      on = vi.fn();
    },
  },
}));

const { closePool, withTransaction, getPool } = await import('./client.js');

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
  it.each(['sslmode=disable', 'sslmode=no-verify', 'ssl=0', 'ssl=false', 'sslmode=verify-full&sslmode=no-verify', 'uselibpqcompat=true&sslmode=prefer'])(
    'rejects a remote URL that weakens TLS: %s', options => {
      vi.stubEnv('DATABASE_URL', `postgres://user@database.example/prices?${options}`);
      expect(() => getPool()).toThrow(/verified TLS/);
    });
  it.each(['', '?sslmode=verify-full', '?ssl=true&sslmode=verify-full&uselibpqcompat=true'])(
    'keeps certificate and hostname verification in the actual pg configuration: %s', async suffix => {
      vi.stubEnv('DATABASE_URL', `postgres://user@database.example/prices${suffix}`);
      getPool();
      const actual = await vi.importActual<typeof import('pg')>('pg');
      const client = new actual.default.Client(mocks.poolOptions.mock.lastCall![0]);
      const { ssl } = (client as unknown as { connectionParameters: { ssl: false | { rejectUnauthorized?: boolean; checkServerIdentity?: unknown } } }).connectionParameters;
      expect(ssl).not.toBe(false);
      expect(ssl && ssl.rejectUnauthorized).not.toBe(false);
      expect(ssl && ssl.checkServerIdentity).toBeUndefined();
    });
  it('verifies remote database certificates even with localhost in the password', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:localhost@database.example/prices');
    getPool();
    expect(mocks.poolOptions).toHaveBeenLastCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: true } }));
  });
  it('preserves local database access', () => {
    getPool();
    expect(mocks.poolOptions).toHaveBeenLastCalledWith(expect.objectContaining({ ssl: false }));
  });
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
