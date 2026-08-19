// Verifies _bundle-runner.mjs streams child stdio live, reports timeout with
// a clear reason, and escalates SIGTERM → SIGKILL when a child ignores SIGTERM.
//
// Uses a real spawn of a small bundle against ephemeral scripts under scripts/
// because the runner joins __dirname with section.script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRACEFUL_FETCH_FAILURE_EXIT_CODE } from '../scripts/_seed-utils.mjs';
import { DAY, readSectionFreshness, bundleHeartbeatKey, BUNDLE_HEARTBEAT_TTL_SECONDS } from '../scripts/_bundle-runner.mjs';
import {
  SUPERSEDED_KEY_TTL_SECONDS,
  atomicSwitch,
  backfillSeedMetaFromActiveVersion,
} from '../scripts/seed-military-bases.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));
const FIXTURES_DIR = join(SCRIPTS_DIR, 'fixtures');
const fixtureScript = (name) => `fixtures/${name}`;
mkdirSync(FIXTURES_DIR, { recursive: true });

test('requireCanonical ignores fresh legacy meta when a new canonical envelope is absent', async () => {
  const reads = [];
  const freshness = await readSectionFreshness({
    canonicalKey: 'economic:china:macro:v2',
    seedMetaKey: 'economic:china-macro',
    requireCanonical: true,
  }, async (key) => {
    reads.push(key);
    if (key === 'economic:china:macro:v2') return null;
    return { fetchedAt: Date.now() };
  });
  assert.equal(freshness, null);
  assert.deepEqual(reads, ['economic:china:macro:v2']);
});

test('an explicit freshness meta key gates from source transport success', async () => {
  const reads = [];
  const transportFetchedAt = Date.now() - 29 * 60 * 60 * 1000;
  const completedAt = transportFetchedAt + 60_000;
  const freshness = await readSectionFreshness({
    freshnessMetaKey: 'seed-meta:economic:china-macro-transport',
    completionMetaKey: 'seed-meta:economic:china-macro-complete',
    canonicalKey: 'economic:china:macro:v2',
    seedMetaKey: 'economic:china-macro',
    requireCanonical: true,
  }, async (key) => {
    reads.push(key);
    if (key === 'economic:china:macro:v2') {
      return { _seed: { fetchedAt: completedAt } };
    }
    if (key === 'seed-meta:economic:china-macro-transport') {
      return { fetchedAt: transportFetchedAt };
    }
    if (key === 'seed-meta:economic:china-macro-complete') {
      return { fetchedAt: completedAt };
    }
    return null;
  });
  assert.deepEqual(freshness, { fetchedAt: transportFetchedAt });
  assert.deepEqual(reads, [
    'economic:china:macro:v2',
    'seed-meta:economic:china-macro-transport',
    'seed-meta:economic:china-macro-complete',
  ]);
});

test('a missing explicit freshness meta key does not fall back to publish time', async () => {
  const reads = [];
  const freshness = await readSectionFreshness({
    freshnessMetaKey: 'seed-meta:economic:china-macro-transport',
    completionMetaKey: 'seed-meta:economic:china-macro-complete',
    canonicalKey: 'economic:china:macro:v2',
    seedMetaKey: 'economic:china-macro',
    requireCanonical: true,
  }, async (key) => {
    reads.push(key);
    if (key === 'seed-meta:economic:china-macro-transport') return null;
    if (key === 'economic:china:macro:v2') return { _seed: { fetchedAt: Date.now() } };
    return { fetchedAt: Date.now() };
  });
  assert.equal(freshness, null);
  assert.deepEqual(reads, [
    'economic:china:macro:v2',
    'seed-meta:economic:china-macro-transport',
  ]);
});

test('explicit freshness still requires the canonical envelope when configured', async () => {
  const reads = [];
  const freshness = await readSectionFreshness({
    freshnessMetaKey: 'seed-meta:economic:china-macro-transport',
    completionMetaKey: 'seed-meta:economic:china-macro-complete',
    canonicalKey: 'economic:china:macro:v2',
    requireCanonical: true,
  }, async (key) => {
    reads.push(key);
    return null;
  });
  assert.equal(freshness, null);
  assert.deepEqual(reads, ['economic:china:macro:v2']);
});

test('a prior completion cannot attest a newer transport-only run', async () => {
  const transportFetchedAt = Date.now();
  const previousCompletionAt = transportFetchedAt - 60 * 60 * 1000;
  const freshness = await readSectionFreshness({
    freshnessMetaKey: 'seed-meta:economic:china-macro-transport',
    completionMetaKey: 'seed-meta:economic:china-macro-complete',
    canonicalKey: 'economic:china:macro:v2',
    requireCanonical: true,
  }, async (key) => {
    if (key === 'economic:china:macro:v2') {
      return { _seed: { fetchedAt: transportFetchedAt } };
    }
    if (key === 'seed-meta:economic:china-macro-transport') {
      return { fetchedAt: transportFetchedAt };
    }
    if (key === 'seed-meta:economic:china-macro-complete') {
      return { fetchedAt: previousCompletionAt };
    }
    return null;
  });
  assert.equal(freshness, null);
});

test('a missing completion marker keeps an explicit-freshness section due', async () => {
  const freshness = await readSectionFreshness({
    freshnessMetaKey: 'seed-meta:economic:china-macro-transport',
    completionMetaKey: 'seed-meta:economic:china-macro-complete',
    canonicalKey: 'economic:china:macro:v2',
    requireCanonical: true,
  }, async (key) => {
    if (key === 'economic:china:macro:v2') {
      return { _seed: { fetchedAt: Date.now() } };
    }
    if (key === 'seed-meta:economic:china-macro-transport') {
      return { fetchedAt: Date.now() };
    }
    return null;
  });
  assert.equal(freshness, null);
});

function runBundleWith(sections, opts = {}, env = {}) {
  const runPath = join(FIXTURES_DIR, `_bundle-runner-test-run-${randomUUID()}.mjs`);
  const fixtureSections = sections.map((section) => ({
    ...section,
    script: fixtureScript(section.script),
  }));
  writeFileSync(
    runPath,
    `import { runBundle } from '../_bundle-runner.mjs';\nawait runBundle('test', ${JSON.stringify(
      fixtureSections,
    )}, ${JSON.stringify(opts)});\n`,
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      try { unlinkSync(runPath); } catch {}
      resolve({ code, stdout, stderr });
    });
  });
}

function writeFixture(name, body) {
  const path = join(FIXTURES_DIR, name);
  writeFileSync(path, body);
  return () => { try { unlinkSync(path); } catch {} };
}

