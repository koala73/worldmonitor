// Verifies _bundle-runner.mjs streams child stdio live, reports timeout with
// a clear reason, and escalates SIGTERM → SIGKILL when a child ignores SIGTERM.
//
// Uses a real spawn of a small bundle against ephemeral scripts under scripts/
// because the runner joins __dirname with section.script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = new URL('../scripts/', import.meta.url).pathname;

function runBundleWith(sections, opts = {}) {
  const runPath = join(SCRIPTS_DIR, '_bundle-runner-test-run.mjs');
  writeFileSync(
    runPath,
    `import { runBundle } from './_bundle-runner.mjs';\nawait runBundle('test', ${JSON.stringify(
      sections,
    )}, ${JSON.stringify(opts)});\n`,
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runPath], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const path = join(SCRIPTS_DIR, name);
  writeFileSync(path, body);
  return () => { try { unlinkSync(path); } catch {} };
}

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

test('timeout escalates to SIGKILL when child ignores SIGTERM and logs reason', async () => {
  const cleanup = writeFixture(
    '_bundle-fixture-hang.mjs',
    // Ignore SIGTERM so the runner must SIGKILL.
    `process.on('SIGTERM', () => {}); console.log('hung'); setInterval(() => {}, 1000);\n`,
  );
  try {
    const t0 = Date.now();
    const { code, stdout, stderr } = await runBundleWith([
      { label: 'HANG', script: '_bundle-fixture-hang.mjs', intervalMs: 1, timeoutMs: 1000 },
    ]);
    const elapsedMs = Date.now() - t0;
    assert.equal(code, 1, 'bundle must exit non-zero on failure');
    const combined = stdout + stderr;
    assert.match(combined, /\[HANG\] hung/, 'child stdout should stream before kill');
    assert.match(combined, /Timeout at 1s — sending SIGTERM/);
    assert.match(combined, /Did not exit on SIGTERM.*SIGKILL/);
    assert.match(combined, /Failed after .*s: timeout after 1s/);
    // 1s timeout + 10s SIGTERM grace + overhead; cap well above that to avoid flake.
    assert.ok(elapsedMs < 20_000, `timeout escalation took ${elapsedMs}ms — too slow`);
  } finally {
    cleanup();
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
