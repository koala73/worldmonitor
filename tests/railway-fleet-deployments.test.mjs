// #6142 — reading every service's deployment history in a handful of calls.
//
// The fleet stream replaced 77 per-service round trips (~7 minutes) with ~6
// pages (~16s). The risk it introduces is a NEW way to be wrong about a
// service: paging stops early and the caller reads the gap as "this service has
// no deployments". That is the same fail-open shape as every other bug this
// file's siblings have had, so the stopping rule and the unresolved set are
// what these tests are for.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createRailwayCliEnv,
  DEPLOYMENT_READ_DEADLINE_ERROR,
  readAllDeployments,
  readDeployments,
  readDeploymentsForFleet,
  readExpectedRepositoryFleet,
  readFleetDeployments,
  runRailway,
  runRailwayApiAsync,
  selectExpectedRepositoryServices,
} from '../scripts/railway-cli.mjs';
import {
  createFleetAccumulator,
  limitDeploymentHistory,
  newestRunning,
} from '../scripts/railway-deployments.mjs';

const HEAD_AT = Date.parse('2026-08-04T12:00:00.000Z');

describe('Railway CLI child capability boundary', () => {
  const sourceEnv = {
    PATH: '/runner/bin',
    HOME: '/runner/home',
    RAILWAY_API_TOKEN: 'railway-api-token',
    RAILWAY_TOKEN: 'railway-token',
    RAILWAY_PROJECT_ID: 'project-1',
    RAILWAY_RECONCILE_MUTATION_HMAC: 'mutation-secret',
    RAILWAY_RECONCILE_OPERATOR_HMAC: 'operator-secret',
    GH_TOKEN: 'github-secret',
    GITHUB_TOKEN: 'github-actions-secret',
  };

  it('passes Railway credentials but strips control-plane and GitHub credentials', () => {
    assert.deepEqual(createRailwayCliEnv(sourceEnv), {
      HOME: '/runner/home',
      PATH: '/runner/bin',
      RAILWAY_API_TOKEN: 'railway-api-token',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_TOKEN: 'railway-token',
    });
  });

  it('applies the allowlist to sync and async Railway children', async () => {
    const childEnvironments = [];
    const deploymentArgs = [];
    runRailway(['--version'], { env: sourceEnv }, (_command, _args, options) => {
      childEnvironments.push(options.env);
      return { status: 0, signal: null, error: null, stdout: 'railway 4' };
    });
    await readDeployments({ id: 'svc-1' }, 'production', 1, {
      env: sourceEnv,
      execFileImpl: async (_command, args, options) => {
        deploymentArgs.push(args);
        childEnvironments.push(options.env);
        return { stdout: '[]' };
      },
    });
    const apiData = await runRailwayApiAsync('query { me { id } }', {}, {
      env: sourceEnv,
      execFileImpl: async (_command, _args, options) => {
        childEnvironments.push(options.env);
        return { stdout: '{"data":{"me":{"id":"viewer"}}}\n' };
      },
    });
    assert.deepEqual(apiData, { me: { id: 'viewer' } });
    assert.deepEqual(deploymentArgs, [[
      'deployment',
      'list',
      '--service',
      'svc-1',
      '--project',
      'project-1',
      '--environment',
      'production',
      '--limit',
      '1',
      '--json',
    ]]);
    assert.deepEqual(childEnvironments, [
      createRailwayCliEnv(sourceEnv),
      createRailwayCliEnv(sourceEnv),
      createRailwayCliEnv(sourceEnv),
    ]);
  });

  it('fails closed on Railway API error and non-data payloads', async () => {
    const execute = (stdout) => runRailwayApiAsync('query { me { id } }', {}, {
      execFileImpl: async () => ({ stdout }),
    });

    await assert.rejects(
      execute('Railway CLI update available\n{"errors":[{"message":"Viewer denied"}]}\n'),
      /Viewer denied/,
    );
    await assert.rejects(execute('{"data":null}\n'), /no JSON payload/i);
    await assert.rejects(execute('{"status":"ok"}\n'), /no JSON payload/i);
    await assert.rejects(execute('{not-json}\n'), SyntaxError);

    const childError = new Error('railway executable failed');
    await assert.rejects(
      runRailwayApiAsync('query { me { id } }', {}, {
        execFileImpl: async () => { throw childError; },
      }),
      (error) => error === childError,
    );
  });
});