async function startFakeUpstash({
  strings = new Map(),
  geoMembers = new Map(),
  hashes = new Map(),
  ttls = new Map(),
  beforeCommand,
  failCommand,
  // Delay applied to each GET before responding. Lets a test burn bundle wall
  // time inside the freshness gate rather than inside a section, which is the
  // only way to reach `ran:0 deferred:>0` without a failure. Must stay under
  // the runner's REDIS_READ_TIMEOUT_MS or the read aborts and the section reads
  // as due instead of fresh.
  getDelayMs = 0,
} = {}) {
  const pipelines = [];
  const commands = [];
  const reads = [];
  const runCommand = (command, path) => {
    const forcedFailure = failCommand?.({ command, path, strings, geoMembers, hashes });
    if (forcedFailure) return { error: forcedFailure };

    const [operation, key, ...args] = command;
    if (operation === 'GET') return { result: strings.get(key) ?? null };
    if (operation === 'SET') {
      strings.set(key, args[0]);
      return { result: 'OK' };
    }
    if (operation === 'ZCARD') return { result: geoMembers.get(key)?.length ?? 0 };
    if (operation === 'HLEN') return { result: hashes.get(key)?.size ?? 0 };
    if (operation === 'ZRANGE') {
      const members = geoMembers.get(key) ?? [];
      const start = Number(args[0]);
      const rawEnd = Number(args[1]);
      const end = rawEnd < 0 ? members.length + rawEnd : rawEnd;
      return { result: members.slice(start, end + 1) };
    }
    if (operation === 'HMGET') {
      const hash = hashes.get(key);
      return { result: args.map(id => hash?.get(id) ?? null) };
    }
    if (operation === 'EVAL') {
      const script = key;
      const keyCount = Number(args[0]);
      const keys = args.slice(1, 1 + keyCount);
      const argv = args.slice(1 + keyCount);

      if (script.includes("return {1, ARGV[1], current or ''}")) {
        const current = strings.get(keys[0]) ?? '';
        if (current !== argv[2]) return { result: [0, current] };
        ttls.delete(keys[2]);
        ttls.delete(keys[3]);
        if (current && current !== argv[0]) {
          ttls.set(keys[4], Number(argv[3]));
          ttls.set(keys[5], Number(argv[3]));
        }
        strings.set(keys[0], argv[0]);
        strings.set(keys[1], argv[1]);
        return { result: [1, argv[0], current] };
      }
      if (script.includes("return {0, current or ''}")) {
        const current = strings.get(keys[0]) ?? '';
        if (current !== argv[0]) return { result: [0, current] };
        strings.set(keys[1], argv[1]);
        return { result: [1, current] };
      }
    }
    return { error: `Unsupported fake command: ${operation}` };
  };

  const redis = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/get/')) {
      const key = decodeURIComponent(req.url.slice('/get/'.length));
      reads.push(key);
      const send = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: strings.get(key) ?? null }));
      };
      if (getDelayMs > 0) setTimeout(send, getDelayMs);
      else send();
      return;
    }
    if (req.method === 'POST' && req.url === '/pipeline') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const requestCommands = JSON.parse(body);
          pipelines.push(requestCommands);
          for (const command of requestCommands) {
            await beforeCommand?.({ command, path: '/pipeline', strings, geoMembers, hashes });
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(requestCommands.map(command => runCommand(command, '/pipeline'))));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err?.message || err));
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const command = JSON.parse(body);
          commands.push(command);
          await beforeCommand?.({ command, path: '/', strings, geoMembers, hashes });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(runCommand(command, '/')));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err?.message || err));
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    const onError = err => reject(err);
    redis.once('error', onError);
    redis.listen(0, '127.0.0.1', () => {
      redis.off('error', onError);
      resolve();
    });
  });
  const address = redis.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token: 'isolated-test-token',
    strings,
    ttls,
    pipelines,
    commands,
    reads,
    close: () => new Promise((resolve, reject) => {
      redis.close(err => err ? reject(err) : resolve());
    }),
  };
}

async function runMilitaryGate(fakeRedis) {
  const fixtureName = `_bundle-fixture-military-bases-must-not-run-${randomUUID()}.mjs`;
  const cleanup = writeFixture(
    fixtureName,
    `console.log('military-bases-ran');\n`,
  );
  try {
    return await runBundleWith([
      {
        label: 'Military-Bases',
        script: fixtureName,
        seedMetaKey: 'military:bases',
        intervalMs: 30 * DAY,
        timeoutMs: 5000,
      },
    ], {}, {
      UPSTASH_REDIS_REST_URL: fakeRedis.url,
      UPSTASH_REDIS_REST_TOKEN: fakeRedis.token,
    });
  } finally {
    cleanup();
  }
}

