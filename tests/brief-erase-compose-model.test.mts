// Property, bounds and how to read a failure: .agents/skills/verify-brief-erasure/SKILL.md.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createModelRedis, exploreInterleavings, upstashFetch } from './helpers/interleavings.mjs';

process.env.UPSTASH_REDIS_REST_URL = 'https://model.redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 'model-token';

const { BRIEF_REDIS_TIMEOUT_MS, storeBrief } = await import('../scripts/lib/brief-l10n.mjs');
const { redisPipeline } = await import('../api/_upstash-json.js');
const { MAX_EXTERNAL_ATTEMPTS, deleteAccountRedisKeys, scanAccountBriefPage, deleteAccountBriefPage } =
  await import('../convex/accountDeletion/sideEffects.ts');
const { BRIEF_SWEEP_DELAY_MS } = await import('../convex/accountDeletion/registry.ts');

const USER = 'user_erased';
const OLD_SLOT = '2026-11-20-0800';
const NEW_SLOT = '2026-11-21-0800';

type Outcomes = Record<string, { ok: boolean; error?: unknown }>;

function setup(run: Parameters<typeof upstashFetch>[0]) {
  const redis = createModelRedis({
    [`brief:${USER}:${OLD_SLOT}`]: '{"v":4}',
    [`brief:l10n:${USER}:${OLD_SLOT}`]: '{"v":5}',
    [`brief:slots:${USER}`]: { [OLD_SLOT]: 1 },
    [`brief:latest:${USER}`]: JSON.stringify({ issueSlot: OLD_SLOT }),
  });
  const serve = upstashFetch(run, redis, { isShared: (key: string) => key.startsWith('brief:') });
  globalThis.fetch = serve as typeof fetch;
  return { redis, requests: serve.requests as Record<string, number> };
}

type World = ReturnType<typeof setup>;

async function withAttempts<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_EXTERNAL_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

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

const erase = {
  name: 'erase',
  start: () => withAttempts(() =>
    deleteAccountRedisKeys({ userId: USER, keyHashes: [], embedKeyHashes: [], mcpTokenIds: [] })),
};

const sweep = {
  name: 'sweep',
  after: ['erase', 'compose'],
  start: () => withAttempts(async () => {
    let cursor = '0';
    do {
      const page = await scanAccountBriefPage(USER, cursor);
      await deleteAccountBriefPage(USER, page);
      cursor = page.cursor;
    } while (cursor !== '0');
  }),
};

let mostComposeRequests = 0;

function noBriefSurvives(world: World, outcomes: Outcomes) {
  mostComposeRequests = Math.max(mostComposeRequests, world.requests.compose ?? 0);
  if (!outcomes.erase.ok) return `erase failed: ${String(outcomes.erase.error)}`;
  const left = [...world.redis.data.keys()].filter((key) =>
    key.startsWith('brief:') && key.includes(USER) && !key.startsWith('brief:erased:'));
  return left.length > 0 ? `brief keys survive the erase: ${left.join(', ')}` : null;
}


function report(result: Awaited<ReturnType<typeof exploreInterleavings>>) {
  if (!result.violation) return '';
  return `${result.violation.message}\nafter ${result.runs} runs, in this order:\n  ${result.violation.trace.join('\n  ')}`;
}

const originalFetch = globalThis.fetch;

describe('account erasure against a concurrent brief compose', () => {
  after(() => { globalThis.fetch = originalFetch; });

  it('with no Redis failures, the erase and the compose leave no brief behind, in every order', async () => {
    const result = await exploreInterleavings({ setup, actors: [compose, erase], check: noBriefSurvives });
    assert.equal(result.violation, null, report(result));
  });

  it('with one failed or lost Redis request anywhere, the erase and the compose leave no brief behind', async () => {
    const result = await exploreInterleavings({ setup, actors: [compose, erase], check: noBriefSurvives, maxFaults: 1 });
    assert.equal(result.violation, null, report(result));
  });

  it('with two failed or lost compose requests, the delayed sweep removes what the compose left', async () => {
    const result = await exploreInterleavings({ setup, actors: [compose, erase, sweep], check: noBriefSurvives, maxFaults: 2, faultsIn: ['compose'] });
    assert.equal(result.violation, null, report(result));
  });

  it('the sweep starts only after a compose racing the erase has made its last request', () => {
    assert.ok(mostComposeRequests > 0);
    assert.ok(BRIEF_SWEEP_DELAY_MS > mostComposeRequests * BRIEF_REDIS_TIMEOUT_MS,
      `the model runs the sweep after the compose, so BRIEF_SWEEP_DELAY_MS (${BRIEF_SWEEP_DELAY_MS}) must exceed ${mostComposeRequests} compose requests x BRIEF_REDIS_TIMEOUT_MS (${BRIEF_REDIS_TIMEOUT_MS})`);
  });
});
