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
  return execFileSync('psql', [...psqlArgs, '--file', resolve(repoRoot, path)], {
    encoding: 'utf8',
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

// --- Retention contract, executed rather than pattern-matched (#6375) --------
//
// Every other check on scripts/umami-retention.sql is a regex over its text,
// which is exactly how the bug that motivated #6375 survived review: the file
// parsed, the assertions matched, and the tick still rolled back every night.
// Only a real server proves the psql meta-commands, the per-statement commit
// boundaries, and the advisory-lock stand-down behave as the file claims. Runs
// in the same path-filtered PostgreSQL job, which scripts/umami-retention.sql
// already triggers (.github/workflows/test.yml).

function createRetentionFixture() {
  psql(`
    DROP TABLE IF EXISTS event_data, website_event, session_data, revenue,
      session_replay, session_replay_saved, heatmap_event, session CASCADE;

    CREATE TABLE session (session_id uuid PRIMARY KEY, created_at timestamptz);
    CREATE TABLE website_event (
      event_id uuid PRIMARY KEY, session_id uuid, created_at timestamptz);
    CREATE TABLE event_data (
      event_data_id uuid PRIMARY KEY, website_event_id uuid, created_at timestamptz);
    CREATE TABLE session_data (
      session_data_id uuid PRIMARY KEY, session_id uuid, created_at timestamptz);
    CREATE TABLE revenue (
      revenue_id uuid PRIMARY KEY, website_id uuid, session_id uuid, created_at timestamptz);
    CREATE TABLE session_replay (
      replay_id uuid PRIMARY KEY, website_id uuid, session_id uuid, visit_id uuid,
      events bytea, created_at timestamptz);
    CREATE TABLE session_replay_saved (website_id uuid, visit_id uuid);
    CREATE TABLE heatmap_event (
      heatmap_event_id uuid PRIMARY KEY, website_id uuid, session_id uuid, created_at timestamptz);

    -- 'old' sits far outside any sane horizon and 'new' far inside it, so this
    -- fixture tests the mechanics without restating the horizon constant that
    -- tests/umami-storage-monitor.test.mjs pins exactly.
    INSERT INTO session (session_id, created_at) VALUES
      ('40000000-0000-0000-0000-000000000001', now() - interval '100 days'),
      ('40000000-0000-0000-0000-000000000002', now() - interval '1 day'),
      ('40000000-0000-0000-0000-000000000003', now() - interval '100 days'),
      -- old and childless: the only session this tick may actually collect
      ('40000000-0000-0000-0000-000000000004', now() - interval '100 days');

    INSERT INTO website_event (event_id, session_id, created_at) VALUES
      -- old, childless: must go
      ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', now() - interval '100 days'),
      -- old, with an old child: child goes first, then this
      ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', now() - interval '100 days'),
      -- old, but holding a NEW child: must survive, or child-before-parent is a lie
      ('41000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', now() - interval '100 days'),
      -- new: must survive
      ('41000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', now() - interval '1 day');

    INSERT INTO event_data (event_data_id, website_event_id, created_at) VALUES
      ('42000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000002', now() - interval '100 days'),
      ('42000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000003', now() - interval '1 day'),
      ('42000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000004', now() - interval '1 day');

    INSERT INTO session_data (session_data_id, session_id, created_at) VALUES
      ('43000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', now() - interval '100 days'),
      ('43000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', now() - interval '1 day');

    INSERT INTO revenue (revenue_id, website_id, session_id, created_at) VALUES
      ('44000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
       '40000000-0000-0000-0000-000000000001', now() - interval '100 days'),
      ('44000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001',
       '40000000-0000-0000-0000-000000000002', now() - interval '1 day');

    INSERT INTO heatmap_event (heatmap_event_id, website_id, session_id, created_at) VALUES
      ('45000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
       '40000000-0000-0000-0000-000000000001', now() - interval '100 days');

    -- One old replay is explicitly saved; the contract must never remove it.
    INSERT INTO session_replay_saved (website_id, visit_id) VALUES
      ('50000000-0000-0000-0000-000000000001', '46000000-0000-0000-0000-0000000000ff');
    INSERT INTO session_replay (replay_id, website_id, session_id, visit_id, events, created_at) VALUES
      ('46000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
       '40000000-0000-0000-0000-000000000001', '46000000-0000-0000-0000-0000000000aa',
       '\\x00'::bytea, now() - interval '100 days'),
      ('46000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001',
       '40000000-0000-0000-0000-000000000001', '46000000-0000-0000-0000-0000000000ff',
       '\\x00'::bytea, now() - interval '100 days');
  `);
}

function retentionState() {
  return psql(`
    SELECT 'website_event=' || (SELECT count(*)::text FROM website_event)
        || ' event_data='   || (SELECT count(*)::text FROM event_data)
        || ' session='      || (SELECT count(*)::text FROM session)
        || ' session_data=' || (SELECT count(*)::text FROM session_data)
        || ' revenue='      || (SELECT count(*)::text FROM revenue)
        || ' heatmap='      || (SELECT count(*)::text FROM heatmap_event)
        || ' replay='       || (SELECT count(*)::text FROM session_replay);
  `);
}

createRetentionFixture();
const beforeRetention = retentionState();

// `pg_try_advisory_lock` from a one-shot psql takes the lock and releases it
// again when that session exits, so this both polls and proves reachability.
function retentionLockIsFree() {
  return psql(`
    SELECT CASE WHEN pg_try_advisory_lock(hashtextextended('worldmonitor.umami.retention', 0))
           THEN 'free' ELSE 'held' END;
  `) === 'free';
}

function waitForRetentionLock(want, label) {
  // Killing the holder's client does NOT release its session lock until that
  // backend next touches the socket, so polling is the only correct wait here.
  // Getting this wrong is what made the first draft of this test silently
  // exercise the locked-out path twice and assert nothing.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (retentionLockIsFree() === (want === 'free')) return;
    execFileSync('sleep', ['0.5']);
  }
  assert.fail(`retention advisory lock never became ${want} (${label})`);
}

// A tick that cannot take the lock must exit 0 and touch nothing. This is the
// path that used to crash the container on lock_timeout.
const lockHolder = spawn('psql', [
  ...psqlArgs,
  '--command',
  "SELECT pg_advisory_lock(hashtextextended('worldmonitor.umami.retention', 0)); SELECT pg_sleep(30);",
], { env: psqlEnv, stdio: ['ignore', 'ignore', 'ignore'] });
try {
  waitForRetentionLock('held', 'holder never acquired it');

  const skipped = psqlFile('scripts/umami-retention.sql', ['ignore', 'pipe', 'pipe']);
  assert.match(
    skipped,
    /still holds the retention lock; skipping this tick/,
    'a locked-out tick must say why it did nothing, not exit quietly',
  );
  assert.equal(
    retentionState(),
    beforeRetention,
    'a tick locked out by a running tick must exit 0 without deleting anything',
  );
} finally {
  lockHolder.kill('SIGKILL');
}

// Now the real tick, with the lock provably free.
waitForRetentionLock('free', 'holder never released it');
const ticked = psqlFile('scripts/umami-retention.sql', ['ignore', 'pipe', 'pipe']);
assert.doesNotMatch(
  ticked,
  /skipping this tick/,
  'the measured tick must not have been locked out',
);

assert.equal(
  psql("SELECT string_agg(event_id::text, ',' ORDER BY event_id) FROM website_event;"),
  [
    // kept: old parent still holding a new child (child-before-parent)
    '41000000-0000-0000-0000-000000000003',
    // kept: inside the horizon
    '41000000-0000-0000-0000-000000000004',
  ].join(','),
  'retention must retire old events and keep any old event whose child survives',
);
assert.equal(
  psql("SELECT string_agg(event_data_id::text, ',' ORDER BY event_data_id) FROM event_data;"),
  [
    '42000000-0000-0000-0000-000000000002',
    '42000000-0000-0000-0000-000000000003',
  ].join(','),
  'retention must retire event_data past the horizon and keep the rest',
);
assert.equal(
  psql("SELECT count(*)::text FROM event_data d WHERE NOT EXISTS (SELECT 1 FROM website_event e WHERE e.event_id = d.website_event_id);"),
  '0',
  'no event_data row may outlive its parent event',
);
assert.equal(
  psql("SELECT string_agg(session_data_id::text, ',' ORDER BY session_data_id) FROM session_data;"),
  '43000000-0000-0000-0000-000000000002',
);
assert.equal(
  psql("SELECT string_agg(revenue_id::text, ',' ORDER BY revenue_id) FROM revenue;"),
  '44000000-0000-0000-0000-000000000002',
);
assert.equal(psql('SELECT count(*)::text FROM heatmap_event;'), '0');
assert.equal(
  psql("SELECT string_agg(replay_id::text, ',' ORDER BY replay_id) FROM session_replay;"),
  '46000000-0000-0000-0000-000000000002',
  'a saved replay must survive the retention contract',
);
assert.equal(
  psql("SELECT string_agg(session_id::text, ',' ORDER BY session_id) FROM session;"),
  [
    // session 1 is old and lost its events, session_data, revenue and heatmap
    // this tick — but it still owns the SAVED replay, which the contract
    // refuses to delete. Collecting the session would orphan that replay, so
    // the anti-join has to keep the session too.
    '40000000-0000-0000-0000-000000000001',
    // inside the horizon
    '40000000-0000-0000-0000-000000000002',
    // old, but still owns the event that its surviving child pinned
    '40000000-0000-0000-0000-000000000003',
    // session 4 (old, childless) is absent: proving sessions DO get collected,
    // so the three survivors above are a guard doing its job, not a dead delete
  ].join(','),
  'a session may only go once every relational child of it is gone',
);

// Re-running against an already-drained database must be a clean no-op, since
// that is what 95 of every 96 daily ticks actually do.
const drained = retentionState();
psqlFile('scripts/umami-retention.sql', ['ignore', 'pipe', 'pipe']);
assert.equal(retentionState(), drained, 'a tick with nothing eligible must change nothing');

console.log('Umami PostgreSQL migration, concurrent-upsert, and retention integration passed');