test('Military-Bases normal publication atomically writes metadata and gates', async () => {
  const version = Date.now();
  const oldVersion = String(version - 60_000);
  const fetchedAt = version - 60_000;
  const newGeoKey = `military:bases:geo:${version}`;
  const newMetaKey = `military:bases:meta:${version}`;
  const oldGeoKey = `military:bases:geo:${oldVersion}`;
  const oldMetaKey = `military:bases:meta:${oldVersion}`;
  const redis = await startFakeUpstash({
    strings: new Map([['military:bases:active', oldVersion]]),
    ttls: new Map([[newGeoKey, 1800], [newMetaKey, 1800]]),
  });
  try {
    const superseded = await atomicSwitch(
      redis.url,
      redis.token,
      '',
      version,
      42,
      fetchedAt,
      undefined,
      oldVersion,
    );
    assert.equal(redis.commands.length, 1);
    const [
      operation,
      script,
      keyCount,
      activeKey,
      seedMetaKey,
      geoKey,
      metaKey,
      displacedGeoKey,
      displacedMetaKey,
      publishedVersion,
      payload,
      expectedActive,
      cleanupTtl,
    ] = redis.commands[0];
    assert.equal(operation, 'EVAL');
    assert.match(script, /redis\.call\('SET', KEYS\[1\]/);
    // The version's own keys are PERSISTed inside the publish EVAL so the
    // self-healing TTL armed during seeding (#6845) is dropped atomically with
    // the version going live.
    assert.match(script, /redis\.call\('PERSIST', KEYS\[3\]/);
    assert.match(script, /redis\.call\('PERSIST', KEYS\[4\]/);
    assert.match(script, /redis\.call\('EXPIRE', KEYS\[5\], ARGV\[4\]\)/);
    assert.match(script, /redis\.call\('EXPIRE', KEYS\[6\], ARGV\[4\]\)/);
    assert.equal(keyCount, '6');
    assert.equal(activeKey, 'military:bases:active');
    assert.equal(seedMetaKey, 'seed-meta:military:bases');
    assert.equal(geoKey, newGeoKey);
    assert.equal(metaKey, newMetaKey);
    assert.equal(displacedGeoKey, oldGeoKey);
    assert.equal(displacedMetaKey, oldMetaKey);
    assert.equal(publishedVersion, String(version));
    assert.equal(expectedActive, oldVersion);
    assert.equal(cleanupTtl, String(SUPERSEDED_KEY_TTL_SECONDS));
    assert.deepEqual(superseded, { oldVersion, oldGeoKey, oldMetaKey });
    assert.deepEqual(JSON.parse(payload), {
      fetchedAt,
      recordCount: 42,
      sourceVersion: String(version),
    });
    assert.equal(redis.strings.get(activeKey), String(version));
    assert.equal(redis.strings.get(seedMetaKey), payload);
    assert.equal(redis.ttls.has(newGeoKey), false);
    assert.equal(redis.ttls.has(newMetaKey), false);
    assert.equal(redis.ttls.get(oldGeoKey), SUPERSEDED_KEY_TTL_SECONDS);
    assert.equal(redis.ttls.get(oldMetaKey), SUPERSEDED_KEY_TTL_SECONDS);

    const { code, stdout, stderr } = await runMilitaryGate(redis);

    assert.equal(code, 0, stderr);
    assert.match(stdout, /\[Military-Bases\] Skipped, last seeded \d+min ago \(interval: 43200min\)/);
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:0 skipped:1/);
    assert.doesNotMatch(stdout, /military-bases-ran/);
    assert.deepEqual(redis.reads, ['seed-meta:military:bases']);
  } finally {
    await redis.close();
  }
});

test('Military-Bases backfills metadata from validated active data without refreshing its age', async () => {
  const version = String(Date.now() - 60_000);
  const ids = ['base-a', 'base-b', 'base-c'];
  const redis = await startFakeUpstash({
    strings: new Map([['military:bases:active', version]]),
    geoMembers: new Map([[`military:bases:geo:${version}`, ids]]),
    hashes: new Map([[
      `military:bases:meta:${version}`,
      new Map(ids.map(id => [id, JSON.stringify({ name: id })])),
    ]]),
  });
  try {
    const result = await backfillSeedMetaFromActiveVersion(redis.url, redis.token, '');
    assert.deepEqual(result, {
      version,
      fetchedAt: Number(version),
      recordCount: ids.length,
    });
    assert.deepEqual(JSON.parse(redis.strings.get('seed-meta:military:bases')), {
      fetchedAt: Number(version),
      recordCount: ids.length,
      sourceVersion: version,
    });
    assert.equal(
      redis.pipelines.flat().some(command => command[0] === 'SET' && command[1] === 'military:bases:active'),
      false,
      'backfill must not rewrite or race the active pointer',
    );
    assert.equal(redis.pipelines.flat().some(command => command[0] === 'ZRANDMEMBER'), false);
    assert.equal(redis.pipelines.flat().some(command => command[0] === 'ZRANGE'), true);

    const { code, stdout, stderr } = await runMilitaryGate(redis);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /\[Military-Bases\] Skipped/);
    assert.doesNotMatch(stdout, /military-bases-ran/);
  } finally {
    await redis.close();
  }
});

test('Military-Bases backfill fails closed when active GEO and META counts disagree', async () => {
  const version = String(Date.now() - 60_000);
  const redis = await startFakeUpstash({
    strings: new Map([['military:bases:active', version]]),
    geoMembers: new Map([[`military:bases:geo:${version}`, ['base-a', 'base-b']]]),
    hashes: new Map([[
      `military:bases:meta:${version}`,
      new Map([['base-a', JSON.stringify({ name: 'base-a' })]]),
    ]]),
  });
  try {
    await assert.rejects(
      backfillSeedMetaFromActiveVersion(redis.url, redis.token, ''),
      /META count 1 != GEO count 2/,
    );
    assert.equal(redis.strings.has('seed-meta:military:bases'), false);
    assert.equal(
      redis.pipelines.flat().some(command => command[0] === 'SET' && command[1] === 'seed-meta:military:bases'),
      false,
    );
  } finally {
    await redis.close();
  }
});

test('Military-Bases publication rejects an HTTP-200 Redis command error', async () => {
  const redis = await startFakeUpstash({
    failCommand: ({ command }) => command[0] === 'EVAL' ? 'forced command failure' : null,
  });
  try {
    await assert.rejects(
      atomicSwitch(redis.url, redis.token, '', Date.now(), 42),
      /Redis command EVAL failed: forced command failure/,
    );
    assert.equal(redis.strings.has('military:bases:active'), false);
    assert.equal(redis.strings.has('seed-meta:military:bases'), false);
  } finally {
    await redis.close();
  }
});

test('Military-Bases backfill rejects an HTTP-200 pipeline command error', async () => {
  const version = String(Date.now() - 60_000);
  const redis = await startFakeUpstash({
    strings: new Map([['military:bases:active', version]]),
    failCommand: ({ command }) => command[0] === 'ZCARD' ? 'forced command failure' : null,
  });
  try {
    await assert.rejects(
      backfillSeedMetaFromActiveVersion(redis.url, redis.token, ''),
      /Pipeline command 1\/2 ZCARD failed: forced command failure/,
    );
    assert.equal(redis.strings.has('seed-meta:military:bases'), false);
  } finally {
    await redis.close();
  }
});

test('Military-Bases backfill cannot overwrite metadata for a newer active version', async () => {
  const oldVersion = String(Date.now() - 120_000);
  const newVersion = String(Date.now() - 60_000);
  const ids = ['base-a', 'base-b'];
  const newMeta = JSON.stringify({
    fetchedAt: Number(newVersion),
    recordCount: 1,
    sourceVersion: newVersion,
  });
  let switched = false;
  const redis = await startFakeUpstash({
    strings: new Map([['military:bases:active', oldVersion]]),
    geoMembers: new Map([[`military:bases:geo:${oldVersion}`, ids]]),
    hashes: new Map([[
      `military:bases:meta:${oldVersion}`,
      new Map(ids.map(id => [id, JSON.stringify({ name: id })])),
    ]]),
    beforeCommand: ({ command, path, strings }) => {
      if (!switched && path === '/' && command[0] === 'EVAL' && command[1].includes("return {0, current or ''}")) {
        switched = true;
        strings.set('military:bases:active', newVersion);
        strings.set('seed-meta:military:bases', newMeta);
      }
    },
  });
  try {
    await assert.rejects(
      backfillSeedMetaFromActiveVersion(redis.url, redis.token, ''),
      new RegExp(`Active version changed during validation \\(${oldVersion} -> ${newVersion}\\)`),
    );
    assert.equal(redis.strings.get('military:bases:active'), newVersion);
    assert.equal(redis.strings.get('seed-meta:military:bases'), newMeta);
  } finally {
    await redis.close();
  }
});

test('Military-Bases backfill validates every active record', async () => {
  const version = String(Date.now() - 60_000);
  const ids = Array.from({ length: 11 }, (_, index) => `base-${index + 1}`);
  const metadata = new Map(ids.map(id => [id, JSON.stringify({ name: id })]));
  metadata.set(ids.at(-1), '{invalid-json');
  const redis = await startFakeUpstash({
    strings: new Map([['military:bases:active', version]]),
    geoMembers: new Map([[`military:bases:geo:${version}`, ids]]),
    hashes: new Map([[`military:bases:meta:${version}`, metadata]]),
  });
  try {
    await assert.rejects(
      backfillSeedMetaFromActiveVersion(redis.url, redis.token, ''),
      /ID "base-11" has invalid JSON in META hash/,
    );
    assert.equal(redis.strings.has('seed-meta:military:bases'), false);
  } finally {
    await redis.close();
  }
});

test('streams child stdout live and reports Done on success', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-fast.mjs',
    `console.log('line-one'); console.log('line-two');\n`,
  );
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'FAST', script: '_bundle-fixture-fast.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /\[FAST\] line-one/);
    assert.match(stdout, /\[FAST\] line-two/);
    assert.match(stdout, /\[FAST\] Done \(/);
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:1/);
  } finally {
    cleanup();
  }
});

