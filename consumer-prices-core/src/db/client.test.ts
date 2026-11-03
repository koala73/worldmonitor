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
  it.each(['host=database.example', 'hostaddr=203.0.113.1', 'port=6543', 'host=localhost&host=database.example'])(
    'rejects endpoint query overrides before pg can reclassify a local connection: %s', options => {
      vi.stubEnv('DATABASE_URL', `postgres://user@127.0.0.1/prices?${options}`);
      expect(() => getPool()).toThrow(/endpoint/);
    });
  it('rejects an unparseable URL without echoing its credentials', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:s3cret-password@database.example:99999/prices');
    let error: unknown;
    try { getPool(); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('s3cret-password');
    expect((error as Error).cause).toBeUndefined();
  });
  it('preserves a local Unix socket connection string', async () => {
    vi.stubEnv('DATABASE_URL', '/var/run/postgresql prices');
    getPool();
    const actual = await vi.importActual<typeof import('pg')>('pg');
    const client = new actual.default.Client(mocks.poolOptions.mock.lastCall![0]);
    expect((client as unknown as { connectionParameters: { host: string; database: string; ssl: boolean } }).connectionParameters)
      .toMatchObject({ host: '/var/run/postgresql', database: 'prices', ssl: false });
  });
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
  it.each(['', '?sslmode=verify-full'])('pins DATABASE_SSL_CA in the actual pg configuration with verification on: %s', async suffix => {
    vi.stubEnv('DATABASE_URL', `postgres://user@postgres.railway.internal/prices${suffix}`);
    vi.stubEnv('DATABASE_SSL_CA', '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----');
    getPool();
    const actual = await vi.importActual<typeof import('pg')>('pg');
    const client = new actual.default.Client(mocks.poolOptions.mock.lastCall![0]);
    const { ssl } = (client as unknown as { connectionParameters: { ssl: false | { rejectUnauthorized?: boolean; ca?: string } } }).connectionParameters;
    expect(ssl && ssl.rejectUnauthorized).not.toBe(false);
    expect(ssl && ssl.ca).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
  });
  it('rejects a DATABASE_SSL_CA that is not a PEM certificate', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user@postgres.railway.internal/prices');
    vi.stubEnv('DATABASE_SSL_CA', 'true');
    expect(() => getPool()).toThrow(/PEM certificate/);
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
