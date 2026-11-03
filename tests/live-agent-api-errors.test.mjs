import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import YAML from 'yaml';
import policy from '../shared/agent-request-policy.json' with { type: 'json' };

const suite = new URL('./live-api-cache-auth-regression.test.mjs', import.meta.url);
const marker = 'LIVE_SWEEP_PROBE_COMPLETED agent-api-errors';
const targets = ['https://worldmonitor.app', 'https://www.worldmonitor.app'].flatMap((host) =>
  ['/api/agent-readiness-missing-endpoint', '/api/graphql'].flatMap((path) =>
    ['ora-agent', 'curl/8.7.1', 'WorldMonitor-ReadinessCheck/1.0'].map((ua) => ({ url: host + path, ua }))));

// Run the actual production probe, substituting only the network boundary.
// Any unexpected fetch throws, so this test cannot contact production.
function runProbe(failure = {}) {
  const preload = `
    const targets = ${JSON.stringify(targets)};
    const failure = ${JSON.stringify(failure)};
    globalThis.fetch = async (url, init) => {
      const ua = new Headers(init.headers).get('user-agent');
      const index = targets.findIndex(t => t.url === String(url) && t.ua === ua);
      if (index < 0) throw new Error('Unexpected request: ' + url + ' ' + ua);
      console.info('FIXTURE_REQUEST ' + index);
      const control = ua === 'WorldMonitor-ReadinessCheck/1.0';
      let status = control ? 404 : 403;
      let body = control
        ? { error: { code: 'not_found', message: 'No API endpoint matches ' + new URL(url).pathname + '.', hint: 'See the API reference.' } }
        : ${JSON.stringify(policy.blockedResponse)};
      if (index === failure.index) {
        if (failure.kind === 'html') return new Response('<html>Blocked</html>', { status, headers: { 'content-type': 'text/html' } });
        if (failure.kind === 'status') status = control ? 403 : 404;
        if (failure.kind === 'hint') delete (control ? body.error : body).hint;
        if (failure.kind === 'code') (control ? body.error : body).code = 'other';
        if (failure.kind === 'invalid-json') return new Response('{', { status, headers: { 'content-type': 'application/json' } });
      }
      const response = Response.json(body, { status, headers: { 'cf-ray': 'fixture-ray' } });
      Object.defineProperty(response, 'url', { value: String(url).replace('https://worldmonitor.app/', 'https://www.worldmonitor.app/') });
      return response;
    };
  `;
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
    '--test', '--test-reporter=tap', '--test-name-pattern=API User-Agent denials', suite.pathname,
  ], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, LIVE_API_CACHE_TESTS: '1' } });
}

it('the live denial probe executes all twelve host/path/UA cases before marking completion', () => {
  const result = runProbe();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(marker));
  const requests = [...result.stdout.matchAll(/FIXTURE_REQUEST (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(requests.sort((a, b) => a - b), targets.map((_, index) => index));
});

it('HTML in any matrix cell fails the actual live probe and withholds its marker', () => {
  for (let index = 0; index < targets.length; index++) {
    const result = runProbe({ index, kind: 'html' });
    assert.equal(result.status, 1, `${JSON.stringify(targets[index])}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /application\/json/);
    assert.ok(!result.stdout.includes(marker));
  }
});

it('wrong status, malformed JSON, missing hints and changed codes fail denied and origin controls', () => {
  for (const index of [0, 2]) {
    for (const kind of ['status', 'invalid-json', 'hint', 'code']) {
      const result = runProbe({ index, kind });
      assert.equal(result.status, 1, `${kind}: ${result.stdout}${result.stderr}`);
      assert.ok(!result.stdout.includes(marker));
    }
  }
});

it('the workflow rejects missing completion even when other tests inflate the pass count', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/live-api-cache-auth.yml', import.meta.url), 'utf8'));
  const command = workflow.jobs.sweep.steps.find(step => step.env?.LIVE_API_CACHE_TESTS === '1').run;
  const guard = command.slice(command.indexOf('pass_count='));
  const names = command.match(/for probe in ([a-z -]+); do/)[1].split(' ');
  const directory = mkdtempSync(join(tmpdir(), 'live-agent-guard-'));
  try {
    const log = join(directory, 'sweep.log');
    const run = (count, omitted) => {
      writeFileSync(log, `# pass ${count}\n` + names.filter(name => name !== omitted)
        .map(name => `# LIVE_SWEEP_PROBE_COMPLETED ${name}\n`).join(''));
      return spawnSync('bash', ['-c', guard.replaceAll('/tmp/sweep.log', log)], { encoding: 'utf8' });
    };
    assert.equal(run(names.length + 1).status, 0);
    assert.equal(run(100, 'agent-api-errors').status, 1, 'unrelated passes cannot hide the missing denial probe');
    assert.equal(run(0).status, 1, 'skipped probes cannot pass');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