test('timeout emits terminal reason BEFORE SIGTERM/SIGKILL grace (survives container kill)', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-hang.mjs',
    // Ignore SIGTERM so the runner must SIGKILL. Handler registers FIRST
    // (synchronously, before any I/O) so even a slow cold-start gets the
    // SIGTERM-ignore behaviour as soon as Node finishes parsing this line.
    `process.on('SIGTERM', () => {}); console.log('hung'); setInterval(() => {}, 1000);\n`,
  );
  try {
    const t0 = Date.now();
    // Cold-Node startup on slow CI runners (GitHub-hosted, under load)
    // can exceed 1s before user code parses + executes. A 1s timeout
    // produced a real flake on PR #3617's post-merge run: SIGTERM
    // arrived before the fixture's `process.on('SIGTERM', () => {})`
    // handler registered, so the child died via default SIGTERM
    // handling before logging 'hung' or surviving to SIGKILL — total
    // elapsed 1.1s instead of the expected ~11s (1s + 10s grace), and
    // the `[HANG] hung` assertion failed.
    //
    // 3000ms gives generous cold-start margin (typical Node startup
    // is 50-200ms; even loaded CI shouldn't exceed 1-2s) while still
    // exercising the same timeout → SIGTERM → grace → SIGKILL flow
    // the test is here to validate. The 20s cap below remains
    // comfortably above 3s + 10s grace + overhead.
    const TIMEOUT_MS = 3000;
    const { code, stdout, stderr } = await runBundleWith([
      { label: 'HANG', script: '_bundle-fixture-hang.mjs', intervalMs: 1, timeoutMs: TIMEOUT_MS },
    ]);
    const elapsedMs = Date.now() - t0;
    assert.equal(code, 1, 'bundle must exit non-zero on failure');
    const combined = stdout + stderr;
    assert.match(combined, /\[HANG\] hung/, 'child stdout should stream before kill');
    // Critical: terminal "Failed ... timeout" line must appear in-line with the
    // SIGTERM send, not after SIGKILL — this is what survives a container kill
    // landing inside the 10s grace window.
    const failIdx = combined.indexOf('Failed after');
    assert.ok(failIdx >= 0, 'must emit Failed line');
    if (process.platform !== 'win32') {
      const sigkillIdx = combined.indexOf('SIGKILL');
      assert.ok(sigkillIdx > failIdx, 'Failed line must precede SIGKILL escalation');
    }
    // Match the timeout-seconds value loosely so a future bump doesn't
    // require a coordinated regex update — the assertion's purpose is
    // "Failed line names the timeout-after-N pattern", not the literal N.
    assert.match(combined, /Failed after .*s: timeout after \d+s — sending SIGTERM/);
    if (process.platform !== 'win32') {
      assert.match(combined, /Did not exit on SIGTERM.*SIGKILL/);
    }
    // timeout + 10s SIGTERM grace + overhead; cap well above that to avoid flake.
    assert.ok(elapsedMs < 20_000, `timeout escalation took ${elapsedMs}ms — too slow`);
  } finally {
    cleanup();
  }
});

test('budget check accounts for SIGKILL grace when deferring', async () => {
  const cleanupFirst = writeFixture(
    '_bundle-fixture-budget-first.mjs',
    `await new Promise((r) => setTimeout(r, 16000));\nconsole.log('first-ran');\n`,
  );
  const cleanupGated = writeFixture(
    '_bundle-fixture-sleep.mjs',
    `console.log('gated-ran');\n`,
  );
  try {
    // Budget 60s. FIRST is admittable (30s + 10s grace + 15s headroom = 55s)
    // and burns ~16s of it. GATED's own timeout (35s) still fits the ~44s that
    // remain — only adding the 10s kill grace (45s) pushes it over. Deferring
    // under that cumulative pressure is the feature; a section that cannot fit
    // the whole budget is a config bug rejected at startup instead (see below).
    //
    // FIRST has to burn more than ADMISSION_HEADROOM_MS for GATED to defer at
    // all: any section that passes the startup check by definition fits the
    // budget with the headroom to spare, so only elapsed time beyond that
    // headroom can squeeze it out. That is what makes this test slow, and why
    // it cannot be tightened without also weakening what it proves.
    //
    // FIRST's timeout is ~2x its sleep on purpose. This file spawns real child
    // processes and a loaded CI runner has already produced one cold-start
    // flake here (PR #3617); a timeout close to the sleep would turn that into
    // a section failure and change the exit code being asserted.
    const { code, stdout } = await runBundleWith(
      [
        { label: 'FIRST', script: '_bundle-fixture-budget-first.mjs', intervalMs: 1, timeoutMs: 30_000 },
        { label: 'GATED', script: '_bundle-fixture-sleep.mjs', intervalMs: 1, timeoutMs: 35_000 },
      ],
      { maxBundleMs: 60_000 },
    );
    assert.equal(code, 0, 'a deferral after real work is pressure, not a failure');
    assert.match(stdout, /\[FIRST\] first-ran/);
    assert.match(stdout, /\[GATED\] Deferred, needs 45s \(timeout\+grace\)/);
    assert.match(stdout, /ran:1 skipped:0 deferred:1/);
    assert.doesNotMatch(stdout, /gated-ran/);
  } finally {
    cleanupFirst();
    cleanupGated();
  }
});

test('a section whose worst case exceeds the whole budget is rejected at startup', async () => {
  // #6556: seed-bundle-resilience declared maxBundleMs 570s against sections
  // whose cheapest worst case was 610s, so EVERY tick deferred EVERY section
  // and exited 0. Railway painted SUCCESS for six hours while the service was
  // dead. A section that cannot fit the whole budget can never be admitted on
  // any tick, which makes it a static config error, not runtime pressure.
  const cleanup = writeFixture('_bundle-fixture-unadmittable.mjs', `console.log('must-not-run');\n`);
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [{ label: 'NEVER', script: '_bundle-fixture-unadmittable.mjs', intervalMs: 1, timeoutMs: 560_000 }],
      { maxBundleMs: 560_000 },
    );
    assert.notEqual(code, 0, 'a permanently unadmittable section must not exit 0');
    assert.match(
      stderr,
      /maxBundleMs=560000 is below the worst case of 1 section\(s\)[^\n]*'NEVER' needs 585000ms \(timeoutMs 560000 \+ 10000ms kill grace \+ 15000ms admission headroom\)/,
      `expected the admission-arithmetic error; stderr:\n${stderr}`,
    );
    assert.doesNotMatch(stdout + stderr, /must-not-run/, 'nothing may spawn once the config is known bad');
  } finally {
    cleanup();
  }
});

test('an env-gated section does not take its healthy siblings down via the admission check', async () => {
  // The startup throw is deliberately loud, but its blast radius is the whole
  // bundle. A section already failing the requiredEnv gate cannot run this tick
  // whatever its timeout says, so letting its arithmetic throw would stop the
  // bundle's healthy members from publishing for the duration of an unrelated
  // secret outage — while requiredEnv's own path exists precisely to fail only
  // the affected section. Nothing is lost: the CI gate checks that timeout
  // statically, with no knowledge of the environment.
  const cleanup = writeFixture('_bundle-fixture-env-gated-sibling.mjs', `console.log('healthy-sibling-ran');\n`);
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [
        { label: 'HEALTHY', script: '_bundle-fixture-env-gated-sibling.mjs', intervalMs: 1, timeoutMs: 5_000 },
        {
          label: 'GATED_AND_OVERSIZED',
          script: '_bundle-fixture-must-not-run.mjs',
          intervalMs: 1,
          timeoutMs: 5_000_000,                       // would throw on its own
          requiredEnv: ['WM_BUNDLE_TEST_ABSENT_SECRET'],
        },
      ],
      { maxBundleMs: 60_000 },
    );
    assert.match(stdout, /\[HEALTHY\] healthy-sibling-ran/, `the healthy section must still run; stdout:\n${stdout}`);
    assert.match(stderr, /section=GATED_AND_OVERSIZED status=CONFIG_ERROR/);
    assert.equal(code, 1, 'the missing secret still fails the bundle');
    assert.doesNotMatch(stdout + stderr, /can therefore never be admitted/, 'must not throw on an env-gated section');
    assert.doesNotMatch(stdout + stderr, /must-not-run/);
  } finally {
    cleanup();
  }
});

