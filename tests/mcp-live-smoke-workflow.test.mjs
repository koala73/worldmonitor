import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import YAML from 'yaml';

const workflowPath = new URL('../.github/workflows/mcp-live-smoke.yml', import.meta.url);
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);
const smoke = workflow.jobs.smoke;

// `on:` is the YAML 1.1 boolean `true` after parsing, not the string "on".
const triggers = workflow.on ?? workflow[true];

const normalize = (expression) => expression.replace(/\s+/g, ' ').trim();

describe('MCP live smoke workflow', () => {
  it('runs on production deployments, merges to the smoke sources, schedule, and manual dispatch', () => {
    assert.deepEqual(
      Object.keys(triggers).sort(),
      ['deployment_status', 'push', 'schedule', 'workflow_dispatch'],
    );
    assert.deepEqual(triggers.schedule, [{ cron: '23 */6 * * *' }]);
  });

  it('keeps the push trigger scoped to the sources Vercel never deploys', () => {
    // scripts/vercel-ignore.sh omits these paths from its web-relevant
    // allowlist, so a merge touching only them produces no Vercel build and
    // therefore no deployment_status event. Without this trigger such a merge
    // gets no validating run at all until the next 6-hourly cron.
    assert.deepEqual(triggers.push.branches, ['main']);
    assert.deepEqual(triggers.push.paths.slice().sort(), [
      '.github/workflows/mcp-live-smoke.yml',
      'scripts/mcp-live-smoke.mjs',
      'scripts/mcp-schema-wire-check.mjs',
    ]);

    const ignoreScript = readFileSync(
      new URL('../scripts/vercel-ignore.sh', import.meta.url),
      'utf8',
    );
    for (const path of triggers.push.paths) {
      assert.ok(
        !ignoreScript.includes(`'${path}'`),
        `${path} is now web-relevant in vercel-ignore.sh; a deployment_status run would cover it, so re-check whether the push trigger is still required`,
      );
    }
  });

  it('gates deployment_status runs on the whole predicate, not its parts', () => {
    assert.equal(
      normalize(smoke.if),
      normalize(`
        github.event_name != 'deployment_status' ||
        (
          github.event.deployment_status.state == 'success' &&
          github.event.deployment.environment == 'Production' &&
          github.event.deployment.creator.login == 'vercel[bot]'
        )
      `),
    );
  });

  it('evaluates the gate correctly for every event this repo emits', () => {
    const deploymentGateAllows = ({ event_name, state, environment, creator }) =>
      event_name !== 'deployment_status'
      || (state === 'success' && environment === 'Production' && creator === 'vercel[bot]');

    assert.equal(deploymentGateAllows({ event_name: 'schedule' }), true);
    assert.equal(deploymentGateAllows({ event_name: 'workflow_dispatch' }), true);
    assert.equal(deploymentGateAllows({ event_name: 'push' }), true);
    assert.equal(
      deploymentGateAllows({ event_name: 'deployment_status', state: 'success', environment: 'Production', creator: 'vercel[bot]' }),
      true,
    );
    assert.equal(
      deploymentGateAllows({ event_name: 'deployment_status', state: 'success', environment: 'Preview', creator: 'vercel[bot]' }),
      false,
    );
    assert.equal(
      deploymentGateAllows({ event_name: 'deployment_status', state: 'success', environment: 'staging - docs', creator: 'mintlify[bot]' }),
      false,
    );
    assert.equal(
      deploymentGateAllows({ event_name: 'deployment_status', state: 'success', environment: 'world-monitor / production', creator: 'railway-app[bot]' }),
      false,
    );
    assert.equal(
      deploymentGateAllows({ event_name: 'deployment_status', state: 'failure', environment: 'Production', creator: 'vercel[bot]' }),
      false,
    );
  });

  it('keys concurrency per environment so ineligible deploys cannot evict a queued production run', () => {
    // GitHub cancels the previously PENDING run in a group when a new one is
    // queued, even with cancel-in-progress: false. The group is claimed before
    // the job-level `if:` is evaluated, so a static group would let the repo's
    // Preview/Railway/Mintlify deployment_status flood silently drop a real
    // production smoke — a cancelled run being neither pass nor fail.
    assert.match(workflow.concurrency.group, /github\.event\.deployment\.environment/);
    assert.notEqual(normalize(workflow.concurrency.group), 'mcp-live-smoke-production');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });

  it('checks out the deployed commit on deployment_status and the default branch otherwise', () => {
    const checkout = smoke.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(
      normalize(checkout.with.ref),
      "${{ github.event_name == 'deployment_status' && github.event.deployment.sha || github.sha }}",
    );
  });

  it('installs the locked AJV dependency before running the smoke', () => {
    const runSteps = smoke.steps.filter((step) => typeof step.run === 'string');
    const installIndex = runSteps.findIndex((step) => step.run.includes('npm ci --ignore-scripts'));
    const smokeIndex = runSteps.findIndex((step) => step.run.includes('node scripts/mcp-live-smoke.mjs'));

    assert.notEqual(installIndex, -1, 'workflow must install locked dependencies');
    assert.notEqual(smokeIndex, -1, 'workflow must run the smoke script');
    // Ordering is the point: mcp-live-smoke.mjs imports mcp-schema-wire-check.mjs,
    // which imports ajv at module load, so a reordered install throws
    // ERR_MODULE_NOT_FOUND. This workflow excludes pull_request, so that failure
    // would surface only on a scheduled or deploy run, never in PR CI.
    assert.ok(installIndex < smokeIndex, 'npm ci must run before the smoke script');

    const setupNode = smoke.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(setupNode.with.cache, 'npm');
  });

  it('keeps the job read-only and off pull_request', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(triggers.pull_request, undefined);
  });
});