describe('immutable native-autodeploy fleet', () => {
  const expected = [
    { id: 'svc-a', name: 'seed-a' },
    { id: 'svc-b', name: 'relay-b' },
  ];
  const live = (id, name, repo = 'koala73/worldmonitor') => ({
    id,
    name,
    source: { repo, image: null },
  });

  it('ships the exact 82-service fleet accepted by the terminal production run', () => {
    // 80 -> 81 -> 82: seed-bundle-canada (service 0a4b8757, cron */5) and then
    // seed-bundle-static-ref-heavy (service 6285c37b, cron 0 4 * * *) were
    // provisioned after that reconciliation. The roster is not a baseline to be
    // quieted — every mismatch is red — but it must list every repo-backed
    // service, or a service whose GitHub source detaches vanishes before
    // repository filtering and both read-only monitors report healthy. An
    // active registry row that is absent here fails the Viewer projection
    // audit, so the two move together.
    // NOTE: acceptedHead/acceptedRunId still name the pre-provisioning run; a
    // fresh reconciliation should re-stamp them.
    const fleet = readExpectedRepositoryFleet();
    assert.equal(fleet.length, 82);
    assert.equal(new Set(fleet.map((service) => service.id)).size, 82);
    assert.equal(new Set(fleet.map((service) => service.name)).size, 82);
    assert.deepEqual(
      fleet.map((service) => service.name),
      [...fleet.map((service) => service.name)].sort(),
    );
  });

  it('rejects malformed immutable fleet manifests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'railway-fleet-manifest-'));
    const path = join(directory, 'fleet.json');
    const valid = {
      version: 1,
      repository: 'koala73/worldmonitor',
      acceptedHead: 'a'.repeat(40),
      acceptedRunId: 123,
      services: expected,
    };
    const cases = [
      { ...valid, version: 2 },
      { ...valid, repository: 'someone/else' },
      { ...valid, acceptedHead: 'not-a-sha' },
      { ...valid, acceptedRunId: 1.5 },
      { ...valid, services: [] },
      { ...valid, services: [{ id: '', name: 'seed-a' }] },
      { ...valid, services: [...expected, { id: 'svc-a', name: 'other' }] },
      { ...valid, services: [...expected, { id: 'other', name: 'seed-a' }] },
    ];

    try {
      for (const manifest of cases) {
        writeFileSync(path, JSON.stringify(manifest));
        assert.throws(() => readExpectedRepositoryFleet(path), /fleet|manifest/i);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('selects the expected repository services in manifest order', () => {
    assert.deepEqual(
      selectExpectedRepositoryServices([
        live('other', 'database', null),
        live('svc-b', 'relay-b'),
        live('svc-a', 'seed-a'),
      ], expected).map((service) => service.name),
      ['seed-a', 'relay-b'],
    );
  });

  it('fails closed when an expected service is missing, detached, or replaced', () => {
    assert.throws(
      () => selectExpectedRepositoryServices([live('svc-a', 'seed-a')], expected),
      /relay-b.*missing/i,
    );
    assert.throws(
      () => selectExpectedRepositoryServices([
        live('svc-a', 'seed-a'),
        live('svc-b', 'relay-b', 'someone/else'),
      ], expected),
      /relay-b.*repository source/i,
    );
    assert.throws(
      () => selectExpectedRepositoryServices([
        live('svc-a', 'seed-a'),
        live('replacement-id', 'relay-b'),
      ], expected),
      /relay-b.*service id/i,
    );
  });

  it('fails closed when an unregistered repository service appears', () => {
    assert.throws(
      () => selectExpectedRepositoryServices([
        live('svc-a', 'seed-a'),
        live('svc-b', 'relay-b'),
        live('svc-new', 'seed-new'),
      ], expected),
      /unexpected repository service.*seed-new/i,
    );
  });

  it('rejects malformed, duplicate, renamed, or image-backed live inventory', () => {
    assert.throws(
      () => selectExpectedRepositoryServices([null], expected),
      /malformed service/i,
    );
    assert.throws(
      () => selectExpectedRepositoryServices([
        live('svc-a', 'seed-a'),
        live('svc-a', 'relay-b'),
      ], expected),
      /repeats id/i,
    );
    assert.throws(
      () => selectExpectedRepositoryServices([
        live('svc-a', 'seed-a'),
        live('svc-b', 'seed-a'),
      ], expected),
      /repeats name/i,
    );
    assert.throws(
      () => selectExpectedRepositoryServices([
        live('svc-a', 'renamed'),
        live('svc-b', 'relay-b'),
      ], expected),
      /is named renamed/i,
    );
    assert.throws(
      () => selectExpectedRepositoryServices([
        { ...live('svc-a', 'seed-a'), source: { repo: 'koala73/worldmonitor', image: 'postgres:17' } },
        live('svc-b', 'relay-b'),
      ], expected),
      /seed-a.*repository source/i,
    );
  });
});

function node(serviceId, status, at, commitHash) {
  return {
    id: `${serviceId}-${status}-${String(at)}-${commitHash ?? 'none'}`,
    serviceId,
    status,
    createdAt: at,
    meta: commitHash ? { commitHash } : {},
  };
}

describe('fleet accumulator', () => {
  it('rejects malformed Viewer active-deployment baselines', () => {
    assert.throws(
      () => createFleetAccumulator({
        serviceIds: ['a'],
        initialDeploymentsByService: [],
      }),
      /must be a Map/i,
    );
    assert.throws(
      () => createFleetAccumulator({
        serviceIds: ['a'],
        initialDeploymentsByService: new Map([['a', {}]]),
      }),
      /for a must be an array/i,
    );
    assert.throws(
      () => createFleetAccumulator({
        serviceIds: ['a'],
        initialDeploymentsByService: new Map([
          ['a', [node('b', 'SUCCESS', '2026-08-01T11:00:00Z', 'aaa')]],
        ]),
      }),
      /belongs to another service/i,
    );
  });

  it('uses Viewer active deployments as the running baseline and reads only recent fleet events', () => {
    const initialDeploymentsByService = new Map([
      ['a', [node('a', 'SUCCESS', '2026-08-01T11:00:00Z', 'aaa')]],
      ['b', [node('b', 'CRASHED', '2026-08-01T10:00:00Z', 'bbb')]],
    ]);
    const accumulator = createFleetAccumulator({
      serviceIds: ['a', 'b'],
      notBefore: HEAD_AT,
      initialDeploymentsByService,
    });

    accumulator.absorb([
      node('a', 'SKIPPED', '2026-08-04T11:00:00Z', 'head-a'),
      node('b', 'FAILED', '2026-08-04T10:00:00Z', 'head-b'),
    ]);

    assert.equal(accumulator.done, true, 'the stream is already older than the comparison head');
    assert.deepEqual(accumulator.result().unresolved, []);
    assert.deepEqual(
      accumulator.result().byService.get('a').map((deployment) => deployment.status),
      ['SKIPPED', 'SUCCESS'],
      'recent refusal evidence must be retained ahead of the active running baseline',
    );
  });

  it('groups a mixed stream by service', () => {
    const accumulator = createFleetAccumulator({ serviceIds: ['a', 'b'], notBefore: 0 });
    accumulator.absorb([
      node('a', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa'),
      node('b', 'REMOVED', '2026-08-04T10:00:00Z', 'bbb'),
      node('a', 'SKIPPED', '2026-08-04T09:00:00Z', 'ccc'),
    ]);
    const { byService } = accumulator.result();
    assert.equal(byService.get('a').length, 2);
    assert.equal(byService.get('b').length, 1);
  });

  it('ignores services outside the fleet', () => {
    const accumulator = createFleetAccumulator({ serviceIds: ['a'], notBefore: 0 });
    accumulator.absorb([node('zz', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa')]);
    assert.deepEqual([...accumulator.result().byService.keys()], ['a']);
  });

  it('uses foreign stream records to prove the global cursor crossed head', () => {
    const initialDeploymentsByService = new Map([
      ['a', [node('a', 'SUCCESS', '2026-08-04T13:00:00Z', 'aaa')]],
    ]);
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService,
    });

    accumulator.absorb([node('foreign', 'SUCCESS', '2026-08-04T11:00:00Z', 'bbb')]);

    assert.equal(accumulator.done, true);
    assert.equal(accumulator.result().byService.get('a').length, 1);
  });

  it('rejects malformed fleet timestamps instead of treating them as older than head', () => {
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService: new Map([
        ['a', [node('a', 'SUCCESS', '2026-08-04T13:00:00Z', 'aaa')]],
      ]),
    });

    for (const createdAt of ['not-a-date', 0, '2026-08-04']) {
      assert.throws(
        () => accumulator.absorb([node('foreign', 'FAILED', createdAt, 'head')]),
        /valid createdAt/i,
      );
    }
    assert.equal(accumulator.done, false);
  });

  it('uses the later fleet status when an active deployment changes state', () => {
    const activeBuilding = {
      ...node('a', 'BUILDING', '2026-08-04T10:00:00Z', 'head'),
      id: 'deployment-a',
    };
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService: new Map([['a', [activeBuilding]]]),
    });

    accumulator.absorb([{
      ...node('a', 'FAILED', '2026-08-04T11:00:00Z', 'head'),
      id: 'deployment-a',
    }]);

    assert.deepEqual(
      accumulator.result().byService.get('a').map((deployment) => deployment.status),
      ['FAILED'],
    );
    assert.deepEqual(accumulator.result().unresolved, ['a']);
  });

  it('keeps active provenance when the fleet repeats the same deployment state', () => {
    const active = {
      ...node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'serving'),
      id: 'deployment-a',
    };
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService: new Map([['a', [active]]]),
    });

    accumulator.absorb([{ ...active }]);

    assert.equal(newestRunning(accumulator.result().byService.get('a')).meta.commitHash, 'serving');
    assert.deepEqual(accumulator.result().unresolved, []);
  });

  it('requires a fresh direct read when a distinct newer deployment becomes active mid-scan', () => {
    const active = {
      ...node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'viewer-head'),
      id: 'viewer-active-a',
    };
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService: new Map([['a', [active]]]),
    });

    accumulator.absorb([{
      ...node('a', 'SUCCESS', '2026-08-04T11:00:00Z'),
      id: 'replacement-a',
    }]);

    assert.deepEqual(accumulator.result().unresolved, ['a']);
  });

  it('does not restore stale Viewer provenance after a newer deployment on an exhausted stream', () => {
    const active = {
      ...node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'viewer-head'),
      id: 'viewer-active-a',
    };
    const replacement = {
      ...node('a', 'SUCCESS', '2026-08-04T11:00:00Z'),
      id: 'replacement-a',
    };
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService: new Map([['a', [active]]]),
    });

    accumulator.absorb([replacement, { ...active }]);
    accumulator.markExhausted();

    assert.equal(newestRunning(accumulator.result().byService.get('a')).id, replacement.id);
    assert.deepEqual(accumulator.result().unresolved, []);
  });

  it('keeps the Viewer-active source authoritative over newer removed history', () => {
    const active = node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'serving');
    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      notBefore: HEAD_AT,
      initialDeploymentsByService: new Map([['a', [active]]]),
    });

    accumulator.absorb([
      node('a', 'REMOVED', '2026-08-04T11:00:00Z', 'aborted-head'),
      node('a', 'SKIPPED', '2026-08-04T09:00:00Z', 'skipped'),
    ]);

    assert.equal(newestRunning(accumulator.result().byService.get('a')), active);
  });

  it('retains only a Viewer-active running baseline beyond the recent-event window', () => {
    const skipped = Array.from({ length: 50 }, (_, index) => node(
      'a',
      'SKIPPED',
      new Date(Date.parse('2026-08-05T12:00:00Z') - index * 1_000).toISOString(),
      `skip-${index}`,
    ));
    const active = node('a', 'SUCCESS', '2026-08-01T11:00:00Z', 'running');

    const accumulator = createFleetAccumulator({
      serviceIds: ['a'],
      initialDeploymentsByService: new Map([['a', [active]]]),
    });
    accumulator.absorb(skipped);
    const limited = limitDeploymentHistory(accumulator.result().byService.get('a'), 50);

    assert.equal(limited.length, 51);
    assert.equal(newestRunning(limited), active);

    const historical = node('a', 'SUCCESS', '2026-08-01T10:00:00Z', 'historical');
    const directWindow = limitDeploymentHistory([...skipped, historical], 50);
    assert.equal(directWindow.length, 50, 'shared mutation callers retain their exact history window');
    assert.equal(newestRunning(directWindow), undefined);
  });

  it('is not done until every service has shown a RUNNING record without Viewer baselines', () => {
    const accumulator = createFleetAccumulator({ serviceIds: ['a', 'b'], notBefore: HEAD_AT });
    accumulator.absorb([node('a', 'SUCCESS', '2026-08-04T01:00:00Z', 'aaa')]);
    assert.equal(accumulator.done, false, 'b has not been located yet');
    accumulator.absorb([node('b', 'CRASHED', '2026-08-04T00:00:00Z', 'bbb')]);
    assert.equal(accumulator.done, true);
  });

  it('is not done until the stream is older than head, even with every service located', () => {
    // Records carrying headSha can only exist at or after head's commit time.
    // Stopping above that line can miss the record that says Railway took it.
    const accumulator = createFleetAccumulator({ serviceIds: ['a'], notBefore: HEAD_AT });
    accumulator.absorb([node('a', 'SUCCESS', '2026-08-04T13:00:00Z', 'aaa')]);
    assert.equal(accumulator.done, false, 'still newer than head');
    accumulator.absorb([node('a', 'REMOVED', '2026-08-04T11:00:00Z', 'aaa')]);
    assert.equal(accumulator.done, true);
  });

  it('a SKIPPED-only service is NOT counted as located without Viewer baselines', () => {
    // SKIPPED never produced an image, so it cannot answer "what is running".
    const accumulator = createFleetAccumulator({ serviceIds: ['a'], notBefore: HEAD_AT });
    accumulator.absorb([node('a', 'SKIPPED', '2026-08-04T01:00:00Z', 'aaa')]);
    assert.equal(accumulator.done, false);
    assert.deepEqual(accumulator.result().unresolved, ['a']);
  });

  it('reports an unreached service as unresolved, never as empty', () => {
    // The load-bearing one. A budget that ran out must not look like "this
    // service has no deployments" — that fabricates NEVER_DEPLOYED for a
    // healthy service and stops it ever being deployed again.
    const accumulator = createFleetAccumulator({ serviceIds: ['a', 'b'], notBefore: HEAD_AT });
    accumulator.absorb([node('a', 'SUCCESS', '2026-08-04T01:00:00Z', 'aaa')]);
    assert.deepEqual(accumulator.result().unresolved, ['b']);
  });

  it('only an exhausted stream proves a service genuinely has nothing', () => {
    const accumulator = createFleetAccumulator({ serviceIds: ['a', 'b'], notBefore: HEAD_AT });
    accumulator.absorb([node('a', 'SUCCESS', '2026-08-04T01:00:00Z', 'aaa')]);
    accumulator.markExhausted();
    assert.equal(accumulator.done, true);
    assert.deepEqual(accumulator.result().unresolved, [], 'nothing left to fetch, so b really has none');
  });
});