test('a declared-but-unusable maxBundleMs fails instead of silently unbudgeting', async () => {
  // Every budget guard is gated on Number.isFinite(maxBundleMs), so a string
  // (or a NaN from Number(process.env.X)) would turn all of them off and let a
  // 600s section run in a container that dies at 600s — #6556's outcome via a
  // different route. A missing budget is unbudgeted; a broken one is an error.
  const cleanup = writeFixture('_bundle-fixture-bad-budget.mjs', `console.log('bad-budget-ran');\n`);
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [{ label: 'ANY', script: '_bundle-fixture-bad-budget.mjs', intervalMs: 1, timeoutMs: 5_000 }],
      { maxBundleMs: '60000' },
    );
    assert.notEqual(code, 0, 'a non-numeric budget must not be treated as "no budget"');
    assert.match(stderr, /maxBundleMs must be a positive finite number, got "60000"/, `stderr:\n${stderr}`);
    assert.doesNotMatch(stdout + stderr, /bad-budget-ran/);
  } finally {
    cleanup();
  }
});

test('a section sized exactly at the budget is rejected, not silently deferred forever', async () => {
  // The boundary the first version of this guard got wrong. `timeoutMs +
  // KILL_GRACE_MS === maxBundleMs` passes a naive `worstCase > maxBundleMs`
  // check, but the runtime test is `elapsed + worstCase <= maxBundleMs` and
  // elapsed is never zero — the freshness gate has already run. So the section
  // was admissible on paper and deferred on every real tick: #6556 surviving
  // its own fix. ADMISSION_HEADROOM_MS is what closes it.
  const cleanup = writeFixture('_bundle-fixture-exact-budget.mjs', `console.log('exact-ran');\n`);
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [{ label: 'EXACT', script: '_bundle-fixture-exact-budget.mjs', intervalMs: 1, timeoutMs: 50_000 }],
      { maxBundleMs: 60_000 },
    );
    assert.notEqual(code, 0, 'worstCase === maxBundleMs leaves zero room for the freshness gate');
    assert.match(stderr, /'EXACT' needs 75000ms/, `stderr:\n${stderr}`);
    assert.doesNotMatch(stdout + stderr, /exact-ran/);
  } finally {
    cleanup();
  }
});

test('a section with headroom to spare is admitted', async () => {
  // The other side of the boundary — proves the guard rejects on the specific
  // arithmetic rather than rejecting everything, which would pass the test
  // above for the wrong reason.
  const cleanup = writeFixture('_bundle-fixture-fits.mjs', `console.log('fits-ran');\n`);
  try {
    const { code, stdout } = await runBundleWith(
      [{ label: 'FITS', script: '_bundle-fixture-fits.mjs', intervalMs: 1, timeoutMs: 34_000 }],
      { maxBundleMs: 60_000 },
    );
    assert.equal(code, 0, `34s + 10s grace + 15s headroom = 59s fits a 60s budget; stdout:\n${stdout}`);
    assert.match(stdout, /\[FITS\] fits-ran/);
    assert.match(stdout, /ran:1 skipped:0 deferred:0/);
  } finally {
    cleanup();
  }
});

test('a tick that runs nothing while deferring due work exits non-zero', async () => {
  // The residual silent-stall shape that survives the startup check. Every
  // section fits the budget on its own, but the runner's OWN freshness gate
  // burns enough wall time to squeeze the due section out, so the tick
  // published nothing and shed work. `ran:0 deferred:>0` is indistinguishable
  // from a healthy no-op in Railway's badge, so the runner has to say so.
  //
  // A degraded Upstash is the production shape: nine fresh sections whose
  // reads each take ~2s push elapsed past the 15s admission headroom, and DUE
  // then no longer fits. Keep each response well below the runner's 5s read
  // timeout: a 4.5s fixture used to race that timeout under suite contention,
  // turning a freshness test into a load-dependent false red.
  const cleanupDue = writeFixture('_bundle-fixture-starved-due.mjs', `console.log('due-ran');\n`);
  const freshMeta = JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 });
  const freshKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const redis = await startFakeUpstash({
    getDelayMs: 2_000,
    strings: new Map(freshKeys.map((key) => [`seed-meta:starve:${key}`, freshMeta])),
  });
  try {
    const skipped = freshKeys.map((k) => ({
      label: `FRESH_${k.toUpperCase()}`,
      script: '_bundle-fixture-starved-due.mjs',
      seedMetaKey: `starve:${k}`,
      intervalMs: DAY,
      timeoutMs: 5_000,
    }));
    const { code, stdout, stderr } = await runBundleWith(
      [
        ...skipped,
        { label: 'DUE', script: '_bundle-fixture-starved-due.mjs', intervalMs: 1, timeoutMs: 35_000 },
      ],
      { maxBundleMs: 60_000 },
      { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token },
    );
    assert.equal(code, 1, 'a tick that published nothing while starving due work is not a success');
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:0 skipped:9 deferred:1 failed:0 graceful:0/);
    assert.match(
      stderr,
      /\[Bundle:test\] ran:0 while 1 due section\(s\) were deferred/,
      `expected the zero-admission explanation; stderr:\n${stderr}`,
    );
    assert.doesNotMatch(stdout, /due-ran/);
  } finally {
    cleanupDue();
    await redis.close();
  }
});

test('a graceful skip that publishes nothing and defers work exits non-zero', async () => {
  // Was: 'stays exit 0'. The graceful exemption used to cover this on the
  // premise that a child exit 75 extended the last-good TTL and lost no data.
  // That is true of the FAILING section and false of the ones it shed.
  //
  // seed-bundle-static-ref proved it: Arms-Suppliers burns its whole 390s fetch
  // deadline (SIPRI answers in ~10.6s and it makes ~200 requests at concurrency
  // 4) and exits 75, leaving 179s of a 570s budget. Every remaining due section
  // needs >=190s, so all four defer and `ran:0`. Because gracefulFailed was 1,
  // starvedTick stayed false and the bundle reported success — while
  // mineralProduction and submarineCables had NO key in Redis at all. The one
  // scenario the guard was written for was the one it could not see (#6799).
  //
  // The exemption now applies where its premise holds: `ran > 0` — some work
  // published and one source blipped. A tick that published NOTHING has no
  // successful work to vouch for it, whatever the reason.
  const cleanupGrace = writeFixture(
    '_bundle-fixture-slow-graceful.mjs',
    `await new Promise((r) => setTimeout(r, 16000));\nconsole.log('=== Failed gracefully ===');\nprocess.exit(${GRACEFUL_FETCH_FAILURE_EXIT_CODE});\n`,
  );
  const cleanupLate = writeFixture('_bundle-fixture-late.mjs', `console.log('late-ran');\n`);
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [
        { label: 'GRACE', script: '_bundle-fixture-slow-graceful.mjs', intervalMs: 1, timeoutMs: 30_000 },
        { label: 'LATE', script: '_bundle-fixture-late.mjs', intervalMs: 1, timeoutMs: 35_000 },
      ],
      { maxBundleMs: 60_000 },
    );
    assert.equal(code, 1, 'a tick that published nothing and shed due work must not report success');
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:0 skipped:0 deferred:1 failed:0 graceful:1/);
    assert.match(
      stderr,
      /\[Bundle:test\] ran:0 while 1 due section\(s\) were deferred/,
      `expected the starvation explanation; stderr:\n${stderr}`,
    );
    assert.doesNotMatch(stdout, /late-ran/);
  } finally {
    cleanupGrace();
    cleanupLate();
  }
});

