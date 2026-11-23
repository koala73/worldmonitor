// Property, bounds and how to read a failure: .agents/skills/verify-brief-erasure/SKILL.md.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';

import { createModelRedis, exploreInterleavings, upstashFetch } from './helpers/interleavings.mjs';

process.env.UPSTASH_REDIS_REST_URL = 'https://model.redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 'model-token';

const { BRIEF_REDIS_TIMEOUT_MS, storeBrief } = await import('../scripts/lib/brief-l10n.mjs');
const { redisPipeline } = await import('../api/_upstash-json.js');
const { MAX_EXTERNAL_ATTEMPTS, deleteAccountRedisKeys, sweepBriefEnvelopes } =
  await import('../convex/accountDeletion/sideEffects.ts');
const { markExternalComplete } = await import('../convex/accountDeletion/erase.ts');

const USER = 'user_erased';
const DELETION_ID = 'deletion_1';
const OLD_SLOT = '2026-11-20-0800';
const NEW_SLOT = '2026-11-21-0800';
const SWEEP = 'accountDeletion/sideEffects:sweepBriefEnvelopes';

type Run = Parameters<typeof upstashFetch>[0];
type Job = { delayMs: number; name: string; args: Record<string, unknown> };
type Outcomes = Record<string, { ok: boolean; error?: unknown }>;

function setup(run: Run) {
  // One key per SCAN call, and a key before the brief keys, so the sweep must
  // follow its cursor past an empty page.
  const redis = createModelRedis({
    'a:unrelated': '1',
    [`brief:${USER}:${OLD_SLOT}`]: '{"v":4}',
    [`brief:l10n:${USER}:${OLD_SLOT}`]: '{"v":5}',
    [`brief:slots:${USER}`]: { [OLD_SLOT]: 1 },
    [`brief:latest:${USER}`]: JSON.stringify({ issueSlot: OLD_SLOT }),
  }, { scanCount: 1 });
  const serve = upstashFetch(run, redis, { isShared: (key: string) => key.startsWith('brief:') });
  globalThis.fetch = serve as typeof fetch;
  const scheduled: Job[] = [];
  const scheduler = {
    runAfter: async (delayMs: number, ref: unknown, args: Record<string, unknown>) => {
      scheduled.push({ delayMs, name: getFunctionName(ref as never), args });
    },
  };
  return { run, redis, requests: serve.requests as Record<string, number>, scheduled, scheduler, sweepDelayMs: null as number | null };
}

type World = ReturnType<typeof setup>;

const compose = {
  name: 'compose',
  start: () => storeBrief({
    userId: USER,
    issueSlot: NEW_SLOT,
    envelope: { v: 4 },
    latestPointer: JSON.stringify({ issueSlot: NEW_SLOT }),
    localized: { v: 5 },
    clearStaleLocalized: true,
    ttlSeconds: 7 * 24 * 3600,
    indexedAtMs: 2,
  }, (commands: unknown[]) => redisPipeline(commands, BRIEF_REDIS_TIMEOUT_MS, true)),
};

// The erase makes up to MAX_EXTERNAL_ATTEMPTS Redis attempts, as runExternalErase
// does, then completes the deletion, which schedules the sweep. The Clerk step
// and the back-off between attempts touch no brief key.
const erase = {
  name: 'erase',
  start: async (world: World) => {
    let last: unknown;
    for (let attempt = 0; attempt < MAX_EXTERNAL_ATTEMPTS; attempt += 1) {
      try {
        await deleteAccountRedisKeys({ userId: USER, keyHashes: [], embedKeyHashes: [], mcpTokenIds: [] });
        last = null;
        break;
      } catch (err) {
        last = err;
      }
    }
    if (last) throw last;
    const row = { _id: DELETION_ID, status: 'pending', userIdHash: 'hash', dodoSubscriptionIds: [] };
    await (markExternalComplete as any)._handler(
      { db: { get: async () => row, patch: async () => {} }, scheduler: world.scheduler },
      { deletionId: DELETION_ID });
    world.sweepDelayMs = world.scheduled.find((job) => job.name === SWEEP)?.delayMs ?? null;
  },
};

