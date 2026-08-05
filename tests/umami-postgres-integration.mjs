import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.UMAMI_TEST_DATABASE_URL;

assert.ok(
  databaseUrl,
  'UMAMI_TEST_DATABASE_URL is required; this integration gate never skips silently',
);

const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
assert.match(
  databaseName,
  /(?:^umami_integration$|_test$)/,
  `refusing to reset integration schema in non-test database ${JSON.stringify(databaseName)}`,
);

const psqlArgs = [
  '-X',
  '--set=ON_ERROR_STOP=1',
  '--no-align',
  '--tuples-only',
  `--dbname=${databaseUrl}`,
];
const psqlEnv = {
  ...process.env,
  PGOPTIONS: '-c search_path=wm_umami_integration',
};

function psql(sql) {
  return execFileSync('psql', [...psqlArgs, '--command', sql], {
    encoding: 'utf8',
    env: psqlEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function psqlFile(path, stdio = ['ignore', 'inherit', 'inherit']) {
  execFileSync('psql', [...psqlArgs, '--file', resolve(repoRoot, path)], {
    env: psqlEnv,
    stdio,
  });
}

function psqlConcurrent(sql) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('psql', [...psqlArgs, '--command', sql], {
      env: psqlEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`concurrent psql write exited ${code}: ${stderr.trim()}`));
    });
  });
}

function readUpsertFixture() {
  const sql = readFileSync(
    resolve(repoRoot, 'docker/umami/runtime/session-data-upsert.sql'),
    'utf8',
  ).trim();
  assert.match(sql, /on conflict \(session_id, data_key\)/i);
  return sql;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderUpsert(template, writer) {
  const replacements = {
    id: sqlString(`10000000-0000-0000-0000-${String(writer).padStart(12, '0')}`),
    websiteId: sqlString('20000000-0000-0000-0000-000000000001'),
    sessionId: sqlString('30000000-0000-0000-0000-000000000001'),
    dataKey: sqlString('concurrent-key'),
    stringValue: sqlString(`writer-${writer}`),
    numberValue: 'NULL',
    dateValue: 'NULL',
    dataType: '1',
    distinctId: sqlString(`distinct-${writer}`),
    createdAt: `TIMESTAMPTZ '2026-08-02T00:00:${String(writer).padStart(2, '0')}.000Z'`,
  };

  const sql = template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => {
    assert.ok(Object.hasOwn(replacements, name), `no SQL test value for ${placeholder}`);
    return replacements[name];
  });
  assert.doesNotMatch(sql, /\{\{\w+\}\}/, 'rendered upsert retained a placeholder');
  return sql;
}

function createSessionDataFixture() {
  psql(`
    DROP SCHEMA IF EXISTS wm_umami_integration CASCADE;
    CREATE SCHEMA wm_umami_integration;
    CREATE TABLE session_data (
      session_data_id uuid PRIMARY KEY,
      website_id uuid NOT NULL,
      session_id uuid NOT NULL,
      data_key varchar(500) NOT NULL,
      string_value varchar(500),
      number_value numeric,
      date_value timestamptz,
      data_type integer NOT NULL,
      distinct_id varchar(500),
      created_at timestamptz
    );
    INSERT INTO session_data (
      session_data_id, website_id, session_id, data_key,
      string_value, data_type, created_at
    ) VALUES
      ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000010', 'plan', 'older', 1, '2026-08-01T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000010', 'plan', 'newer-by-time', 1, '2026-08-02T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000010', 'plan', 'null-is-last', 1, NULL),
      ('00000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000011', 'tier', 'lower-id', 1, '2026-08-02T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000011', 'tier', 'higher-id-tiebreak', 1, '2026-08-02T00:00:00Z');
  `);
}

createSessionDataFixture();
psql('CREATE INDEX "session_data_session_id_data_key_key" ON session_data (session_id);');

let failedMigration;
try {
  psqlFile('docker/umami/21_update_session_data/migration.sql', ['ignore', 'pipe', 'pipe']);
} catch (error) {
  failedMigration = error;
}
assert.ok(failedMigration, 'migration must fail when its unique-index name is already occupied');
assert.equal(
  psql('SELECT (count(*) - count(DISTINCT (session_id, data_key)))::text FROM session_data;'),
  '3',
  'failed migration must roll back duplicate deletion',
);
assert.equal(
  psql(`
    SELECT count(*)::text
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'session_data_session_id_data_key_key';
  `),
  '1',
  'failed migration must leave the pre-existing index intact',
);

createSessionDataFixture();

psqlFile('docker/umami/21_update_session_data/migration.sql');

const survivors = psql(`
  SELECT data_key || '|' || session_data_id::text || '|' || string_value
  FROM session_data
  ORDER BY data_key;
`);
assert.equal(
  survivors,
  [
    'plan|00000000-0000-0000-0000-000000000002|newer-by-time',
    'tier|00000000-0000-0000-0000-000000000005|higher-id-tiebreak',
  ].join('\n'),
);

const indexState = psql(`
  SELECT
    CASE WHEN i.indisunique THEN '1' ELSE '0' END || '|' ||
    CASE WHEN i.indisvalid THEN '1' ELSE '0' END || '|' ||
    CASE WHEN i.indisready THEN '1' ELSE '0' END || '|' ||
    pg_get_indexdef(i.indexrelid)
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'session_data_session_id_data_key_key';
`);
assert.match(indexState, /^1\|1\|1\|CREATE UNIQUE INDEX /);
assert.match(indexState, /\(session_id, data_key\)$/);

const upsert = readUpsertFixture();
await Promise.all(
  Array.from({ length: 24 }, (_, index) => psqlConcurrent(renderUpsert(upsert, index + 1))),
);

const concurrentState = psql(`
  SELECT count(*)::text || '|' || min(string_value)
  FROM session_data
  WHERE session_id = '30000000-0000-0000-0000-000000000001'
    AND data_key = 'concurrent-key';
`);
assert.match(concurrentState, /^1\|writer-\d+$/);

console.log('Umami PostgreSQL migration and concurrent-upsert integration passed');