test('non-zero exit without timeout reports exit code', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-fail.mjs',
    `console.error('boom'); process.exit(2);\n`,
  );
  try {
    const { code, stdout, stderr } = await runBundleWith([
      { label: 'FAIL', script: '_bundle-fixture-fail.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    assert.equal(code, 1);
    const combined = stdout + stderr;
    assert.match(combined, /\[FAIL\] boom/);
    assert.match(combined, /Failed after .*s: exit 2/);
  } finally {
    cleanup();
  }
});

test('missing required environment configuration hard-fails only the affected section', async () => {
  const cleanup = writeFixture('_bundle-fixture-config-sibling.mjs', `console.log('sibling-ran');\n`);
  try {
    const { code, stdout, stderr } = await runBundleWith([
      {
        label: 'OK_SIBLING',
        script: '_bundle-fixture-config-sibling.mjs',
        intervalMs: 1,
        timeoutMs: 5000,
      },
      {
        label: 'REQUIRES_SECRET',
        script: '_bundle-fixture-must-not-run.mjs',
        intervalMs: 1,
        timeoutMs: 5000,
        requiredEnv: ['WM_BUNDLE_TEST_REQUIRED_SECRET'],
      },
    ]);

    assert.equal(code, 1, 'deployment misconfiguration must fail the bundle');
    assert.match(stdout, /\[OK_SIBLING\] sibling-ran/);
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:1 .* failed:1/);
    assert.doesNotMatch(stdout + stderr, /spawn error|must-not-run/);
    assert.match(
      stderr,
      /section=REQUIRES_SECRET status=CONFIG_ERROR reason=missing required environment configuration: WM_BUNDLE_TEST_REQUIRED_SECRET/,
    );
  } finally {
    cleanup();
  }
});

test('an any-of requiredEnv group is satisfied by either alternative', async () => {
  // A section whose seeder resolves `SOURCE_SPECIFIC || SHARED` must be able to
  // say so. Gating on the source-specific name alone made the runner stricter
  // than the code it guards: it hard-failed Cross-Strait-Activity in an
  // environment carrying only PROXY_URL, even though the adapter would have run
  // undegraded (#5756 review).
  const cleanup = writeFixture('_bundle-fixture-anyof.mjs', `console.log('anyof-ran');\n`);
  try {
    const section = {
      label: 'ANY_OF',
      script: '_bundle-fixture-anyof.mjs',
      intervalMs: 1,
      timeoutMs: 5000,
      requiredEnv: [['WM_BUNDLE_TEST_SPECIFIC', 'WM_BUNDLE_TEST_SHARED']],
    };

    const viaFallback = await runBundleWith([section], {}, {
      WM_BUNDLE_TEST_SHARED: 'http://shared:1',
    });
    assert.equal(viaFallback.code, 0, 'the shared alternative alone must satisfy the group');
    assert.match(viaFallback.stdout, /\[ANY_OF\] anyof-ran/);

    const viaSpecific = await runBundleWith([section], {}, {
      WM_BUNDLE_TEST_SPECIFIC: 'http://specific:2',
    });
    assert.equal(viaSpecific.code, 0, 'the source-specific alternative alone must satisfy the group');

    const neither = await runBundleWith([section]);
    assert.equal(neither.code, 1, 'neither alternative set must still fail the section');
    assert.match(
      neither.stderr,
      /section=ANY_OF status=CONFIG_ERROR reason=missing required environment configuration: WM_BUNDLE_TEST_SPECIFIC or WM_BUNDLE_TEST_SHARED/,
    );
    assert.doesNotMatch(neither.stdout, /anyof-ran/);
  } finally {
    cleanup();
  }
});

test('graceful-only fetch failure exits 0 (no data lost) but still logs the skip', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-graceful-fail.mjs',
    `console.error('FETCH FAILED: upstream unavailable');\nconsole.log('=== Failed gracefully (42ms) ===');\nprocess.exit(${GRACEFUL_FETCH_FAILURE_EXIT_CODE});\n`,
  );
  try {
    const { code, stdout, stderr } = await runBundleWith([
      { label: 'GRACEFUL', script: '_bundle-fixture-graceful-fail.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    const combined = stdout + stderr;
    // A child exit 75 is a *graceful* fetch failure: the last-good TTL is
    // extended and no data is lost. It must NOT crash the whole bundle — one
    // flaky member (e.g. a rate-limited source returning 429) otherwise fires a
    // spurious Railway "Deploy Crashed!" alert for a benign skip. Only HARD
    // failures (real errors / timeouts / non-75 exits) make the bundle exit 1.
    assert.equal(code, 0, 'graceful-only fetch failure must exit 0 (benign skip, no data lost)');
    // The skip stays fully observable — the per-section GRACEFUL_FAIL line and a
    // bundle-level explanation are emitted, so it is silenced but never silent.
    assert.match(combined, /\[GRACEFUL\] FETCH FAILED: upstream unavailable/);
    assert.match(combined, new RegExp(`Failed after .*s: graceful fetch failure \\(exit ${GRACEFUL_FETCH_FAILURE_EXIT_CODE}\\)`));
    assert.match(combined, new RegExp(`\\[Bundle:test\\] section=GRACEFUL status=GRACEFUL_FAIL .*reason=graceful fetch failure \\(exit ${GRACEFUL_FETCH_FAILURE_EXIT_CODE}\\)`));
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:0 skipped:0 deferred:0 failed:0 graceful:1/);
    assert.match(stdout, /\[Bundle:test\] 1 graceful fetch skip\(s\), no hard failures — no data lost, exiting 0/);
    assert.doesNotMatch(combined, /\[Bundle:test\] section=GRACEFUL status=OK/);
  } finally {
    cleanup();
  }
});

test('a hard failure alongside a graceful skip still exits 1 (graceful never masks a real crash)', async () => {
  const cleanupG = writeFixture(
    '_bundle-fixture-graceful-mixed.mjs',
    `console.log('=== Failed gracefully ===');\nprocess.exit(${GRACEFUL_FETCH_FAILURE_EXIT_CODE});\n`,
  );
  const cleanupH = writeFixture(
    '_bundle-fixture-hard-mixed.mjs',
    `console.error('boom');\nprocess.exit(2);\n`,
  );
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'GRACE', script: '_bundle-fixture-graceful-mixed.mjs', intervalMs: 1, timeoutMs: 5000 },
      { label: 'HARD', script: '_bundle-fixture-hard-mixed.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    assert.equal(code, 1, 'a hard failure must still crash the bundle even when another member skipped gracefully');
    assert.match(stdout, /\[Bundle:test\] Finished .* failed:1 graceful:1/);
    assert.doesNotMatch(stdout, /no data lost, exiting 0/);
  } finally {
    cleanupG();
    cleanupH();
  }
});

test('a graceful skip alongside a successful member exits 0', async () => {
  const cleanupG = writeFixture(
    '_bundle-fixture-graceful-ok.mjs',
    `console.log('=== Failed gracefully ===');\nprocess.exit(${GRACEFUL_FETCH_FAILURE_EXIT_CODE});\n`,
  );
  const cleanupOk = writeFixture(
    '_bundle-fixture-ok-mem.mjs',
    `console.log('did work');\n`,
  );
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'OKMEM', script: '_bundle-fixture-ok-mem.mjs', intervalMs: 1, timeoutMs: 5000 },
      { label: 'GRACE', script: '_bundle-fixture-graceful-ok.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    assert.equal(code, 0, 'graceful skip must not crash a bundle that otherwise did work');
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:1 skipped:0 deferred:0 failed:0 graceful:1/);
  } finally {
    cleanupG();
    cleanupOk();
  }
});

