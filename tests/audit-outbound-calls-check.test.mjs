import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// `--check` is the CI gate for #10189's outbound-deadline work: any fetch()
// call with no signal fails the lint job. The script audits `git ls-files`
// from its cwd, so each case runs it inside a throwaway repository.
const script = fileURLToPath(new URL('../scripts/audit-outbound-calls.mjs', import.meta.url));
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-outbound-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

function check(dir) {
  return spawnSync(process.execPath, [script, '--check'], { cwd: dir, encoding: 'utf8' });
}

describe('audit-outbound-calls --check', () => {
  it('fails and names a fetch with no signal', () => {
    const run = check(repoWith({ 'worker.mjs': "await fetch('https://example.com');\n" }));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /worker\.mjs:1/);
  });

  it('passes when every fetch carries a signal', () => {
    const run = check(repoWith({
      'worker.mjs': "await fetch('https://example.com', { signal: AbortSignal.timeout(5_000) });\n",
    }));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.includes('"records"'), false, 'check mode prints a summary, not the full inventory');
  });

  it('ignores test files', () => {
    const run = check(repoWith({ 'worker.test.mjs': "await fetch('https://example.com');\n" }));
    assert.equal(run.status, 0, run.stderr);
  });
});
