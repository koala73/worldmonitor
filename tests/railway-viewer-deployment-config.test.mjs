import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditRailwayServiceConfig,
  DEPLOYMENT_CONFIG_RUN_BUDGET_MS,
  managedRailwayServices,
  resolveDeploymentConfigDeadlineAt,
  validateAuditMode,
} from '../scripts/audit-railway-watch-paths.mjs';
import { readExpectedRepositoryFleet } from '../scripts/railway-cli.mjs';
import {
  DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR,
  DEPLOYMENT_ONLY_QUERY,
  projectViewerDeploymentConfig,
  readViewerDeploymentConfig,
} from '../scripts/railway-viewer-deployment-config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAILWAY_SERVICE_REGISTRY = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
);

function service({
  cronSchedule = '0 * * * *',
  dockerfilePath,
  variables = {},
  watchPatterns = [],
} = {}) {
  return {
    source: { repo: 'koala73/worldmonitor', rootDirectory: 'scripts' },
    build: {
      watchPatterns,
      ...(dockerfilePath === undefined ? {} : { dockerfilePath }),
    },
    deploy: { cronSchedule, startCommand: 'node seed-example.mjs' },
    variables,
  };
}

function viewerResponse(serviceId, {
  instance = {},
  trigger = {},
  pageInfo = {},
  activeDeployments = [{
    id: `deployment-${serviceId}`,
    serviceId,
    status: 'SUCCESS',
    createdAt: '2026-08-14T12:00:00.000Z',
    meta: { commitHash: 'a'.repeat(40) },
  }],
} = {}) {
  return {
    serviceInstance: {
      serviceId,
      source: { repo: 'koala73/worldmonitor', image: null },
      activeDeployments,
      ...instance,
    },
    deploymentTriggers: {
      pageInfo: { hasNextPage: false, ...pageInfo },
      edges: [{
        node: {
          serviceId,
          repository: 'koala73/worldmonitor',
          branch: 'main',
          checkSuites: false,
          provider: 'github',
          ...trigger,
        },
      }],
    },
  };
}