test('lock-skip-like exit zero remains OK even without seed_complete', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-lock-skip.mjs',
    `console.log('SKIPPED: another seed run in progress');\nprocess.exit(0);\n`,
  );
  try {
    const { code, stdout, stderr } = await runBundleWith([
      { label: 'LOCK_SKIP', script: '_bundle-fixture-lock-skip.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    const combined = stdout + stderr;
    assert.equal(code, 0, 'lock-skip exit zero must remain a successful bundle outcome');
    assert.match(combined, /\[LOCK_SKIP\] SKIPPED: another seed run in progress/);
    assert.match(combined, /\[Bundle:test\] section=LOCK_SKIP status=OK elapsed=/);
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:1 skipped:0 deferred:0 failed:0/);
    assert.doesNotMatch(combined, /GRACEFUL_FAIL/);
  } finally {
    cleanup();
  }
});

test('injects BUNDLE_RUN_STARTED_AT_MS env into child; value is within run bounds', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-env.mjs',
    `console.log('BUNDLE_RUN_STARTED_AT_MS=' + process.env.BUNDLE_RUN_STARTED_AT_MS);\n`,
  );
  const before = Date.now();
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'ENV', script: '_bundle-fixture-env.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    const after = Date.now();
    assert.equal(code, 0);
    const match = stdout.match(/BUNDLE_RUN_STARTED_AT_MS=(\d+)/);
    assert.ok(match, `expected env var in child stdout; got:\n${stdout}`);
    const injected = Number(match[1]);
    assert.ok(Number.isInteger(injected), 'injected value must be an integer');
    // Parent captured t0 at bundle start (before this test's `before` call) and
    // child ran before `after`. So: before - tolerance <= injected <= after.
    assert.ok(injected >= before - 5000 && injected <= after,
      `injected=${injected} out of bounds [${before - 5000}, ${after}]`);
  } finally {
    cleanup();
  }
});

test('injects only canonical-clock completion markers into child seeders', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-completion-env.mjs',
    `console.log('COMPLETION=' + JSON.stringify(process.env.WM_BUNDLE_COMPLETION_META_KEY || ''));\n`,
  );
  try {
    const canonical = await runBundleWith([{
      label: 'CANONICAL',
      script: '_bundle-fixture-completion-env.mjs',
      canonicalKey: 'test:canonical:v1',
      completionMetaKey: 'seed-completion:test:canonical',
      intervalMs: 1,
      timeoutMs: 5000,
    }]);
    assert.equal(canonical.code, 0);
    assert.match(canonical.stdout, /COMPLETION="seed-completion:test:canonical"/);

    const explicitFreshness = await runBundleWith([{
      label: 'EXPLICIT',
      script: '_bundle-fixture-completion-env.mjs',
      canonicalKey: 'test:explicit:v1',
      freshnessMetaKey: 'seed-meta:test:transport',
      completionMetaKey: 'seed-meta:test:complete',
      intervalMs: 1,
      timeoutMs: 5000,
    }]);
    assert.equal(explicitFreshness.code, 0);
    assert.match(explicitFreshness.stdout, /COMPLETION=""/);

    const sharedCanonicalMeta = await runBundleWith([{
      label: 'INVALID',
      script: '_bundle-fixture-completion-env.mjs',
      canonicalKey: 'test:invalid:v1',
      completionMetaKey: 'seed-meta:test:invalid',
      intervalMs: 1,
      timeoutMs: 5000,
    }]);
    assert.notEqual(sharedCanonicalMeta.code, 0);
    assert.match(sharedCanonicalMeta.stderr, /must use the dedicated seed-completion: namespace/);
  } finally {
    cleanup();
  }
});

test('sibling sections share the same BUNDLE_RUN_STARTED_AT_MS (one-shot per bundle)', async () => {
  const cleanupA = writeFixture(
    '_bundle-fixture-env-a.mjs',
    `console.log('TS_A=' + process.env.BUNDLE_RUN_STARTED_AT_MS);\n`,
  );
  const cleanupB = writeFixture(
    '_bundle-fixture-env-b.mjs',
    `await new Promise((r) => setTimeout(r, 200));\nconsole.log('TS_B=' + process.env.BUNDLE_RUN_STARTED_AT_MS);\n`,
  );
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'A', script: '_bundle-fixture-env-a.mjs', intervalMs: 1, timeoutMs: 5000 },
      { label: 'B', script: '_bundle-fixture-env-b.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    assert.equal(code, 0);
    const tsA = Number(stdout.match(/TS_A=(\d+)/)?.[1]);
    const tsB = Number(stdout.match(/TS_B=(\d+)/)?.[1]);
    assert.ok(tsA && tsB, `both timestamps present; stdout:\n${stdout}`);
    // Both children read the same bundle-level t0, so the injected value is
    // identical across siblings (NOT spawn time). This is the critical
    // property Phase 2's bundle-freshness guard relies on.
    assert.equal(tsA, tsB, 'siblings must share one bundle-level timestamp');
  } finally {
    cleanupA();
    cleanupB();
  }
});

test('dependsOn: throws when a dep appears later in the sections array', async () => {
  // Consumer (depends on Producer) is at index 0 — violates the contract.
  const cleanupC = writeFixture('_bundle-fixture-dep-consumer.mjs', `console.log('consumer');\n`);
  const cleanupP = writeFixture('_bundle-fixture-dep-producer.mjs', `console.log('producer');\n`);
  try {
    const { code, stderr } = await runBundleWith([
      { label: 'Consumer', script: '_bundle-fixture-dep-consumer.mjs', intervalMs: 1, timeoutMs: 5000, dependsOn: ['Producer'] },
      { label: 'Producer', script: '_bundle-fixture-dep-producer.mjs', intervalMs: 1, timeoutMs: 5000 },
    ]);
    assert.notEqual(code, 0, 'out-of-order dependsOn must cause non-zero exit');
    assert.match(stderr, /dependsOn 'Producer' but 'Producer' is at index 1/,
      `expected topological violation error; stderr:\n${stderr}`);
  } finally {
    cleanupC();
    cleanupP();
  }
});

test('dependsOn: passes when deps appear earlier in the sections array', async () => {
  const cleanupP = writeFixture('_bundle-fixture-dep-producer-ok.mjs', `console.log('producer');\n`);
  const cleanupC = writeFixture('_bundle-fixture-dep-consumer-ok.mjs', `console.log('consumer');\n`);
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'Producer', script: '_bundle-fixture-dep-producer-ok.mjs', intervalMs: 1, timeoutMs: 5000 },
      { label: 'Consumer', script: '_bundle-fixture-dep-consumer-ok.mjs', intervalMs: 1, timeoutMs: 5000, dependsOn: ['Producer'] },
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /\[Producer\] producer/);
    assert.match(stdout, /\[Consumer\] consumer/);
  } finally {
    cleanupP();
    cleanupC();
  }
});

