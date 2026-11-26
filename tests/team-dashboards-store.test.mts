import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TeamDashboardsStore, publishOrShareAsNew } from '../src/services/team-dashboards-store.ts';
import type { TeamDashboards } from '../src/services/team-dashboards.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function team(...names: string[]): TeamDashboards {
  return {
    team: { kind: 'business' },
    dashboards: names.map((name, i) => ({ id: `d${i}`, name, version: 1, updatedAt: 0, layout: { panels: [{ key: 'a', on: true }] } })),
  };
}

/** A store whose loads the test settles by hand, in any order. */
function harness() {
  const loads: Array<{ userId: string; settle: ReturnType<typeof deferred<TeamDashboards | null>> }> = [];
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  let changes = 0;
  const store = new TeamDashboardsStore({
    load: (userId) => {
      const settle = deferred<TeamDashboards | null>();
      loads.push({ userId, settle });
      return settle.promise;
    },
    onChange: () => { changes += 1; },
    schedule: (run, ms) => {
      const timer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  const pending = () => timers.filter((t) => !t.cancelled);
  return { store, loads, timers, pending, changes: () => changes };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('TeamDashboardsStore', () => {
  it('loads for the signed-in user and shares one load between callers', async () => {
    const { store, loads } = harness();
    store.setPrincipal('alice');
    const again = store.reload();

    assert.equal(loads.length, 1);
    loads[0]!.settle.resolve(team('Gulf watch'));
    await again;
    assert.deepEqual(store.dashboards?.dashboards.map((d) => d.name), ['Gulf watch']);
  });

  it("starts a new load for the next user instead of reusing the previous user's", async () => {
    const { store, loads } = harness();
    store.setPrincipal('alice');
    store.setPrincipal(null);
    store.setPrincipal('bob');

    assert.deepEqual(loads.map((l) => l.userId), ['alice', 'bob']);
    loads[0]!.settle.resolve(team('Alice team'));
    loads[1]!.settle.resolve(team('Bob team'));
    await flush();
    assert.deepEqual(store.dashboards?.dashboards.map((d) => d.name), ['Bob team']);
  });

  it('retries a failed load on the next pass for the same user', async () => {
    const { store, loads } = harness();
    store.setPrincipal('alice');
    loads[0]!.settle.reject(new Error('Authentication unavailable'));
    await flush();
    assert.equal(store.dashboards, null);

    store.setPrincipal('alice');
    assert.equal(loads.length, 2);
    loads[1]!.settle.resolve(team('Gulf watch'));
    await flush();
    assert.equal(store.dashboards?.dashboards.length, 1);

    // A user already loaded with a team is not asked again on every pass.
    store.setPrincipal('alice');
    assert.equal(loads.length, 2);
  });

  it('asks again on the next access pass for a user who had no team, since they may have just joined one', async () => {
    const { store, loads } = harness();
    store.setPrincipal('alice');
    loads[0]!.settle.resolve(null);
    await flush();
    assert.equal(store.dashboards, null);

    store.setPrincipal('alice');
    assert.equal(loads.length, 2);
    loads[1]!.settle.resolve(team('Gulf watch'));
    await flush();
    assert.equal(store.dashboards?.dashboards.length, 1);
  });

  it('retries a failed load on its own a few times, then waits for the next pass', async () => {
    const { store, loads, pending } = harness();
    store.setPrincipal('alice');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      loads.at(-1)!.settle.reject(new Error('offline'));
      await flush();
      const timer = pending()[0];
      if (attempt === 3) {
        assert.equal(timer, undefined, 'retries stop after three');
        break;
      }
      assert.ok(timer, `retry ${attempt + 1} scheduled`);
      assert.ok(timer.ms >= 10_000);
      timer.cancelled = true;
      timer.run();
      assert.equal(loads.length, attempt + 2);
    }

    // A later pass still gets a fresh try, with a fresh retry budget.
    store.setPrincipal('alice');
    assert.equal(loads.length, 5);
    loads[4]!.settle.resolve(team('Gulf watch'));
    await flush();
    assert.equal(store.dashboards?.dashboards.length, 1);
    assert.equal(pending().length, 0);
  });

  it('cancels a scheduled retry when the user signs out', async () => {
    const { store, loads, pending } = harness();
    store.setPrincipal('alice');
    loads[0]!.settle.reject(new Error('offline'));
    await flush();
    assert.equal(pending().length, 1);

    store.setPrincipal(null);
    assert.equal(pending().length, 0);
  });

  it('a fresh load after a write wins over a load that started before it', async () => {
    const { store, loads } = harness();
    store.setPrincipal('alice');
    const fresh = store.reload({ fresh: true });

    assert.equal(loads.length, 2);
    loads[1]!.settle.resolve(team('Gulf watch'));
    await fresh;
    // The older query finishes last, without the dashboard just published.
    loads[0]!.settle.resolve(team());
    await flush();
    assert.deepEqual(store.dashboards?.dashboards.map((d) => d.name), ['Gulf watch']);
  });

  it('drops results that arrive after sign-out', async () => {
    const { store, loads, changes } = harness();
    store.setPrincipal('alice');
    store.setPrincipal(null);
    const before = changes();
    loads[0]!.settle.resolve(team('Gulf watch'));
    await flush();
    assert.equal(store.dashboards, null);
    assert.equal(changes(), before);
  });
});

describe('publishOrShareAsNew', () => {
  const layout = { panels: [{ key: 'a', on: true }] };

  it('shares as a new dashboard when a teammate already removed the linked one', async () => {
    const calls: Array<string | undefined> = [];
    const link = await publishOrShareAsNew(async (args) => {
      calls.push(args.dashboardId);
      if (args.dashboardId) throw new Error('Uncaught ConvexError: {"kind":"DASHBOARD_NOT_FOUND"}');
      return { id: 'd9', version: 1 };
    }, { name: 'Gulf watch', layout, dashboardId: 'd1' });

    assert.deepEqual(calls, ['d1', undefined]);
    assert.deepEqual(link, { id: 'd9', version: 1 });
  });

  it('passes other failures through without a retry', async () => {
    let calls = 0;
    await assert.rejects(publishOrShareAsNew(async () => {
      calls += 1;
      throw new Error('Uncaught ConvexError: {"kind":"TEAM_DASHBOARD_LIMIT"}');
    }, { name: 'Gulf watch', layout, dashboardId: 'd1' }), /TEAM_DASHBOARD_LIMIT/);
    assert.equal(calls, 1);
  });
});