const sweep = {
  name: 'sweep',
  after: ['erase', 'compose'],
  start: async (world: World) => {
    const ctx = { runQuery: async () => ({ userId: USER }), scheduler: world.scheduler };
    for (let job = world.scheduled.shift(); job; job = world.scheduled.shift()) {
      if (job.name !== SWEEP) throw new Error(`the model does not run ${job.name}`);
      await (sweepBriefEnvelopes as any)._handler(ctx, job.args);
    }
  },
};

function briefKeysLeft(world: World) {
  return [...world.redis.data.keys()].filter((key) =>
    key.startsWith('brief:') && key.includes(USER) && !key.startsWith('brief:erased:'));
}

function noBriefSurvives(world: World, outcomes: Outcomes) {
  if (!outcomes.erase.ok) return `erase failed: ${String(outcomes.erase.error)}`;
  const composeError = outcomes.compose.ok ? null : String((outcomes.compose.error as Error)?.message ?? outcomes.compose.error);
  if (composeError && world.run.faults === 0 && !composeError.includes('account erased during compose')) {
    return `compose failed with no Redis failure: ${composeError}`;
  }
  const left = briefKeysLeft(world);
  return left.length > 0 ? `brief keys survive the erase: ${left.join(', ')}` : null;
}

// The model runs the sweep after the compose, which holds only while the
// sweep delay outlasts every request the compose can make.
function sweepAfterCompose(world: World, outcomes: Outcomes) {
  const composeMs = (world.requests.compose ?? 0) * BRIEF_REDIS_TIMEOUT_MS;
  if (world.sweepDelayMs === null) return 'completing the deletion scheduled no brief sweep';
  if (world.sweepDelayMs <= composeMs) {
    return `the sweep starts after ${world.sweepDelayMs} ms, but this compose can run for ${composeMs} ms`;
  }
  return noBriefSurvives(world, outcomes);
}

function report(result: Awaited<ReturnType<typeof exploreInterleavings>>) {
  if (!result.violation) return '';
  return `${result.violation.message}\nafter ${result.runs} runs, in this order:\n  ${result.violation.trace.join('\n  ')}`;
}

const originalFetch = globalThis.fetch;

describe('account erasure against a concurrent brief compose', () => {
  after(() => { globalThis.fetch = originalFetch; });

  it('control: a compose with no erase stores the new brief', async () => {
    const result = await exploreInterleavings({
      setup,
      actors: [compose],
      check: (world: World, outcomes: Outcomes) => {
        if (!outcomes.compose.ok) return `compose failed: ${String(outcomes.compose.error)}`;
        const { data } = world.redis;
        const missing = [`brief:${USER}:${NEW_SLOT}`, `brief:l10n:${USER}:${NEW_SLOT}`].filter((key) => !data.has(key));
        if (missing.length > 0) return `compose did not store ${missing.join(', ')}`;
        if (!(data.get(`brief:slots:${USER}`) as Map<string, number>)?.has(NEW_SLOT)) return 'compose did not index its slot';
        return data.get(`brief:latest:${USER}`) === JSON.stringify({ issueSlot: NEW_SLOT }) ? null : 'compose did not move the latest pointer';
      },
    });
    assert.equal(result.violation, null, report(result));
  });

  it('with no Redis failures, the erase and the compose leave no brief behind, in every order', async () => {
    const result = await exploreInterleavings({ setup, actors: [compose, erase], check: noBriefSurvives });
    assert.equal(result.violation, null, report(result));
  });

  it('with one failed or lost Redis request anywhere, the erase and the compose leave no brief behind', async () => {
    const result = await exploreInterleavings({ setup, actors: [compose, erase], check: noBriefSurvives, maxFaults: 1 });
    assert.equal(result.violation, null, report(result));
  });

  it('with two failed or lost compose requests, the scheduled sweep removes what the compose left', async () => {
    const result = await exploreInterleavings({ setup, actors: [compose, erase, sweep], check: sweepAfterCompose, maxFaults: 2, faultsIn: ['compose'] });
    assert.equal(result.violation, null, report(result));
  });
});
