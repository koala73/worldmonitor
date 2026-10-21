import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractBundleSections, resolveExpr } from './helpers/bundle-section-parser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
const section = extractBundleSections(bundle).find(({ label }) => label === 'Toronto-Roads');
const timeoutMs = resolveExpr(bundle, section.timeoutMsExpr);
const runnerUrl = pathToFileURL(join(root, 'scripts/_bundle-runner.mjs')).href;
const fixture = readFileSync(join(root, 'tests/fixtures/toronto-road-restrictions.json'), 'utf8');

// Exercise the real runner -> seeder -> adapter -> runSeed chain. Only external
// I/O and wall time are replaced; no production keys or credentials are used.
async function runScenario(t, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-toronto-timeout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, 'transport.mjs');
  writeFileSync(preload, `
    const timer = globalThis.setTimeout;
    const abortTimeout = AbortSignal.timeout;
    globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms / 20, ...args);
    AbortSignal.timeout = (ms) => abortTimeout(Math.ceil(ms / 20));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const hang = () => new Promise(() => { setInterval(() => {}, 1_000); });
    const mode = ${JSON.stringify(mode)};
    const lastGood = JSON.stringify({ records: [{ id: 'last-good' }] });
    const values = new Map([['infra:toronto-roads:v1', lastGood]]);
    process.on('exit', () => {
      if (process.argv[1]?.endsWith('seed-toronto-road-restrictions.mjs')) {
        console.log('TEST_CANONICAL ' + values.get('infra:toronto-roads:v1'));
      }
    });
    let upstreamAttempts = 0;
    let stagingAttempts = 0;
    const response = result => new Response(JSON.stringify({ result }));
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith('https://secure.toronto.ca/')) {
        if (mode === 'fetch-hang') return hang();
        if (mode === 'slow-success') {
          await sleep(29_000);
          if (++upstreamAttempts < 3) throw new Error('synthetic upstream timeout');
        }
        return new Response(${JSON.stringify(fixture)});
      }
      if (!String(url).startsWith('https://redis.test')) {
        throw new Error('Unexpected external request: ' + url);
      }
      if (String(url).includes('/get/')) {
        if (mode === 'slow-success') await sleep(4_000);
        const key = decodeURIComponent(String(url).split('/get/')[1]);
        return response(values.get(key) || null);
      }
      const command = JSON.parse(init.body);
      if (String(url).endsWith('/pipeline')) {
        console.log('TEST_PRESERVE ' + JSON.stringify(command));
        return new Response(JSON.stringify(command.map(() => ({ result: 1 }))));
      }
      const [op, key, value] = command;
      if (op === 'SET' && key.startsWith('seed-lock:')) {
        console.log('TEST_LOCK ' + JSON.stringify(command));
        return response('OK');
      }
      if (op === 'SET' && key.includes(':staging:') && mode === 'slow-success') {
        await sleep(14_000);
        if (++stagingAttempts < 3) throw new Error('synthetic Redis timeout');
      } else if (op === 'SET' && key === 'infra:toronto-roads:v1' && mode === 'publish-hang') {
        return hang();
      } else if (mode === 'slow-success' && !String(key).startsWith('bundle:')) {
        await sleep(14_000);
      }
      if (op === 'SET') {
        values.set(key, value);
        console.log('TEST_SET ' + key);
        return response('OK');
      }
      if (op === 'EVAL') console.log('TEST_RELEASE');
      return response(1);
    };
  `);
  const source = `
    import { runBundle } from ${JSON.stringify(runnerUrl)};
    await runBundle('Canada-timeout-test', [{
      label: 'Toronto-Roads', script: 'seed-toronto-road-restrictions.mjs',
      timeoutMs: ${timeoutMs},
    }], { maxBundleMs: 570_000 });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '--import=' + pathToFileURL(preload).href,
        UPSTASH_REDIS_REST_URL: 'https://redis.test',
        UPSTASH_REDIS_REST_TOKEN: 'synthetic-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('Toronto road retry, publication, and cleanup fit the section deadline', { timeout: 30_000 }, async (t) => {
  const { code, output } = await runScenario(t, 'slow-success');
  assert.equal(code, 0, output);
  assert.match(output, /section=Toronto-Roads status=OK/);
  assert.match(output, /TEST_SET infra:toronto-roads:v1/);
  assert.match(output, /"recordCount":3/);
  assert.match(output, /Verified: data present in Redis/);
  assert.match(output, /TEST_RELEASE/);
  assert.doesNotMatch(output, /SIGTERM|section=Toronto-Roads status=FAILED/);
  assert.match(output, /phase=fetch status=FAILED durationMs=\d+/);
  assert.match(output, /phase=fetch status=OK durationMs=\d+ elapsedMs=\d+/);
  const lock = JSON.parse(output.match(/TEST_LOCK (\[.*\])/)[1]);
  assert.ok(lock[lock.indexOf('PX') + 1] > timeoutMs + 10_000,
    'lock must remain valid through the section timeout and termination grace');
});

test('Toronto road fetch deadline preserves last-good before the parent timeout', { timeout: 30_000 }, async (t) => {
  const { code, output } = await runScenario(t, 'fetch-hang');
  assert.equal(code, 0, output);
  assert.match(output, /section=Toronto-Roads status=GRACEFUL_FAIL/);
  assert.match(output, /TEST_PRESERVE .*infra:toronto-roads:v1/);
  assert.match(output, /TEST_RELEASE/);
  assert.doesNotMatch(output, /TEST_SET infra:toronto-roads:v1$|SIGTERM/m);
  assert.match(output, /TEST_CANONICAL {"records":\[{"id":"last-good"}\]}/);
});

test('Toronto road stalled publication still fails at the hard deadline', { timeout: 30_000, skip: process.platform === 'win32' }, async (t) => {
  const { code, output } = await runScenario(t, 'publish-hang');
  assert.equal(code, 1, output);
  assert.match(output, /section=Toronto-Roads status=FAILED.*timeout/);
  assert.match(output, /SIGTERM received during publish phase/);
  assert.match(output, /TEST_RELEASE/);
  assert.doesNotMatch(output, /TEST_SET infra:toronto-roads:v1$|"event":"seed_complete"/m);
  assert.match(output, /TEST_CANONICAL {"records":\[{"id":"last-good"}\]}/);
});
