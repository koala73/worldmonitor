import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('fixture CLI emits strict JSON and malformed input fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pizzint-history-'));
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  await writeFile(good, '[]');
  await writeFile(bad, '{}');
  const ok = spawnSync(process.execPath, ['scripts/evaluate-pizzint-history.mjs', '--input', good, '--as-of', '2026-09-28T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).counts, { input: 0, included: 0, excluded: 0 });
  const failed = spawnSync(process.execPath, ['scripts/evaluate-pizzint-history.mjs', '--input', bad], { encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /fixture must be an array/);
});

test('live CLI unwraps Redis results and rejects failed reads and timezone-free cutoffs', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  let mode = 'good';
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const command = JSON.parse(body);
      assert.equal(command[0], 'HGETALL');
      calls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(mode === 'good' ? { result: [] } : { error: 'fixture read failure' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = (asOf) => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/evaluate-pizzint-history.mjs', '--as-of', asOf, '--days', '1'], { env: { ...process.env, UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`, UPSTASH_REDIS_REST_TOKEN: 'fixture' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    const good = await run('2026-09-28T00:00:00Z');
    assert.equal(good.code, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).counts.input, 0);
    assert.equal(calls, 4);
    mode = 'error';
    const bad = await run('2026-09-28T00:00:00Z');
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Redis history read failed/);
    const noZone = await run('2026-09-28T00:00:00');
    assert.notEqual(noZone.code, 0);
    assert.match(noZone.stderr, /explicit timezone/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a ten-venue 90-day archive fits the report bounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pizzint-history-volume-'));
  const input = join(dir, 'records.json');
  const records = [];
  const start = Date.parse('2026-06-30T00:00:00Z');
  for (let slot = 0; slot < 90 * 144; slot++) {
    for (let venue = 0; venue < 10; venue++) records.push({ v: 1, p: 'besttime', i: `venue-${venue}`, c: start + slot * 600000, s: null, l: 20, f: 25, q: 'available', b: 'c' });
  }
  await writeFile(input, JSON.stringify(records));
  const result = spawnSync(process.execPath, ['scripts/evaluate-pizzint-history.mjs', '--input', input, '--as-of', '2026-09-28T00:00:00Z'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.input, 129600);
  assert.ok(report.cohorts.some(cohort => cohort.status === 'ready'));
});
