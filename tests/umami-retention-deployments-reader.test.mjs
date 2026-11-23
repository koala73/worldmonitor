import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RETENTION_HISTORY_WINDOW,
  evaluateRetentionRunner,
} from '../scripts/check-umami-retention-runner.mjs';
import { readRetentionDeployments } from '../scripts/read-umami-retention-deployments.mjs';

const PROJECT_ID = 'project-1';
const ENVIRONMENT_ID = 'environment-1';
const SERVICE_ID = 'service-retention';

// The production shape on 2026-11-22: the active deployment was 24 days old and
// healthy (ticks every 15 minutes), but 1000+ push refusals ("No changes to
// watched files") sat above it, so the CLI's 1000-record read held only
// refusals and the monitor reported HISTORY_WINDOW_SATURATED every run.
function productionHistory(refusalCount = 1200) {
  const newest = Date.parse('2026-11-23T02:39:03.667Z');
  const refusals = Array.from({ length: refusalCount }, (_, index) => ({
    id: `skip-${index}`,
    status: 'SKIPPED',
    createdAt: new Date(newest - index * 1_700_000).toISOString(),
  }));
  return [
    ...refusals,
    { id: 'active', status: 'SUCCESS', createdAt: '2026-10-29T19:06:41.530Z' },
    { id: 'older', status: 'REMOVED', createdAt: '2026-10-20T10:29:12.429Z' },
  ];
}

const PROJECT_LOOKUP = {
  project: {
    environments: { edges: [{ node: { id: ENVIRONMENT_ID, name: 'production' } }] },
    services: {
      edges: [
        { node: { id: 'service-other', name: 'umami' } },
        { node: { id: SERVICE_ID, name: 'umami-retention' } },
      ],
    },
  },
};

// A stand-in for Railway's GraphQL API that honours the deployment status
// filter the way the server does, so the test proves the filter is what
// reaches past the refusals.
function fakeRailway(history, calls = []) {
  return async (query, variables) => {
    calls.push({ query, variables });
    if (/project\(id:/.test(query)) return PROJECT_LOOKUP;
    const excluded = variables.input?.status?.notIn ?? [];
    const kept = history.filter((row) => !excluded.includes(row.status));
    return {
      deployments: {
        edges: kept.slice(0, variables.first).map((node) => ({ node })),
      },
    };
  };
}

describe('Umami retention deployment reader', () => {
  it('sees a healthy runner behind more refusals than the CLI can list', async () => {
    const calls = [];
    const rows = await readRetentionDeployments({
      projectId: PROJECT_ID,
      api: fakeRailway(productionHistory(), calls),
    });

    const result = evaluateRetentionRunner(rows);
    assert.equal(result.verdict, 'HEALTHY');
    assert.equal(result.deploymentId, 'active');

    const deploymentCall = calls.find((call) => /deployments\(/.test(call.query));
    assert.deepEqual(deploymentCall.variables.input, {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      // notIn rather than an allow-list, so a status Railway adds later still
      // comes back and trips UNKNOWN_STATUS instead of vanishing.
      status: { notIn: ['SKIPPED'] },
    });
    assert.equal(deploymentCall.variables.first, RETENTION_HISTORY_WINDOW);
  });

  it('still reports a crashed tick behind the refusals', async () => {
    const history = productionHistory();
    history[1200] = { ...history[1200], status: 'CRASHED' };
    const rows = await readRetentionDeployments({ projectId: PROJECT_ID, api: fakeRailway(history) });

    assert.equal(evaluateRetentionRunner(rows).verdict, 'CRASHED');
  });

  it('fails when the service or environment is not in the project', async () => {
    const api = async () => ({
      project: {
        environments: { edges: [{ node: { id: ENVIRONMENT_ID, name: 'production' } }] },
        services: { edges: [{ node: { id: 'service-other', name: 'umami' } }] },
      },
    });

    await assert.rejects(
      readRetentionDeployments({ projectId: PROJECT_ID, api }),
      /no service named umami-retention/,
    );
    await assert.rejects(
      readRetentionDeployments({ projectId: PROJECT_ID, environment: 'staging', api: fakeRailway([]) }),
      /no environment named staging/,
    );
  });

  it('rejects a deployment page without an edges array', async () => {
    const api = async (query) => (/project\(id:/.test(query) ? PROJECT_LOOKUP : { deployments: null });

    await assert.rejects(
      readRetentionDeployments({ projectId: PROJECT_ID, api }),
      /edges array/,
    );
  });
});
