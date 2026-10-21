// Runtime write probe for the managed Umami image.
//
// The sibling gate (umami-postgres-integration.mjs) proves the migration and
// the upsert SQL at the psql layer. This probe proves the APPLICATION can
// write: it boots the CI-built image against a disposable database, then
// exercises the exact paths the production write canary probes — a single
// identify, a concurrent same-key identify burst, and a named event — and
// asserts the rows actually land.
//
// Why this exists (#6043): the image can build green while its write path is
// dead. Two real shipped defects were invisible to every static check:
//   1. the upstream patch called `prisma.writeRawQuery`, which does not exist
//      in v3.2.0 — "patch applies" and "vitest passes" (query layer mocked)
//      were both true of an image whose every identify returned HTTP 500;
//   2. a corrupted compatibility shim emitted SQL placeholders as bare
//      integers (`values (1, 2, …)` instead of `$1, $2, …`) — syntactically
//      valid, byte-check-clean, and 100% write-fatal at runtime.
// Only a real POST through the running app catches this class.
//
// Requires: docker, psql, and UMAMI_TEST_DATABASE_URL pointing at a
// disposable PostgreSQL (the CI service container). The probe creates its own
// database (umami_runtime_probe) so the sibling gate's schema is untouched.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

const IMAGE = process.env.UMAMI_PROBE_IMAGE || 'worldmonitor/umami:ci';
const serviceUrl = process.env.UMAMI_TEST_DATABASE_URL;
assert.ok(
  serviceUrl,
  'UMAMI_TEST_DATABASE_URL is required; this probe never skips silently',
);

const serviceDbName = decodeURIComponent(new URL(serviceUrl).pathname.slice(1));
assert.match(
  serviceDbName,
  /(?:^umami_integration$|_test$)/,
  `refusing to run against non-test database ${JSON.stringify(serviceDbName)}`,
);

const PROBE_DB = 'umami_runtime_probe';
const probeUrl = new URL(serviceUrl);
probeUrl.pathname = `/${PROBE_DB}`;
// The app container runs with --network host, so 127.0.0.1 inside the
// container is the runner's loopback where the PG service port is mapped.
const containerDbUrl = probeUrl.toString();

const APP_PORT = 3000;
const APP = `http://127.0.0.1:${APP_PORT}`;
const CONTAINER = 'umami-runtime-probe';
const WEBSITE_ID = '7d3e1f5a-9b2c-4d8e-a1f6-0c5b4e8d7a92';
// A real browser UA: umami bot-filters non-browser agents, so a bare
// node/curl UA would make every write silently vanish and fail the probe for
// the wrong reason.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function psql(sql, dbUrl = containerDbUrl) {
  return execFileSync(
    'psql',
    ['-X', '--set=ON_ERROR_STOP=1', '--no-align', '--tuples-only', `--dbname=${dbUrl}`, '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function docker(args, opts = {}) {
  const res = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  return res;
}

function cleanup() {
  docker(['rm', '-f', CONTAINER]);
}

async function post(body) {
  const res = await fetch(`${APP}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  return res;
}

function identifyPayload(data) {
  return {
    type: 'identify',
    payload: { website: WEBSITE_ID, hostname: 'probe.local', url: '/', data },
  };
}

let failed = false;
try {
  // -- database ------------------------------------------------------------
  psql(`DROP DATABASE IF EXISTS ${PROBE_DB};`, serviceUrl);
  psql(`CREATE DATABASE ${PROBE_DB};`, serviceUrl);

  // -- schema via the image's own migrate deploy ---------------------------
  const mig = docker([
    'run', '--rm', '--network', 'host',
    '-e', `DATABASE_URL=${containerDbUrl}`,
    '--entrypoint', 'sh', IMAGE, '-c', 'pnpm exec prisma migrate deploy',
  ]);
  assert.equal(mig.status, 0, `prisma migrate deploy failed:\n${mig.stdout}\n${mig.stderr}`);

  // -- seed ----------------------------------------------------------------
  psql(`
    insert into "user" (user_id, username, password, role, created_at)
    values ('11111111-1111-1111-1111-111111111111','probe','$2b$10$abcdefghijklmnopqrstuv','admin',now());
    insert into website (website_id, name, domain, created_at, user_id)
    values ('${WEBSITE_ID}','probe','probe.local',now(),'11111111-1111-1111-1111-111111111111');
  `);

  // -- boot the app --------------------------------------------------------
  cleanup();
  const run = docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'host',
    '-e', `DATABASE_URL=${containerDbUrl}`,
    '-e', 'APP_SECRET=runtime-probe-secret',
    IMAGE,
  ]);
  assert.equal(run.status, 0, `container failed to start: ${run.stderr}`);

  let alive = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${APP}/api/heartbeat`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) { alive = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  assert.ok(alive, 'app never reached a healthy heartbeat within 120s');

  // -- 1. single identify must persist -------------------------------------
  const single = await post(identifyPayload({ probe_single: 'v1' }));
  assert.equal(single.status, 200, `single identify returned HTTP ${single.status}`);
  assert.equal(
    psql('select count(*) from session_data;'),
    '1',
    'single identify did not land a session_data row',
  );

  // -- 2. concurrent same-key burst: atomic upsert, no P2002 ---------------
  const burst = await Promise.all(
    Array.from({ length: 6 }, (_, n) => post(identifyPayload({ probe_shared: `v${n}` }))),
  );
  for (const [n, res] of burst.entries()) {
    assert.equal(res.status, 200, `burst identify #${n} returned HTTP ${res.status}`);
  }
  const dupes = psql(
    'select count(*) - count(distinct (session_id, data_key)) from session_data;',
  );
  assert.equal(dupes, '0', `concurrent burst produced ${dupes} duplicate (session_id, data_key) rows`);
  assert.equal(
    psql("select count(*) from session_data where data_key = 'probe_shared';"),
    '1',
    'concurrent same-key burst must collapse to exactly one row',
  );

  // -- 3. event path must persist ------------------------------------------
  const event = await post({
    type: 'event',
    payload: { website: WEBSITE_ID, hostname: 'probe.local', url: '/probe', name: 'runtime-probe' },
  });
  assert.equal(event.status, 200, `event returned HTTP ${event.status}`);
  assert.equal(
    psql('select count(*) from website_event;'),
    '1',
    'event did not land a website_event row',
  );

  // -- 4. the app log must be silent ---------------------------------------
  const logs = docker(['logs', CONTAINER]);
  const logText = `${logs.stdout}\n${logs.stderr}`;
  for (const marker of ['P2002', 'is not a function', 'PrismaClientKnownRequestError', 'cannot cast', 'cannot be matched']) {
    assert.ok(
      !logText.includes(marker),
      `app log contains "${marker}" — the write path is degraded even though HTTP said 200`,
    );
  }

  console.log('umami runtime write probe: PASS (identify, concurrent upsert, event, clean log)');
} catch (error) {
  failed = true;
  console.error(String(error?.stack || error));
  const logs = docker(['logs', CONTAINER]);
  console.error('--- container log tail ---');
  console.error(`${logs.stdout}\n${logs.stderr}`.split('\n').slice(-40).join('\n'));
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
