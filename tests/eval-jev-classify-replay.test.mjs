import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/eval-jev-classify.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/jev-classify-golden-2026-09-18.json', import.meta.url));

function runEval(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...argv], {
      env: { PATH: process.env.PATH },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe('eval-jev-classify --replay', () => {
  it('refuses --replay without --golden before any request', async () => {
    const { code, stderr } = await runEval(['--replay']);
    assert.equal(code, 2);
    assert.match(stderr, /--replay requires --golden <file>/);
  });

  it('scores the golden fixture offline without TYPESAFE_API_KEY', async () => {
    const { code, stdout, stderr } = await runEval(['--golden', GOLDEN, '--replay']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /=== single ===/);
    assert.match(stdout, /"titles": 255/);
  });
});
