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

    _pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
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
