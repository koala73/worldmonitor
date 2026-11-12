import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/status-page-monitor.yml', import.meta.url), 'utf8'));
const title = 'Status page synthetic check failing';

for (const [status, existing, author, expected] of [
  ['success', '', '', []], ['failure', '', '', ['create']],
  ['failure', '123', 'github-actions[bot]', []], ['success', '123', 'github-actions[bot]', ['close']],
  ['cancelled', '', '', ['create']],
  ['failure', '456', 'human-maintainer', ['create']], ['success', '456', 'human-maintainer', []],
]) {
  test(`alert lifecycle: ${status}, existing=${existing || 'none'}, author=${author}`, () => {
    const alert = workflow.jobs.report?.steps.find((step) => step.name === 'Track monitor failures and recovery');
    assert.ok(alert, 'alert must run in a separate reporting job after probe timeout');
    const directory = mkdtempSync(join(tmpdir(), 'status-monitor-test-'));
    try {
      const gh = join(directory, 'gh');
      const log = join(directory, 'calls');
      writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n'); if (args[0] === 'api') console.log(process.env.LIST_RESPONSE);\n`);
      chmodSync(gh, 0o755);
      const result = spawnSync('bash', ['-c', alert.run], { encoding: 'utf8', env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log,
        LIST_RESPONSE: JSON.stringify({ items: [{ number: 789, title, user: { login: 'outsider' } }, ...(existing ? [{ number: Number(existing), title, user: { login: author } }] : [])] }),
        MONITOR_STATUS: status, GITHUB_REPOSITORY: 'koala73/worldmonitor', GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '42', GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      } });
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.match(calls[0].join(' '), /author:app\/github-actions/);
      const mutations = calls.filter((args) => args[0] !== 'api');
      assert.deepEqual(mutations.map((args) => args[1]), expected);
      if (expected[0] === 'close') assert.equal(mutations[0][2], existing);
      if (mutations.length) assert.match(mutations[0].at(-1), /actions\/runs\/42/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('reporter survives monitor failure and isolates write permissions', () => {
  assert.equal(workflow.jobs.report?.needs, 'monitor');
  assert.match(workflow.jobs.report?.if ?? '', /always\(\)/);
  assert.match(workflow.jobs.report?.if ?? '', /needs.monitor.result != 'skipped'/);
  assert.equal(workflow.jobs.report.steps[0].env.MONITOR_STATUS, '${{ needs.monitor.result }}');
  assert.equal(workflow.jobs.report.permissions.issues, 'write');
  assert.equal(workflow.jobs.monitor.permissions?.issues, undefined);
  assert.match(workflow.jobs.monitor.if, /github.event_name != 'pull_request'/);
  assert.equal(workflow.permissions.issues, undefined);
  assert.equal(workflow.jobs.fixtures.permissions, undefined);
  assert.equal(workflow.jobs.report.steps.some((step) => step.uses?.startsWith('actions/checkout')), false);
});