describe('Viewer-compatible deployment-only projection', () => {
  it('charges workflow prerequisites to the config-audit deadline', () => {
    assert.equal(DEPLOYMENT_CONFIG_RUN_BUDGET_MS, 15 * 60 * 1000);
    assert.equal(resolveDeploymentConfigDeadlineAt({
      jobStartedAtMs: 1_000,
      epochNow: 11 * 60 * 1000 + 1_000,
      monotonicNow: 50,
    }), 4 * 60 * 1000 + 50);
  });

  it('keeps every active registry-managed service in the immutable production fleet', () => {
    const expectedNames = new Set(readExpectedRepositoryFleet().map((service) => service.name));
    assert.deepEqual(
      managedRailwayServices(RAILWAY_SERVICE_REGISTRY)
        .map((entry) => entry.service)
        .filter((name) => !expectedNames.has(name)),
      [],
    );
  });

  it('projects only source, build, deploy, and trigger fields', () => {
    const projected = projectViewerDeploymentConfig({
      service: { id: 'svc-1', name: 'seed-example', source: { repo: 'koala73/worldmonitor' } },
      instance: {
        serviceId: 'svc-1',
        source: { repo: 'koala73/worldmonitor', image: null },
        rootDirectory: 'scripts',
        watchPatterns: ['scripts/**'],
        dockerfilePath: null,
        startCommand: 'node seed-example.mjs',
        cronSchedule: '0 * * * *',
      },
      triggers: {
        pageInfo: { hasNextPage: false },
        edges: [{
          node: {
            serviceId: 'svc-1',
            repository: 'koala73/worldmonitor',
            branch: 'main',
            checkSuites: false,
            provider: 'github',
          },
        }],
      },
    });

    assert.deepEqual(projected.source, {
      repo: 'koala73/worldmonitor',
      rootDirectory: 'scripts',
      branch: 'main',
      checkSuites: false,
    });
    assert.deepEqual(projected.build, {
      watchPatterns: ['scripts/**'],
      dockerfilePath: null,
    });
    assert.deepEqual(projected.deploy, {
      startCommand: 'node seed-example.mjs',
      cronSchedule: '0 * * * *',
    });
    assert.equal(Object.hasOwn(projected, 'activeDeployments'), false);
    assert.equal(Object.hasOwn(projected, 'variables'), false);
  });

  it('projects active deployment evidence only when the deploy drift caller opts in', () => {
    const response = viewerResponse('svc-1');
    const projected = projectViewerDeploymentConfig({
      service: { id: 'svc-1', name: 'seed-example', source: { repo: 'koala73/worldmonitor' } },
      instance: response.serviceInstance,
      triggers: response.deploymentTriggers,
      includeActiveDeployments: true,
    });

    assert.deepEqual(projected.activeDeployments, response.serviceInstance.activeDeployments);
  });

  it('makes variable reads structurally impossible and refuses deployment-only apply', () => {
    assert.match(DEPLOYMENT_ONLY_QUERY, /serviceInstance/);
    assert.match(DEPLOYMENT_ONLY_QUERY, /\$includeActiveDeployments:\s*Boolean!/);
    assert.match(DEPLOYMENT_ONLY_QUERY, /activeDeployments\s+@include\(if:\s*\$includeActiveDeployments\)/);
    assert.match(DEPLOYMENT_ONLY_QUERY, /deploymentTriggers/);
    assert.match(DEPLOYMENT_ONLY_QUERY, /first:\s*2/);
    assert.doesNotMatch(DEPLOYMENT_ONLY_QUERY, /variables|environmentVariables/i);
    assert.doesNotMatch(DEPLOYMENT_ONLY_QUERY, /mutation|environment\s*config/i);
    assert.throws(
      () => validateAuditMode({ apply: true, deploymentOnly: true }),
      /deployment-only.*--apply/i,
    );
    assert.doesNotThrow(() => validateAuditMode({ apply: false, deploymentOnly: true }));
  });

  it('does not claim required-environment coverage without variable visibility', () => {
    const config = { services: { 'svc-1': service({ watchPatterns: ['scripts/**'] }) } };
    const registry = [{
      service: 'seed-example',
      watchPatterns: ['scripts/**'],
      requiredEnv: ['SECRET_ONLY_OPERATOR_CAN_READ'],
    }];
    const full = auditRailwayServiceConfig(config, { 'seed-example': 'svc-1' }, registry);
    assert.deepEqual(full[0].missingRequiredEnv, ['SECRET_ONLY_OPERATOR_CAN_READ']);
    const deploymentOnly = auditRailwayServiceConfig(
      config,
      { 'seed-example': 'svc-1' },
      registry,
      { evaluateRequiredEnv: false },
    );
    assert.deepEqual(deploymentOnly, []);
  });

  it('rejects asymmetric or malformed Viewer evidence', () => {
    const response = viewerResponse('svc-1');
    const base = {
      service: { id: 'svc-1', name: 'relay', source: { repo: 'koala73/worldmonitor' } },
      instance: response.serviceInstance,
      triggers: response.deploymentTriggers,
    };
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        instance: { ...base.instance, serviceId: undefined },
      }),
      /id .* does not match/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        instance: { ...base.instance, source: { repo: null } },
      }),
      /source repository.*inconsistent/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        service: { ...base.service, source: { repo: 'koala73/worldmonitor', image: 'other/image' } },
      }),
      /source repository.*inconsistent/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        service: { ...base.service, source: { repo: 'someone/else', image: null } },
      }),
      /source repository.*inconsistent/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        instance: { ...base.instance, source: { repo: 'koala73/worldmonitor', image: 'postgres:17' } },
      }),
      /source repository.*inconsistent/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: { pageInfo: {}, edges: base.triggers.edges },
      }),
      /whether another page exists/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: { ...base.triggers, edges: [...base.triggers.edges, base.triggers.edges[0]] },
      }),
      /exactly one/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: { ...base.triggers, edges: [] },
      }),
      /exactly one/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: { ...base.triggers, edges: null },
      }),
      /edges array/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: { ...base.triggers, edges: [{ nope: true }] },
      }),
      /malformed/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          pageInfo: { hasNextPage: true },
        },
      }),
      /exceeded.*page/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          edges: [{ node: { ...base.triggers.edges[0].node, serviceId: 'svc-other' } }],
        },
      }),
      /another service/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          edges: [{ node: { ...base.triggers.edges[0].node, repository: 'someone/else' } }],
        },
      }),
      /exactly one.*deployment trigger/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          edges: [{ node: { ...base.triggers.edges[0].node, branch: null } }],
        },
      }),
      /malformed deployment trigger/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          edges: [{ node: { ...base.triggers.edges[0].node, provider: 'gitlab' } }],
        },
      }),
      /GitHub deployment trigger/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          edges: [{ node: { ...base.triggers.edges[0].node, provider: 42 } }],
        },
      }),
      /malformed deployment trigger/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        triggers: {
          ...base.triggers,
          edges: [{ node: { ...base.triggers.edges[0].node, checkSuites: 'false' } }],
        },
      }),
      /malformed deployment trigger/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        includeActiveDeployments: true,
        instance: {
          ...base.instance,
          activeDeployments: [{
            id: 'deployment-1',
            serviceId: 'svc-other',
            status: 'SUCCESS',
            createdAt: '2026-08-14T12:00:00.000Z',
            meta: { commitHash: 'a'.repeat(40) },
          }],
        },
      }),
      /active deployment.*another service/i,
    );
    assert.throws(
      () => projectViewerDeploymentConfig({
        ...base,
        includeActiveDeployments: true,
        instance: {
          ...base.instance,
          activeDeployments: [{
            id: 'deployment-1',
            serviceId: 'svc-1',
            status: 'SUCCESS',
            createdAt: 'not-a-date',
            meta: { commitHash: 'a'.repeat(40) },
          }],
        },
      }),
      /active deployment.*malformed/i,
    );
  });

  it('audits native source invariants across non-seeder repository services', () => {
    const source = { repo: 'koala73/worldmonitor', branch: 'main' };
    const config = {
      services: {
        relay: {
          source,
          build: { watchPatterns: ['src/**'] },
          deploy: { startCommand: 'node relay.mjs' },
        },
      },
    };
    const audit = () => auditRailwayServiceConfig(
      config,
      { 'ais-relay': 'relay' },
      [],
      { evaluateRequiredEnv: false, requireMainTrigger: true },
    );

    let drift = audit();
    assert.equal(drift.length, 1);
    assert.equal(drift[0].service, 'ais-relay');
    assert.deepEqual(drift[0].checkSuites, { actual: null, expected: false });

    source.checkSuites = 'false';
    drift = audit();
    assert.deepEqual(drift[0].checkSuites, { actual: 'false', expected: false });

    source.checkSuites = true;
    drift = audit();
    assert.deepEqual(drift[0].checkSuites, { actual: true, expected: false });

    source.branch = 'feature';
    drift = audit();
    assert.deepEqual(drift[0].sourceBranch, { actual: 'feature', expected: 'main' });

    source.branch = 'main';
    source.checkSuites = false;
    assert.deepEqual(audit(), []);
  });

  it('shares the run deadline across the whole service projection', async () => {
    const services = [
      { id: 'svc-1', name: 'one', source: { repo: 'koala73/worldmonitor' } },
      { id: 'svc-2', name: 'two', source: { repo: 'koala73/worldmonitor' } },
    ];
    let now = 0;
    const calls = [];
    await assert.rejects(
      readViewerDeploymentConfig('production', services, {
        projectId: 'project-1',
        resolveEnvironment: () => 'environment-1',
        concurrency: 1,
        deadlineAt: 100,
        monotonicNow: () => now,
        api: async (_query, variables, options) => {
          calls.push({ variables, options });
          now = 101;
          return viewerResponse(variables.serviceId, { trigger: { checkSuites: true } });
        },
      }),
      new RegExp(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR),
    );
    assert.equal(calls.length, 1, 'a projection must not start after the shared deadline');
    assert.equal(calls[0].options.timeoutMs, 100);
  });

  it('does not start Viewer reads when environment resolution exhausts the deadline', async () => {
    const services = [
      { id: 'svc-1', name: 'one', source: { repo: 'koala73/worldmonitor' } },
    ];
    let apiCalls = 0;
    await assert.rejects(
      readViewerDeploymentConfig('production', services, {
        projectId: 'project-1',
        deadlineAt: 0,
        monotonicNow: () => 0,
        resolveEnvironment: () => assert.fail('environment resolution must not start'),
        api: async () => { apiCalls += 1; },
      }),
      new RegExp(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR),
    );
    assert.equal(apiCalls, 0);

    let now = 0;
    await assert.rejects(
      readViewerDeploymentConfig('production', services, {
        projectId: 'project-1',
        deadlineAt: 100,
        monotonicNow: () => now,
        resolveEnvironment: (_environment, _projectId, options) => {
          assert.equal(options.timeoutMs, 100);
          now = 100;
          return 'environment-1';
        },
        api: async () => { apiCalls += 1; },
      }),
      new RegExp(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR),
    );
    assert.equal(apiCalls, 0);
  });

  it('hydrates the full projection with bounded concurrency', async () => {
    const services = Array.from({ length: 5 }, (_, index) => ({
      id: `svc-${index}`,
      name: `service-${index}`,
      source: { repo: 'koala73/worldmonitor' },
    }));
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const projected = await readViewerDeploymentConfig('production', services, {
      projectId: 'project-1',
      environmentId: 'environment-1',
      concurrency: 2,
      api: async (_query, variables) => {
        calls.push(variables);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return viewerResponse(variables.serviceId);
      },
    });
    assert.equal(maxActive, 2);
    assert.equal(calls.length, services.length);
    assert.equal(calls.every((variables) => variables.includeActiveDeployments === false), true);
    assert.deepEqual(Object.keys(projected.services).sort(), services.map((service) => service.id).sort());
    assert.equal(
      Object.values(projected.services).every((config) => !Object.hasOwn(config, 'activeDeployments')),
      true,
    );
  });

  it('requests and validates active deployment evidence for deploy drift only', async () => {
    const services = [{
      id: 'svc-1',
      name: 'service-1',
      source: { repo: 'koala73/worldmonitor' },
    }];
    const calls = [];
    const projected = await readViewerDeploymentConfig('production', services, {
      projectId: 'project-1',
      environmentId: 'environment-1',
      includeActiveDeployments: true,
      api: async (_query, variables) => {
        calls.push(variables);
        return viewerResponse(variables.serviceId);
      },
    });

    assert.equal(calls[0].includeActiveDeployments, true);
    assert.deepEqual(
      projected.services['svc-1'].activeDeployments,
      viewerResponse('svc-1').serviceInstance.activeDeployments,
    );
  });

  it('fails the whole projection when one Viewer API read fails', async () => {
    const services = [
      { id: 'svc-fail', name: 'fail', source: { repo: 'koala73/worldmonitor' } },
      { id: 'svc-ok-1', name: 'ok-1', source: { repo: 'koala73/worldmonitor' } },
      { id: 'svc-ok-2', name: 'ok-2', source: { repo: 'koala73/worldmonitor' } },
      { id: 'svc-ok-3', name: 'ok-3', source: { repo: 'koala73/worldmonitor' } },
      { id: 'svc-ok-4', name: 'ok-4', source: { repo: 'koala73/worldmonitor' } },
    ];
    let calls = 0;
    await assert.rejects(
      readViewerDeploymentConfig('production', services, {
        projectId: 'project-1',
        environmentId: 'environment-1',
        concurrency: 2,
        api: async (_query, variables) => {
          calls += 1;
          if (variables.serviceId === 'svc-fail') throw new Error('Viewer denied');
          await new Promise((resolve) => setTimeout(resolve, 5));
          return viewerResponse(variables.serviceId);
        },
      }),
      /Viewer denied/,
    );
    assert.equal(calls, 2, 'a failed batch must not schedule work beyond its in-flight reads');
  });

  it('reports one service drift record when source and runtime fields both drift', () => {
    const config = {
      services: {
        'svc-1': {
          source: { repo: 'koala73/worldmonitor', branch: 'feature', rootDirectory: 'scripts' },
          build: { watchPatterns: ['wrong/**'], dockerfilePath: 'Dockerfile.seed' },
          deploy: { cronSchedule: '0 * * * *' },
        },
      },
    };
    const drift = auditRailwayServiceConfig(
      config,
      { 'seed-example': 'svc-1' },
      [{
        service: 'seed-example',
        deployMode: 'nixpacks-root-scripts',
        watchPatterns: ['scripts/**'],
      }],
      { evaluateRequiredEnv: false, requireMainTrigger: true },
    );
    assert.equal(drift.length, 1);
    assert.equal(drift[0].service, 'seed-example');
    assert.deepEqual(drift[0].sourceBranch, { actual: 'feature', expected: 'main' });
    assert.deepEqual(drift[0].watchPatterns, {
      actual: ['wrong/**'],
      expected: ['scripts/**'],
    });
  });
});
