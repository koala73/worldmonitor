import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const runnerPath = fileURLToPath(new URL('../scripts/run-railway-registry-sync.mjs', import.meta.url));
const auditPath = fileURLToPath(new URL('../scripts/audit-railway-watch-paths.mjs', import.meta.url));
const registry = JSON.parse(readFileSync(new URL('../scripts/railway-services.json', import.meta.url)));
const fleet = JSON.parse(readFileSync(new URL('../scripts/railway-native-autodeploy-fleet.json', import.meta.url))).services;
const imdId = fleet.find(({ name }) => name === 'seed-imd-cyclone-marine').id;
const otherId = fleet.find(({ name }) => name === 'seed-insights').id;
const secret = 'fixture-secret-must-not-appear-in-output';

function createFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'railway-registry-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  const summaryPath = join(directory, 'summary.md');
  const config = { services: {} };
  for (const { id, name } of fleet) {
    const entry = registry.find((candidate) => candidate.service === name);
    config.services[id] = {
      source: {
        repo: 'koala73/worldmonitor',
        rootDirectory: entry?.deployMode === 'nixpacks-root-scripts' ? 'scripts' : '',
      },
      build: { watchPatterns: entry?.watchPatterns ?? ['scripts/**', 'shared/**'], dockerfilePath: entry?.dockerfile },
      deploy: { startCommand: entry?.startCommand, cronSchedule: entry?.cronSchedule },
      variables: Object.fromEntries((entry?.requiredEnv ?? []).flat().map((name) => [name, secret])),
    };
  }
  const state = {
    inventory: fleet.map((service) => ({ ...service, source: { repo: 'koala73/worldmonitor' } })),
    config,
    edits: [],
  };
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  save();
  const cliPath = join(directory, 'railway');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const command = process.argv.slice(2, 4).join(' ');
if (command === 'service list') {
  console.log(JSON.stringify(state.inventory));
} else if (command === 'environment config') {
  if (state.failRead) { console.error('fixture observation failed'); process.exit(1); }
  console.log(JSON.stringify(state.config));
} else if (command === 'environment edit') {
  if (state.failWrite) { console.error('fixture write failed'); process.exit(1); }
  const patch = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.edits.push(patch);
  if (!state.ignoreWrite) {
    for (const [id, changes] of Object.entries(patch.services)) {
      for (const [section, values] of Object.entries(changes)) {
        Object.assign(state.config.services[id][section], values);
      }
    }
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log('{}');
} else {
  console.error('unexpected fixture command: ' + command);
  process.exit(1);
}
`);
  chmodSync(cliPath, 0o755);
  const run = (auditArgs) => spawnSync(process.execPath, auditArgs ? [auditPath, ...auditArgs] : [runnerPath, '--mode', 'apply'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      RAILWAY_PROJECT_ID: 'fixture-project',
      RAILWAY_TOKEN: 'fixture-token',
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  });
  return {
    state, save, run, summaryPath,
    read: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}

function assertSucceeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
}

describe('Railway registry sync CLI with unavailable source credentials', () => {
  it('does no work for matching configuration and complete credentials', (t) => {
    const fixture = createFixture(t);
    assertSucceeded(fixture.run());
    assert.deepEqual(fixture.read().edits, []);
  });

  it('reports a removed IMD key without failing or applying an empty patch', (t) => {
    const fixture = createFixture(t);
    delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
    fixture.save();
    const result = fixture.run();
    assertSucceeded(result);
    assert.match(result.stdout, /seed-imd-cyclone-marine.*IMD_API_KEY/);
    assert.match(result.stdout, /runtime prerequisites/i);
    assert.deepEqual(fixture.read().edits, []);
    const summary = readFileSync(fixture.summaryPath, 'utf8');
    assert.match(summary, /seed-imd-cyclone-marine.*IMD_API_KEY/);
    assert.match(summary, /not source health/i);
    assert.doesNotMatch(summary, new RegExp(secret));
  });

  it('repairs and verifies other services with the IMD key absent, then becomes a no-op', (t) => {
    const fixture = createFixture(t);
    delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
    const expected = [...fixture.state.config.services[otherId].build.watchPatterns];
    fixture.state.config.services[otherId].build.watchPatterns = ['wrong-path'];
    fixture.save();
    assertSucceeded(fixture.run());
    const updated = fixture.read();
    assert.deepEqual(updated.edits, [{ services: { [otherId]: { build: { watchPatterns: expected } } } }]);
    assert.equal(updated.config.services[imdId].variables.IMD_API_KEY, undefined);
    assert.deepEqual(updated.config.services[otherId].variables, fixture.state.config.services[otherId].variables);
    assertSucceeded(fixture.run());
    assert.equal(fixture.read().edits.length, 1);
  });

  it('retains the strict standalone readiness audit', (t) => {
    const fixture = createFixture(t);
    delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
    fixture.save();
    const result = fixture.run(['--environment', 'production']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /missing required environment IMD_API_KEY/);
    assert.deepEqual(fixture.read().edits, []);
  });

  it('separates runtime prerequisites from configuration drift in JSON output', (t) => {
    const fixture = createFixture(t);
    delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
    fixture.save();
    const result = fixture.run(['--apply', '--json']);
    assertSucceeded(result);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n')));
    assert.deepEqual(report.drift, []);
    assert.equal(report.requiredEnvironmentEvaluated, true);
    assert.deepEqual(report.runtimePrerequisites, [{
      service: 'seed-imd-cyclone-marine',
      missingRequiredEnv: ['IMD_API_KEY'],
    }]);
  });

  it('still refuses a missing managed service when another source is unavailable', (t) => {
    const fixture = createFixture(t);
    delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
    delete fixture.state.config.services[otherId];
    fixture.save();
    const result = fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /seed-insights not present in Railway production/);
    assert.deepEqual(fixture.read().edits, []);
  });

  it('still refuses an unsafe root change when a source is unavailable', (t) => {
    const fixture = createFixture(t);
    delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
    fixture.state.config.services[otherId].source.rootDirectory = 'wrong-root';
    fixture.save();
    const result = fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rootDirectory is.*wrong-root/);
    assert.deepEqual(fixture.read().edits, []);
  });

  for (const failure of ['failRead', 'failWrite', 'ignoreWrite']) {
    it(`does not hide ${failure} behind an unavailable source`, (t) => {
      const fixture = createFixture(t);
      delete fixture.state.config.services[imdId].variables.IMD_API_KEY;
      fixture.state.config.services[otherId].build.watchPatterns = ['wrong-path'];
      fixture.state[failure] = true;
      fixture.save();
      const result = fixture.run(['--apply', '--environment', 'production']);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, failure === 'ignoreWrite' ? /operational-config drift remains/ : /fixture (observation|write) failed/);
    });
  }
});
