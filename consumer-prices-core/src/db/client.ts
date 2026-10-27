import pg from 'pg';

const { Pool } = pg;

export type QueryExecutor = <T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    let url: URL | null = null;
    if (!databaseUrl.startsWith('/')) {
      // URL parse errors carry the input, which holds the database password.
      try { url = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL is not a valid connection URL'); }
    }
    if (['host', 'hostaddr', 'port'].some(name => url?.searchParams.has(name))) {
      throw new Error('DATABASE_URL must not override the connection endpoint via query parameters');
    }
    const local = !url || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url && !local && (
      url.searchParams.getAll('ssl').some(value => !['true', '1'].includes(value)) ||
      url.searchParams.getAll('sslmode').some(value => value !== 'verify-full')
    )) throw new Error('Remote DATABASE_URL requires verified TLS; use sslmode=verify-full');
    // Railway Postgres serves a chain from its own private root CA. Pinning that
    // root keeps chain and hostname verification on without trusting any CA.
    const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim();
    if (ca && !ca.startsWith('-----BEGIN CERTIFICATE-----')) {
      throw new Error('DATABASE_SSL_CA must be a PEM certificate');
    }

    // pg lets URL TLS params replace the `ssl` object below (dropping a pinned
    // CA). They were checked to be strict above, so the object is authoritative.
    if (url && !local) for (const name of ['ssl', 'sslmode', 'uselibpqcompat']) url.searchParams.delete(name);

    _pool = new Pool({
      connectionString: url && !local ? url.href : databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    });

    _pool.on('error', (err) => {
      console.error('[db] pool error:', err.message);
    });
  }
  return _pool;
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(sql, params);
}

export async function withTransaction<T>(work: (execute: QueryExecutor) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const execute: QueryExecutor = (sql, params) => client.query(sql, params);
  try {
    await client.query('BEGIN');
    const result = await work(execute);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback error:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await _pool?.end();
  _pool = null;
}
