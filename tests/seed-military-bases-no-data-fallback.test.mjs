// #6845 item 2 — when the volume file, the local file and R2 are all
// unavailable, the seeder restored the freshness marker from the active
// version and exited 0, with a DEEP validation walk (~250 round trips for
// ~125k members). The restored marker carries the active version's own
// timestamp, so once that data passed its interval the section was due again
// next tick and took the same path: a ~500-round-trip deep walk, every day,
// exiting green, with the data never refreshed and the tick indistinguishable
// from progress.
//
// Pinned here, end to end against the real script and a fake Upstash:
//   1. the fallback validates shallowly — no ZRANGE member walk at all;
//   2. data already past the interval exits GRACEFUL_FETCH_FAILURE_EXIT_CODE
//      (75) with a distinct warning, so the runner records GRACEFUL_FAIL;
//   3. data within the interval still exits 0 quietly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

function startFakeUpstash({ activeVersion, geoCount = 3, metaCount = 3 }) {
  const strings = new Map([
    ['military:bases:active', activeVersion],
    // Present on purpose: the missing-marker repair path would otherwise
    // short-circuit the run before the no-data fallback this file exercises.
    ['seed-meta:military:bases', JSON.stringify({
      fetchedAt: Number(activeVersion),
      recordCount: geoCount,
      sourceVersion: activeVersion,
    })],
  ]);
  const geoMembers = new Map([[`military:bases:geo:${activeVersion}`, ['a', 'b', 'c']]]);
  const zranges = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const commands = JSON.parse(body);
      const run = ([operation, key, ...args]) => {
        if (operation === 'GET') return { result: strings.get(key) ?? null };
        if (operation === 'ZCARD') return { result: geoMembers.get(key)?.length ?? 0 };
        if (operation === 'HLEN') return { result: metaCount };
        if (operation === 'ZRANGE') {
          zranges.push(key);
          return { result: geoMembers.get(key) ?? [] };
        }
        if (operation === 'SCAN') return { result: ['0', []] };
        if (operation === 'TTL') return { result: -1 };
        if (operation === 'SET') {
          strings.set(key, args[0]);
          return { result: 'OK' };
        }
        if (operation === 'EVAL') {
          // Backfill-if-active shape: CAS on the active version.
          const current = strings.get('military:bases:active') ?? '';
          return { result: [1, current] };
        }
        return { result: null };
      };
      const results = req.url === '/pipeline' ? commands.map(run) : run(commands);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(results));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        token: 'test-token',
        zranges: () => zranges,
        async close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

function runSeeder(fake, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, 'seed-military-bases.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        UPSTASH_REDIS_REST_URL: fake.url,
        UPSTASH_REDIS_REST_TOKEN: fake.token,
        // No CLOUDFLARE_* credentials and no /data volume: the local data
        // file is absent from the repo, so the run must take the fallback.
        CLOUDFLARE_R2_TOKEN: '',
        CLOUDFLARE_API_TOKEN: '',
        CLOUDFLARE_R2_ACCOUNT_ID: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('the no-data fallback walks nothing and exits 0 while data is within its interval', async () => {
  const fake = await startFakeUpstash({ activeVersion: String(Date.now() - 60_000) });
  try {
    const { code, stdout, stderr } = await runSeeder(fake);
    assert.equal(code, 0, `exit 0 expected\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /falling back to the published active version/);
    assert.equal(fake.zranges().length, 0, 'the fallback must validate shallowly — a daily ~250-round-trip member walk proves nothing about freshness');
    assert.doesNotMatch(stdout, /past the \d+d interval/);
  } finally {
    await fake.close();
  }
});

test('data past its interval exits 75 with a distinct warning instead of green', async () => {
  const fake = await startFakeUpstash({ activeVersion: String(Date.now() - 31 * DAY) });
  try {
    const { code, stdout, stderr } = await runSeeder(fake);
    assert.equal(code, 75, `exit 75 expected for already-stale data\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(`${stdout}${stderr}`, /past the 30d interval/);
    assert.match(`${stdout}${stderr}`, /distinguishable from progress/);
    assert.equal(fake.zranges().length, 0, 'the stale path must also stay shallow');
  } finally {
    await fake.close();
  }
});
