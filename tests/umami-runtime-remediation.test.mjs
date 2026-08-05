import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UMAMI_RELEASE_COMMIT = '2f6e2b5ff256862a081d9e74bed18a42ebf795e3';
const UMAMI_FIX_COMMIT = '7c030e4c5da4b5fdf3e75e80787a0344b040ac8a';

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('Umami runtime remediation (#6024)', () => {
  it('builds from the exact v3.2.0 release plus only the upstream session-data fix', () => {
    const dockerfile = read('Dockerfile.umami');
    const fromLines = dockerfile.match(/^FROM\s+.+$/gm) ?? [];

    assert.ok(fromLines.length >= 4, 'expected source, dependency, builder, and runtime stages');
    for (const line of fromLines) {
      assert.match(
        line,
        /@sha256:[a-f0-9]{64}(?:\s+AS\s+\w+)?$/i,
        `Docker base image must be digest-pinned: ${line}`,
      );
    }
    assert.match(dockerfile, new RegExp(`git fetch --depth=1 origin ${UMAMI_RELEASE_COMMIT}`));
    assert.match(dockerfile, new RegExp(`git fetch --depth=2 origin ${UMAMI_FIX_COMMIT}`));
    assert.match(dockerfile, new RegExp(`git checkout --detach ${UMAMI_RELEASE_COMMIT}`));
    assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.revision=${UMAMI_RELEASE_COMMIT}`));
    assert.match(dockerfile, new RegExp(`worldmonitor\\.umami\\.fix-commit=${UMAMI_FIX_COMMIT}`));
    assert.match(dockerfile, /COPY docker\/umami\/session-data-upsert\.patch/);
    assert.match(dockerfile, /git apply --check/);
    assert.match(dockerfile, /COPY docker\/umami\/21_update_session_data\/migration\.sql/);
    assert.match(
      dockerfile,
      /cmp -s \/tmp\/upstream-session-data-upsert\.patch \/tmp\/session-data-upsert\.patch/,
    );
    assert.match(
      dockerfile,
      new RegExp(`${UMAMI_FIX_COMMIT}:prisma/migrations/23_update_session_data/migration\\.sql`),
    );
    assert.match(
      dockerfile,
      /cmp -s \/tmp\/upstream-update-session-data\.sql \/tmp\/upstream-23-update-session-data\.sql/,
    );
    assert.match(
      dockerfile,
      /cmp -s \/tmp\/expected-21-update-session-data\.sql \/tmp\/21_update_session_data\.sql/,
    );
    assert.match(
      dockerfile,
      /^COPY docker\/umami\/runtime\/package\.json docker\/umami\/runtime\/pnpm-lock\.yaml docker\/umami\/runtime\/pnpm-workspace\.yaml \.\/$/m,
    );
    assert.match(dockerfile, /^RUN pnpm install --prod --frozen-lockfile(?:[ \t]+\\)?$/m);
    assert.match(
      dockerfile,
      /RUN pnpm vitest run src\/queries\/sql\/sessions\/saveSessionData\.test\.ts/,
    );
    assert.doesNotMatch(dockerfile, /umami(?:software)?\/umami:(?:latest|postgresql-latest|3\.2\.0)/i);
  });

  it('carries only the upstream relational upsert and schema changes', () => {
    const patch = read('docker/umami/session-data-upsert.patch');
    const addedSource = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    const changedPaths = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
      .map((match) => [match[1], match[2]]);

    assert.deepEqual(changedPaths, [
      ['prisma/schema.prisma', 'prisma/schema.prisma'],
      ['src/queries/sql/sessions/saveSessionData.ts', 'src/queries/sql/sessions/saveSessionData.ts'],
      ['src/queries/sql/sessions/saveSessionData.test.ts', 'src/queries/sql/sessions/saveSessionData.test.ts'],
    ]);
    assert.match(patch, /@@unique\(\[sessionId, dataKey\]\)/);
    assert.match(patch, /insert into session_data/i);
    assert.match(patch, /on conflict \(session_id, data_key\)/i);
    assert.match(patch, /do update set/i);
    assert.doesNotMatch(addedSource, /sessionData\.updateMany/);
    assert.doesNotMatch(addedSource, /sessionData\.create/);
  });

  it('bounds pool acquisition so a saturated pool fails fast instead of queueing forever', () => {
    const patch = read('docker/umami/v320-compat.patch');
    const addedSource = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');

    // pg.Pool defaults connectionTimeoutMillis to 0, and pg-pool treats 0 as
    // "queue the caller with no timer at all" — the #6053 indefinite hang. Every
    // adapter must therefore carry the bound, not just the one we happened to hit.
    const adapters = [...addedSource.matchAll(/new PrismaPg\(([\s\S]*?)\)\s*;/g)];

    assert.equal(adapters.length, 2, 'expected the base and replica adapters to be patched');
    for (const adapter of adapters) {
      assert.ok(
        adapter[1].includes('...getPoolOptions()'),
        `PrismaPg pool built without a bounded acquisition timeout: ${adapter[0]}`,
      );
    }

    // Execute the helper we actually ship rather than pattern-matching its text.
    const declaration = addedSource.indexOf('const DEFAULT_POOL_CONNECT_TIMEOUT_MS');
    const bodyEnd = addedSource.indexOf('\n}', addedSource.indexOf('function getPoolOptions()')) + 2;

    assert.ok(declaration >= 0 && bodyEnd > declaration, 'getPoolOptions() missing from the patch');

    const getPoolOptions = new Function(
      `${addedSource.slice(declaration, bodyEnd)}\nreturn getPoolOptions;`,
    )();
    const previous = process.env.DATABASE_CONNECT_TIMEOUT_MS;

    try {
      delete process.env.DATABASE_CONNECT_TIMEOUT_MS;
      assert.equal(getPoolOptions().connectionTimeoutMillis, 10000);

      process.env.DATABASE_CONNECT_TIMEOUT_MS = '2500';
      assert.equal(getPoolOptions().connectionTimeoutMillis, 2500);

      for (const invalid of ['0', '-1', 'abc', '']) {
        process.env.DATABASE_CONNECT_TIMEOUT_MS = invalid;
        assert.equal(
          getPoolOptions().connectionTimeoutMillis,
          10000,
          `${JSON.stringify(invalid)} must fall back to the bounded default, never 0 (unbounded)`,
        );
      }
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_CONNECT_TIMEOUT_MS;
      } else {
        process.env.DATABASE_CONNECT_TIMEOUT_MS = previous;
      }
    }
  });

  it('fails the image build when a PrismaPg pool loses its acquisition bound', () => {
    const dockerfile = read('Dockerfile.umami');

    assert.match(dockerfile, /new PrismaPg\\\(\(\[\\s\\S\]\*\?\)\\\)\\s\*;/);
    assert.match(dockerfile, /\.\.\.getPoolOptions\(\)/);
    assert.match(dockerfile, /connectionTimeoutMillis to 0 and queue callers forever/);
  });

  it('deduplicates deterministically before creating the composite unique index', () => {
    const migration = read('docker/umami/21_update_session_data/migration.sql');

    assert.match(migration, /PARTITION BY "session_id", "data_key"/);
    assert.match(
      migration,
      /ORDER BY "created_at" DESC NULLS LAST, "session_data_id" DESC/,
    );
    assert.match(migration, /ranked_session_data\.row_num > 1/);
    assert.match(
      migration,
      /CREATE UNIQUE INDEX "session_data_session_id_data_key_key"\s+ON "session_data"\("session_id", "data_key"\)/m,
    );
    assert.match(migration, /^BEGIN;$/m);
    assert.match(migration, /^SET LOCAL lock_timeout = '5s';$/m);
    assert.match(migration, /^SET LOCAL statement_timeout = '45min';$/m);
    assert.match(migration, /^COMMIT;$/m);
    assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  });

  it('runs bounded retention on a pinned Postgres client without shell interpolation', () => {
    const dockerfile = read('Dockerfile.umami-retention');
    const executableSql = read('scripts/umami-retention.sql').replace(/^\s*--.*$/gmu, '');

    assert.match(
      dockerfile,
      /^FROM postgres:17-alpine@sha256:[a-f0-9]{64}$/m,
    );
    assert.match(
      dockerfile,
      /^COPY --chmod=0444 scripts\/umami-retention\.sql \/app\/umami-retention\.sql$/m,
    );
    assert.match(dockerfile, /^ENV PGCONNECT_TIMEOUT=10$/m);
    assert.match(
      dockerfile,
      /^CMD \["psql", "-X", "--set=ON_ERROR_STOP=1", "--file=\/app\/umami-retention\.sql"\]$/m,
    );
    assert.doesNotMatch(dockerfile, /(?:sh|bash)\s+-c|\$\{?DATABASE_URL/i);
    assert.match(executableSql, /LIMIT 10000/);
    assert.match(executableSql, /pg_advisory_xact_lock/);
    assert.doesNotMatch(executableSql, /\bTRUNCATE\b/i);
  });

  it('keeps the concurrent upsert in a stable fixture verified by the image build', () => {
    const fixture = read('docker/umami/runtime/session-data-upsert.sql');
    const dockerfile = read('Dockerfile.umami');
    const integration = read('tests/umami-postgres-integration.mjs');

    assert.match(fixture, /insert into session_data/i);
    assert.match(fixture, /on conflict \(session_id, data_key\)/i);
    assert.match(fixture, /do update set/i);
    assert.match(fixture, /\{\{createdAt\}\}/);
    assert.match(
      dockerfile,
      /^COPY docker\/umami\/runtime\/session-data-upsert\.sql \/tmp\/session-data-upsert\.sql$/m,
    );
    assert.match(dockerfile, /session-data-upsert\.sql/);
    assert.match(
      integration,
      /docker\/umami\/runtime\/session-data-upsert\.sql/,
    );
    assert.doesNotMatch(integration, /session-data-upsert\.patch/);
  });

  it('registers the patched collector and a capacity-sufficient retention cron', () => {
    const registry = JSON.parse(read('scripts/railway-services.json'));
    const collector = registry.find((entry) => entry.service === 'umami');
    const retention = registry.find((entry) => entry.service === 'umami-retention');

    assert.deepEqual(collector, {
      entry: 'Dockerfile.umami',
      deployMode: 'dockerfile',
      dockerfile: 'Dockerfile.umami',
      service: 'umami',
      requiredEnv: ['APP_SECRET', 'DATABASE_URL'],
      watchPatterns: [],
      cronSchedule: null,
      documentedAt: 'docs/analytics-collector-operations.md#patched-runtime-image',
    });
    assert.deepEqual(retention, {
      entry: 'scripts/umami-retention.sql',
      deployMode: 'dockerfile',
      dockerfile: 'Dockerfile.umami-retention',
      service: 'umami-retention',
      lifecycle: 'active',
      requiredEnv: ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
      watchPatterns: [
        'scripts/umami-retention.sql',
        'Dockerfile.umami-retention',
      ],
      cronSchedule: '7,22,37,52 * * * *',
      documentedAt: 'docs/analytics-collector-operations.md#retention-runner',
    });

    // Four bounded 10k batches/hour can retire 960k event rows/day, safely
    // above the ~300k/day observed before #6024. A once-daily runner would
    // permanently fall behind even though it technically "ran".
    assert.equal(retention.cronSchedule.split(',').length, 4);
  });

  it('runs the real migration and concurrent upserts in a path-filtered PostgreSQL CI job', () => {
    const workflow = read('.github/workflows/test.yml');
    const deployGate = read('.github/workflows/deploy-gate.yml');
    const integration = read('tests/umami-postgres-integration.mjs');
    const umamiJob = workflow.match(/^ {2}umami-postgres:\n[\s\S]*?(?=^ {2}[a-z][a-z0-9-]+:\n)/m)?.[0];

    assert.match(workflow, /^\s{6}umami: \$\{\{ steps\.diff\.outputs\.umami \}\}$/m);
    assert.ok(umamiJob, 'expected a dedicated umami-postgres CI job');
    assert.match(workflow, /\^Dockerfile\\\.umami-retention\$\//);
    assert.match(workflow, /\^scripts\\\/umami-retention\\\.sql\$\//);
    assert.match(
      umamiJob,
      /image: postgres:17-alpine@sha256:[a-f0-9]{64}/,
    );
    assert.match(umamiJob, /^\s{4}timeout-minutes: 20$/m);
    assert.match(umamiJob, /docker build --file Dockerfile\.umami --tag worldmonitor\/umami:ci \./);
    assert.match(
      umamiJob,
      /docker build --file Dockerfile\.umami-retention --tag worldmonitor\/umami-retention:ci \./,
    );
    assert.match(umamiJob, /node tests\/umami-postgres-integration\.mjs/);
    assert.match(deployGate, /required='\[[^\n]*"umami-postgres"[^\n]*\]'/);
    assert.match(integration, /docker\/umami\/21_update_session_data\/migration\.sql/);
    assert.match(integration, /Promise\.all\(/);
    assert.match(integration, /indisunique/);
    assert.doesNotMatch(integration, /\bskip\b|\.skip\(/i);
  });
});
