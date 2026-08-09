// #6142 — reading every service's deployment history in a handful of calls.
//
// The fleet stream replaced 77 per-service round trips (~7 minutes) with ~6
// pages (~16s). The risk it introduces is a NEW way to be wrong about a
// service: paging stops early and the caller reads the gap as "this service has
// no deployments". That is the same fail-open shape as every other bug this
// file's siblings have had, so the stopping rule and the unresolved set are
// what these tests are for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createRailwayCliEnv,
  readDeployments,
  readFleetDeployments,
  runRailway,
} from '../scripts/railway-cli.mjs';
import { createFleetAccumulator } from '../scripts/railway-deployments.mjs';

const HEAD_AT = Date.parse('2026-08-04T12:00:00.000Z');

describe('Railway CLI child capability boundary', () => {
  const sourceEnv = {
    PATH: '/runner/bin',
    HOME: '/runner/home',
    RAILWAY_TOKEN: 'railway-token',
    RAILWAY_PROJECT_ID: 'project-1',
    RAILWAY_RECONCILE_MUTATION_HMAC: 'mutation-secret',
    RAILWAY_RECONCILE_OPERATOR_HMAC: 'operator-secret',
    GH_TOKEN: 'github-secret',
  };

  it('passes Railway credentials but strips control-plane and GitHub credentials', () => {
    assert.deepEqual(createRailwayCliEnv(sourceEnv), {
      HOME: '/runner/home',
      PATH: '/runner/bin',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_TOKEN: 'railway-token',
    });
  });

  it('applies the allowlist to sync and async Railway children', async () => {
    const childEnvironments = [];
    runRailway(['--version'], { env: sourceEnv }, (_command, _args, options) => {
      childEnvironments.push(options.env);
      return { status: 0, signal: null, error: null, stdout: 'railway 4' };
    });
    await readDeployments({ id: 'svc-1' }, 'production', 1, {
      env: sourceEnv,
      execFileImpl: async (_command, _args, options) => {
        childEnvironments.push(options.env);
        return { stdout: '[]' };
      },
    });
    assert.deepEqual(childEnvironments, [
      createRailwayCliEnv(sourceEnv),
      createRailwayCliEnv(sourceEnv),
    ]);
  });
});

function node(serviceId, status, at, commitHash) {
  return { serviceId, status, createdAt: at, meta: commitHash ? { commitHash } : {} };
}

describe('fleet accumulator', () => {
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

  it('is not done until every service has shown a RUNNING record', () => {
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

  it('a SKIPPED-only service is NOT counted as located', () => {
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
      return { deployments: page };
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

  it('keeps paging while a service is still missing', async () => {
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
  });
});
