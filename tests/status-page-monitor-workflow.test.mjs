import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/status-page-monitor.yml', import.meta.url), 'utf8'));
const alert = workflow.jobs.monitor.steps.find((step) => step.name === 'Track monitor failures and recovery');

for (const [status, existing, expected] of [
  ['success', '', []], ['failure', '', ['create']],
  ['failure', '123', []], ['success', '123', ['close']], ['cancelled', '123', []],
]) {
  test(`alert lifecycle: ${status}, existing=${existing || 'none'}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'status-monitor-test-'));
    try {
      const gh = join(directory, 'gh');
      const log = join(directory, 'calls');
      writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n'); if (args[1] === 'list') console.log(process.env.EXISTING);\n`);
      chmodSync(gh, 0o755);
      const result = spawnSync('bash', ['-c', alert.run], { encoding: 'utf8', env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log, EXISTING: existing,
        MONITOR_STATUS: status, GITHUB_REPOSITORY: 'koala73/worldmonitor', GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '42', GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      } });
      assert.equal(result.status, 0, result.stderr);
      const mutations = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[1] !== 'list');
      assert.deepEqual(mutations.map((args) => args[1]), expected);
      if (expected[0] === 'close') assert.equal(mutations[0][2], existing);
      if (mutations.length) assert.match(mutations[0].at(-1), /actions\/runs\/42/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('PR fixtures cannot run the live monitor with an issue-write token', () => {
  assert.match(workflow.jobs.monitor.if, /github.event_name != 'pull_request'/);
  assert.equal(workflow.permissions.issues, undefined);
  assert.equal(workflow.jobs.fixtures.permissions, undefined);
  assert.equal(alert.if, 'always()');
});