test('dependsOn: throws on unknown label reference', async () => {
  const cleanup = writeFixture('_bundle-fixture-dep-orphan.mjs', `console.log('orphan');\n`);
  try {
    const { code, stderr } = await runBundleWith([
      { label: 'Orphan', script: '_bundle-fixture-dep-orphan.mjs', intervalMs: 1, timeoutMs: 5000, dependsOn: ['DoesNotExist'] },
    ]);
    assert.notEqual(code, 0);
    assert.match(stderr, /dependsOn unknown label 'DoesNotExist'/,
      `expected unknown-label error; stderr:\n${stderr}`);
  } finally {
    cleanup();
  }
});

test('bundleHeartbeatKey names the tick-execution watchdog key from the bundle label', () => {
  assert.equal(bundleHeartbeatKey('static-ref'), 'bundle:heartbeat:static-ref');
  assert.equal(BUNDLE_HEARTBEAT_TTL_SECONDS, 7 * 24 * 60 * 60);
});

test('runBundle writes a tick heartbeat even when every section is skipped', async () => {
  // Scheduler-freeze detection needs a write on EVERY container start, including
  // the common daily tick where all weekly/monthly members are still fresh.
  // Member seed-meta cannot see those ticks (#6691).
  const cleanup = writeFixture('_bundle-fixture-heartbeat-skip.mjs', `console.log('must-not-run');\n`);
  const redis = await startFakeUpstash({
    strings: new Map([['seed-meta:heartbeat-skip', JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 })]]),
  });
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [{
        label: 'SKIPME',
        script: '_bundle-fixture-heartbeat-skip.mjs',
        seedMetaKey: 'heartbeat-skip',
        intervalMs: DAY,
        timeoutMs: 5_000,
      }],
      {},
      { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token },
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /\[SKIPME\] Skipped/);
    assert.doesNotMatch(stdout, /must-not-run/);
    const set = redis.commands.find((command) => command[0] === 'SET' && command[1] === bundleHeartbeatKey('test'));
    assert.ok(set, `expected SET ${bundleHeartbeatKey('test')}; commands=${JSON.stringify(redis.commands)}`);
    const payload = JSON.parse(set[2]);
    assert.equal(payload.recordCount, 1);
    assert.ok(Number.isFinite(payload.fetchedAt), 'heartbeat must carry fetchedAt');
    assert.equal(payload.lastBundleRunAt, payload.fetchedAt);
    assert.equal(set[3], 'EX');
    assert.equal(set[4], BUNDLE_HEARTBEAT_TTL_SECONDS);
  } finally {
    cleanup();
    await redis.close();
  }
});

test('a missing Redis URL must not crash the bundle after the heartbeat write is added', async () => {
  const cleanup = writeFixture('_bundle-fixture-heartbeat-noredist.mjs', `console.log('noredist-ran');\n`);
  try {
    const { code, stdout } = await runBundleWith([
      { label: 'OK', script: '_bundle-fixture-heartbeat-noredist.mjs', intervalMs: 1, timeoutMs: 5_000 },
    ], {}, {
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    });
    assert.equal(code, 0);
    assert.match(stdout, /noredist-ran/);
  } finally {
    cleanup();
  }
});

test('a deferred section older than 2x its interval fails the tick even when siblings ran', async () => {
  // #6562 item 4: partial starvation. starvedTick only catches the
  // published-nothing tick; a section can be squeezed out on EVERY tick while
  // a healthy sibling keeps the bundle green — ran:1 deferred:1 exited 0 and
  // the deferral read as ordinary pressure. At deferral time the runner holds
  // the victim's seed-meta age; over STALL_AGE_INTERVAL_MULTIPLE of its own
  // interval it must page regardless of what else ran.
  const HOUR = 60 * 60 * 1000;
  const cleanup = writeFixture('_bundle-fixture-stall-run.mjs', `console.log('stall-ran');\n`);
  const staleMeta = JSON.stringify({ fetchedAt: Date.now() - 3 * HOUR, recordCount: 1 });
  const freshKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const redis = await startFakeUpstash({
    getDelayMs: 2_000,
    strings: new Map([
      ...freshKeys.map((key) => [`seed-meta:stall:${key}`, JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 })]),
      ['seed-meta:stall:victim', staleMeta],
    ]),
  });
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [
        ...freshKeys.map((k) => ({
          label: `FRESH_${k.toUpperCase()}`,
          script: '_bundle-fixture-stall-run.mjs',
          seedMetaKey: `stall:${k}`,
          intervalMs: DAY,
          timeoutMs: 5_000,
        })),
        { label: 'RUNS', script: '_bundle-fixture-stall-run.mjs', intervalMs: 1, timeoutMs: 5_000 },
        // worst case 35s+10s grace+15s headroom = 60s fits the admission
        // check, but the 20s of freshness reads above mean only 40s remain —
        // so VICTIM is deferred at runtime while its 3h-old seed-meta (3x a
        // 1h interval) marks the deferral as a stall.
        { label: 'VICTIM', script: '_bundle-fixture-stall-run.mjs', seedMetaKey: 'stall:victim', intervalMs: HOUR, timeoutMs: 35_000 },
      ],
      { maxBundleMs: 60_000 },
      { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token },
    );
    assert.equal(code, 1, 'a starved-while-green tick is not a success');
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:1 skipped:10 deferred:1 failed:0 graceful:0 stalled:1/);
    assert.match(stderr, /starvation, not pressure/, `expected the per-section stall line; stderr:\n${stderr}`);
    assert.match(stderr, /older than 2x their interval — starvation while the bundle reported progress/);
    assert.doesNotMatch(stdout, /ran:0 while/);
  } finally {
    cleanup();
    await redis.close();
  }
});

test('a deferred section within 2x its interval stays ordinary pressure (exit 0)', async () => {
  // The other side of #6562 item 4: a due section (age past the 0.8x floor)
  // losing ONE budget race is pressure, not a stall — it retries next tick and
  // must not page, or the stall signal becomes the alert fatigue the
  // GRACEFUL_FAIL exemption exists to prevent.
  const HOUR = 60 * 60 * 1000;
  const cleanup = writeFixture('_bundle-fixture-pressure-run.mjs', `console.log('pressure-ran');\n`);
  const dueMeta = JSON.stringify({ fetchedAt: Date.now() - Math.round(0.9 * HOUR), recordCount: 1 });
  const freshKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const redis = await startFakeUpstash({
    getDelayMs: 2_000,
    strings: new Map([
      ...freshKeys.map((key) => [`seed-meta:pressure:${key}`, JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 })]),
      ['seed-meta:pressure:victim', dueMeta],
    ]),
  });
  try {
    const { code, stdout, stderr } = await runBundleWith(
      [
        ...freshKeys.map((k) => ({
          label: `FRESH_${k.toUpperCase()}`,
          script: '_bundle-fixture-pressure-run.mjs',
          seedMetaKey: `pressure:${k}`,
          intervalMs: DAY,
          timeoutMs: 5_000,
        })),
        { label: 'RUNS', script: '_bundle-fixture-pressure-run.mjs', intervalMs: 1, timeoutMs: 5_000 },
        { label: 'VICTIM', script: '_bundle-fixture-pressure-run.mjs', seedMetaKey: 'pressure:victim', intervalMs: HOUR, timeoutMs: 35_000 },
      ],
      { maxBundleMs: 60_000 },
      { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token },
    );
    assert.equal(code, 0, 'ordinary pressure with a healthy sibling stays exit 0');
    assert.match(stdout, /\[Bundle:test\] Finished .* ran:1 skipped:10 deferred:1 failed:0 graceful:0 stalled:0/);
    assert.doesNotMatch(stderr, /starvation/);
  } finally {
    cleanup();
    await redis.close();
  }
});