describe('fleet paging', () => {
  function pager(pages) {
    let index = 0;
    return () => {
      const page = pages[index] ?? { edges: [], pageInfo: { hasNextPage: false } };
      index += 1;
      return {
        deployments: {
          ...page,
          pageInfo: {
            ...page.pageInfo,
            ...(page.pageInfo?.hasNextPage ? { endCursor: `cursor-${index}` } : {}),
          },
        },
      };
    };
  }
  const page = (nodes, hasNextPage) => ({
    edges: nodes.map((n) => ({ node: n })),
    pageInfo: { hasNextPage, endCursor: 'cursor' },
  });

  it('stops as soon as the stopping rule is met', async () => {
    const api = pager([
      page([node('a', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa'), node('b', 'SUCCESS', '2026-08-04T10:00:00Z', 'bbb')], true),
      page([node('a', 'REMOVED', '2026-08-03T10:00:00Z', 'zzz')], true),
    ]);
    const result = await readFleetDeployments({
      projectId: 'p', environmentId: 'e', serviceIds: ['a', 'b'], notBefore: HEAD_AT,
      api, accumulatorFactory: createFleetAccumulator,
    });
    assert.equal(result.pages, 1, 'one page already satisfied both conditions');
    assert.deepEqual(result.unresolved, []);
  });

  it('does not discard Viewer running baselines when the recent stream contains only skipped pushes', async () => {
    const initialDeploymentsByService = new Map([
      ['a', [node('a', 'SUCCESS', '2026-08-01T11:00:00Z', 'aaa')]],
      ['b', [node('b', 'SUCCESS', '2026-08-01T10:00:00Z', 'bbb')]],
    ]);
    const api = pager([
      page([
        node('a', 'SKIPPED', '2026-08-04T11:00:00Z', 'head-a'),
        node('b', 'SKIPPED', '2026-08-04T10:00:00Z', 'head-b'),
      ], true),
    ]);

    const result = await readFleetDeployments({
      projectId: 'p',
      environmentId: 'e',
      serviceIds: ['a', 'b'],
      notBefore: HEAD_AT,
      maxPages: 1,
      api,
      accumulatorFactory: (args) => createFleetAccumulator({
        ...args,
        initialDeploymentsByService,
      }),
    });

    assert.equal(result.pages, 1);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(result.byService.get('a').map((deployment) => deployment.status), ['SKIPPED', 'SUCCESS']);
  });

  it('keeps paging while a service is still missing without Viewer baselines', async () => {
    const api = pager([
      page([node('a', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa')], true),
      page([node('b', 'SUCCESS', '2026-08-04T10:00:00Z', 'bbb')], true),
    ]);
    const result = await readFleetDeployments({
      projectId: 'p', environmentId: 'e', serviceIds: ['a', 'b'], notBefore: HEAD_AT,
      api, accumulatorFactory: createFleetAccumulator,
    });
    assert.equal(result.pages, 2);
    assert.deepEqual(result.unresolved, []);
  });

  it('honours the page cap and falls back every partial history', async () => {
    const api = pager(Array.from({ length: 20 }, () => page([node('a', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa')], true)));
    const result = await readFleetDeployments({
      projectId: 'p', environmentId: 'e', serviceIds: ['a', 'b'], notBefore: HEAD_AT,
      maxPages: 3, api, accumulatorFactory: createFleetAccumulator,
    });
    assert.equal(result.pages, 3, 'must not page forever');
    assert.deepEqual(result.unresolved, ['a', 'b'], 'the caller has to read every partial history directly');
  });

  it('treats a capped but non-exhausted stream as unresolved even when every service appeared', async () => {
    const api = pager([
      page([
        node('a', 'SUCCESS', '2026-08-04T12:00:00Z', 'aaa'),
        node('b', 'SUCCESS', '2026-08-04T12:00:00Z', 'bbb'),
      ], true),
    ]);
    const result = await readFleetDeployments({
      projectId: 'p', environmentId: 'e', serviceIds: ['a', 'b'],
      notBefore: Date.parse('2026-08-04T11:00:00Z'),
      maxPages: 1, api, accumulatorFactory: createFleetAccumulator,
    });
    assert.deepEqual(
      result.unresolved,
      ['a', 'b'],
      'a capped stream is not proof that either service history is complete',
    );
  });

  it('stops when the stream is exhausted', async () => {
    const api = pager([page([node('a', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa')], false)]);
    const result = await readFleetDeployments({
      projectId: 'p', environmentId: 'e', serviceIds: ['a', 'b'], notBefore: HEAD_AT,
      api, accumulatorFactory: createFleetAccumulator,
    });
    assert.equal(result.pages, 1);
    assert.deepEqual(result.unresolved, [], 'exhausted stream proves b has nothing');
  });

  it('throws rather than returning a partial answer when the shape is wrong', async () => {
    await assert.rejects(
      () => readFleetDeployments({
        projectId: 'p', environmentId: 'e', serviceIds: ['a'], notBefore: HEAD_AT,
        api: () => ({}), accumulatorFactory: createFleetAccumulator,
      }),
      /no deployments connection/,
    );
    await assert.rejects(
      () => readFleetDeployments({
        projectId: 'p',
        environmentId: 'e',
        serviceIds: ['a'],
        notBefore: HEAD_AT,
        api: () => ({ deployments: { edges: [], pageInfo: {} } }),
        accumulatorFactory: (args) => createFleetAccumulator({
          ...args,
          initialDeploymentsByService: new Map([
            ['a', [node('a', 'SUCCESS', '2026-08-04T13:00:00Z', 'aaa')]],
          ]),
        }),
      }),
      /hasNextPage.*boolean/i,
    );
    await assert.rejects(
      () => readFleetDeployments({
        projectId: 'p',
        environmentId: 'e',
        serviceIds: ['a'],
        notBefore: HEAD_AT,
        api: () => ({
          deployments: {
            edges: [{ node: node('a', 'SKIPPED', '2026-08-04T11:00:00Z', 'head') }],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        }),
        accumulatorFactory: (args) => createFleetAccumulator({
          ...args,
          initialDeploymentsByService: new Map([
            ['a', [node('a', 'SUCCESS', '2026-08-04T13:00:00Z', 'aaa')]],
          ]),
        }),
      }),
      /cursor/i,
    );
  });

  it('checks the shared run deadline before every fleet page', async () => {
    let elapsed = 0;
    let reads = 0;
    await assert.rejects(
      () => readFleetDeployments({
        projectId: 'p',
        environmentId: 'e',
        serviceIds: ['a'],
        notBefore: HEAD_AT,
        deadlineAt: 100,
        monotonicNow: () => elapsed,
        api: () => {
          reads += 1;
          elapsed = 101;
          return { deployments: page([node('a', 'SUCCESS', '2026-08-04T13:00:00Z', 'aaa')], true) };
        },
        accumulatorFactory: createFleetAccumulator,
      }),
      new RegExp(DEPLOYMENT_READ_DEADLINE_ERROR),
    );
    assert.equal(reads, 1, 'the second fleet page must not start after the deadline');
  });
});

describe('fleet read deadline', () => {
  it('refreshes only a service whose active source changes during the fleet scan', async () => {
    const services = [{ id: 'a' }, { id: 'b' }];
    const directReads = [];
    const active = new Map([
      ['a', [{ ...node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'old-a'), id: 'active-a' }]],
      ['b', [{ ...node('b', 'SUCCESS', '2026-08-04T10:00:00Z', 'head-b'), id: 'active-b' }]],
    ]);
    const api = () => ({
      deployments: {
        edges: [
          { node: { ...node('a', 'SUCCESS', '2026-08-04T11:00:00Z'), id: 'replacement-a' } },
          { node: node('b', 'SKIPPED', '2026-08-04T09:00:00Z', 'skip-b') },
        ],
        pageInfo: { hasNextPage: true, endCursor: 'older-events' },
      },
    });
    const result = await readDeploymentsForFleet({
      services,
      environment: 'production',
      environmentId: 'environment-1',
      projectId: 'project-1',
      window: 50,
      notBefore: HEAD_AT,
      accumulatorFactory: (args) => createFleetAccumulator({
        ...args,
        initialDeploymentsByService: active,
      }),
      readFleet: (args) => readFleetDeployments({ ...args, api }),
      readDirect: async (service) => {
        directReads.push(service.id);
        return [node(service.id, 'SUCCESS', '2026-08-04T11:30:00Z', `fresh-${service.id}`)];
      },
    });

    assert.deepEqual(directReads, ['a']);
    assert.equal(newestRunning(result.get('a').deployments).meta.commitHash, 'fresh-a');
    assert.equal(newestRunning(result.get('b').deployments).meta.commitHash, 'head-b');
  });

  it('falls back to direct reads when the fleet page is malformed', async () => {
    const directReads = [];
    const result = await readDeploymentsForFleet({
      services: [{ id: 'a' }, { id: 'b' }],
      environment: 'production',
      environmentId: 'environment-1',
      projectId: 'project-1',
      window: 50,
      accumulatorFactory: (args) => createFleetAccumulator({
        ...args,
        initialDeploymentsByService: new Map([
          ['a', [node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'head-a')]],
          ['b', [node('b', 'SUCCESS', '2026-08-04T10:00:00Z', 'head-b')]],
        ]),
      }),
      readFleet: (args) => readFleetDeployments({
        ...args,
        api: () => ({ deployments: { edges: [], pageInfo: {} } }),
      }),
      readDirect: async (service) => {
        directReads.push(service.id);
        return [node(service.id, 'SUCCESS', '2026-08-04T11:00:00Z', `fresh-${service.id}`)];
      },
    });

    assert.deepEqual(directReads.sort(), ['a', 'b']);
    assert.equal(result.get('a').error, null);
    assert.equal(result.get('b').error, null);
  });

  it('direct-reads only the service missing a Viewer active baseline', async () => {
    const directReads = [];
    const active = node('a', 'SUCCESS', '2026-08-04T10:00:00Z', 'serving-a');
    const api = () => ({
      deployments: {
        edges: [
          node('a', 'SKIPPED', '2026-08-04T11:00:00Z', 'skip-a'),
          node('b', 'SKIPPED', '2026-08-04T10:00:00Z', 'skip-b'),
        ].map((deployment) => ({ node: deployment })),
        pageInfo: { hasNextPage: true, endCursor: 'older-events' },
      },
    });
    const result = await readDeploymentsForFleet({
      services: [{ id: 'a' }, { id: 'b' }],
      environment: 'production',
      environmentId: 'environment-1',
      projectId: 'project-1',
      window: 50,
      notBefore: HEAD_AT,
      accumulatorFactory: (args) => createFleetAccumulator({
        ...args,
        initialDeploymentsByService: new Map([
          ['a', [active]],
          ['b', []],
        ]),
      }),
      readFleet: (args) => readFleetDeployments({ ...args, api }),
      readDirect: async (service) => {
        directReads.push(service.id);
        return [node(service.id, 'SUCCESS', '2026-08-04T09:00:00Z', `serving-${service.id}`)];
      },
    });

    assert.deepEqual(directReads, ['b']);
    assert.equal(newestRunning(result.get('a').deployments), active);
    assert.equal(newestRunning(result.get('b').deployments).meta.commitHash, 'serving-b');
  });

  it('scopes every direct fallback read to the explicit Railway project', async () => {
    const options = [];
    const result = await readDeploymentsForFleet({
      services: [{ id: 'a' }],
      environment: 'production',
      projectId: 'project-1',
      window: 50,
      readDirect: async (_service, _environment, _window, directOptions) => {
        options.push(directOptions);
        return [];
      },
    });

    assert.deepEqual(options, [{ projectId: 'project-1' }]);
    assert.equal(result.get('a').error, null);
  });

  it('does not start direct fallback reads after the shared run deadline', async () => {
    let elapsed = 0;
    const reads = [];
    const services = [{ id: 'a' }, { id: 'b' }];
    const result = await readDeploymentsForFleet({
      services,
      environment: 'production',
      window: 50,
      concurrency: 1,
      deadlineAt: 100,
      monotonicNow: () => elapsed,
      readDirect: async (service) => {
        reads.push(service.id);
        elapsed = 101;
        return [node(service.id, 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa')];
      },
    });

    assert.deepEqual(reads, ['a']);
    assert.equal(result.get('a').error, null);
    assert.equal(result.get('b').error, DEPLOYMENT_READ_DEADLINE_ERROR);
  });

  it('defers every read when prerequisites already consumed the budget', async () => {
    const reads = [];
    const services = [{ id: 'a' }, { id: 'b' }];
    const result = await readDeploymentsForFleet({
      services,
      environment: 'production',
      window: 50,
      concurrency: 2,
      deadlineAt: 100,
      monotonicNow: () => 100,
      readDirect: async (service) => {
        reads.push(service.id);
        return [];
      },
    });

    assert.deepEqual(reads, []);
    assert.deepEqual(
      services.map(({ id }) => result.get(id).error),
      [DEPLOYMENT_READ_DEADLINE_ERROR, DEPLOYMENT_READ_DEADLINE_ERROR],
    );
  });
});

describe('complete per-service history paging', () => {
  it('caps every API page to the shared deadline and checks it before the next page', async () => {
    const observedTimeouts = [];
    const times = [10, 50];
    let calls = 0;
    await assert.rejects(
      readAllDeployments(
        { id: 'service-1', name: 'seed-one' },
        'environment-1',
        {
          deadline: 50,
          now: () => times.shift(),
          api: async (_query, _variables, options) => {
            calls += 1;
            observedTimeouts.push(options.timeoutMs);
            return {
              deployments: {
                edges: [],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            };
          },
        },
      ),
      /deadline expired before page 2/,
    );

    assert.equal(calls, 1, 'the expired deadline must stop before another API call');
    assert.deepEqual(observedTimeouts, [40], 'the API page gets only the remaining proof budget');
  });

  it('continues by cursor until Railway proves exhaustion', async () => {
    const calls = [];
    const pages = [
      {
        edges: [{ node: { id: 'deployment-1', ...node('service-1', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa') } }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      },
      {
        edges: [{ node: { id: 'deployment-2', ...node('service-1', 'REMOVED', '2026-08-03T11:00:00Z', 'bbb') } }],
        pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
      },
    ];
    const deployments = await readAllDeployments(
      { id: 'service-1', name: 'seed-one' },
      'environment-1',
      {
        api: async (_query, variables) => {
          calls.push(variables);
          return { deployments: pages.shift() };
        },
      },
    );

    assert.equal(deployments.length, 2);
    assert.deepEqual(calls, [
      { input: { serviceId: 'service-1', environmentId: 'environment-1' }, first: 500 },
      { input: { serviceId: 'service-1', environmentId: 'environment-1' }, first: 500, after: 'cursor-1' },
    ]);
  });

  it('fails closed when a cursor repeats', async () => {
    await assert.rejects(
      readAllDeployments(
        { id: 'service-1', name: 'seed-one' },
        'environment-1',
        {
          api: async () => ({
            deployments: {
              edges: [],
              pageInfo: { hasNextPage: true, endCursor: 'stuck' },
            },
          }),
        },
      ),
      /cursor did not advance/,
    );
  });

  it('fails closed when the defensive page budget cannot prove exhaustion', async () => {
    await assert.rejects(
      readAllDeployments(
        { id: 'service-1', name: 'seed-one' },
        'environment-1',
        {
          maxPages: 1,
          api: async () => ({
            deployments: {
              edges: [],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          }),
        },
      ),
      /exceeded 1 pages/,
    );
  });

  it('fails closed on an ambiguous page or a record from another service', async () => {
    await assert.rejects(
      readAllDeployments(
        { id: 'service-1', name: 'seed-one' },
        'environment-1',
        { api: async () => ({ deployments: { edges: [], pageInfo: {} } }) },
      ),
      /incomplete deployment history page/,
    );
    await assert.rejects(
      readAllDeployments(
        { id: 'service-1', name: 'seed-one' },
        'environment-1',
        {
          api: async () => ({
            deployments: {
              edges: [{ node: { id: 'deployment-1', ...node('service-2', 'SUCCESS', '2026-08-04T11:00:00Z', 'aaa') } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }),
        },
      ),
      /malformed deployment history record/,
    );
  });
});
