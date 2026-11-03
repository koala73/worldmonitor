// #9093: item-level label history. A story's corroboration label is recorded on
// its track row each cycle; a move between single-publisher and corroborated is
// appended, once, to a bounded seven-day log that /trust and the API read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  LABEL_CHANGES_KEY,
  LABEL_COUNTS_KEY,
  LABEL_COUNTS_MAX_AGE_MS,
  countLabels,
  parseLabelCounts,
  LABEL_HISTORY_RETENTION_MS,
  STORY_LABEL_FIELD,
  STORY_LABEL_HISTORY_KEY,
  decodeStoryLabel,
  UNTRACKED_LABEL,
  encodeStoryLabel,
  keepUnrecordedLabels,
  labelChangeFor,
  parseLabelChange,
  recordLabelChanges,
  storyLabel,
} from '../server/_shared/label-history.ts';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { listLabelChanges } from '../server/worldmonitor/news/v1/list-label-changes.ts';
import { REDIS_PIPELINE_TIMEOUT_MS } from '../server/_shared/redis';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = Date.now();
const context = { at: NOW, title: 'Central bank holds rates', link: 'https://www.reuters.com/x', credibilityScore: 71.6 };

type Command = Array<string | number>;

/** Fake Upstash REST: records every pipeline command and answers from `reply`. */
function installFakeRedis(reply: (command: Command) => unknown = () => 'OK') {
  const commands: Command[] = [];
  const saved = {
    fetch: globalThis.fetch,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    localMode: process.env.LOCAL_API_MODE,
  };
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '[]') as Command[];
    commands.push(...body);
    return { ok: true, status: 200, json: async () => body.map((command) => ({ result: reply(command) })) };
  }) as unknown as typeof fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  delete process.env.LOCAL_API_MODE;
  const restore = () => {
    globalThis.fetch = saved.fetch;
    for (const [name, value] of [
      ['UPSTASH_REDIS_REST_URL', saved.url],
      ['UPSTASH_REDIS_REST_TOKEN', saved.token],
      ['LOCAL_API_MODE', saved.localMode],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  return { commands, restore };
}

describe('story label', () => {
  it('reads the publisher families of the items the digest kept, with the cluster count', () => {
    assert.equal(storyLabel([{ source: 'Reuters World', corroborationCount: 1 }]).state, 'single-publisher');
    const label = storyLabel([
      { source: 'Reuters World', corroborationCount: 3 },
      { source: 'BBC World', corroborationCount: 3 },
    ]);
    assert.equal(label.state, 'corroborated');
    assert.equal(label.publishers, 3, 'the server count is a floor above the families seen');
    assert.deepEqual(label.roster.map((p) => p.name).sort(), ['BBC', 'Reuters']);
  });

  it('counts a trusted originating publisher, as the digest count does', () => {
    // Reuters copy carried by two topic feeds is one publisher, not two.
    const label = storyLabel([
      { source: 'Reuters Crypto', originPublisher: 'Reuters', originPublisherTrusted: true, corroborationCount: 1 },
      { source: 'DeFi News', originPublisher: 'Reuters', originPublisherTrusted: true, corroborationCount: 1 },
    ]);
    assert.equal(label.state, 'single-publisher');
    assert.deepEqual(label.roster.map((p) => p.name), ['Reuters']);
    // An untrusted origin claim is ignored.
    assert.equal(storyLabel([
      { source: 'Reuters World', corroborationCount: 1 },
      { source: 'DeFi News', originPublisher: 'Reuters', originPublisherTrusted: false, corroborationCount: 1 },
    ]).state, 'corroborated');
  });

  it('encodes only the two tracked states, and round-trips them', () => {
    const corroborated = storyLabel([{ source: 'Reuters World', corroborationCount: 2 }, { source: 'BBC World' }]);
    assert.equal(encodeStoryLabel(corroborated), 'corroborated|2');
    assert.deepEqual(decodeStoryLabel('corroborated|2'), { state: 'corroborated', publishers: 2 });
    assert.equal(encodeStoryLabel({ state: 'unknown', publishers: null, roster: [] }), UNTRACKED_LABEL);
    assert.equal(encodeStoryLabel({ state: 'tier4-only', publishers: 2, roster: [] }), UNTRACKED_LABEL);
    assert.equal(decodeStoryLabel(UNTRACKED_LABEL), null);
    for (const bad of [undefined, '', 'corroborated', 'verified|2', 'corroborated|0', 'corroborated|x', 42]) {
      assert.equal(decodeStoryLabel(bad), null, String(bad));
    }
  });
});

describe('label change detection', () => {
  const single = storyLabel([{ source: 'Reuters World', corroborationCount: 1 }]);
  const corroborated = storyLabel([{ source: 'Reuters World', corroborationCount: 2 }, { source: 'BBC World' }]);

  it('records single-publisher → corroborated with the publishers behind it', () => {
    const change = labelChangeFor(HASH_A, 'single-publisher|1', corroborated, context)!;
    assert.equal(change.previous, 'single-publisher');
    assert.equal(change.next, 'corroborated');
    assert.equal(change.previousPublishers, 1);
    assert.equal(change.nextPublishers, 2);
    assert.equal(change.trigger, 'digest');
    assert.equal(change.credibilityScore, 72);
    assert.deepEqual(change.sources.map((s) => s.name).sort(), ['BBC', 'Reuters']);
    assert.match(change.reason, /2 publisher families/);
    assert.doesNotMatch(change.reason, /\b(true|false|verified|confirmed|fake)\b/i, 'coverage, not accuracy');
  });

  it('records corroborated → single-publisher', () => {
    const change = labelChangeFor(HASH_A, 'corroborated|3', single, context)!;
    assert.equal(change.next, 'single-publisher');
    assert.equal(change.previousPublishers, 3);
  });

  it('records nothing for a new story, an unchanged state or an untracked state', () => {
    assert.equal(labelChangeFor(HASH_A, undefined, corroborated, context), null, 'first sighting');
    assert.equal(labelChangeFor(HASH_A, 'corroborated|2', storyLabel([
      { source: 'Reuters World', corroborationCount: 4 }, { source: 'BBC World' },
    ]), context), null, 'a count change inside one state is not a label change');
    assert.equal(labelChangeFor(HASH_A, 'single-publisher|1', { state: 'tier4-only', publishers: 2, roster: [] }, context), null);
  });

  it('an untracked cycle in between resets the comparison, so no stale change is logged', () => {
    // corroborated → tier4-only (persisted as untracked) → single-publisher.
    assert.equal(labelChangeFor(HASH_A, UNTRACKED_LABEL, single, context), null);
  });
});

describe('digest wiring', () => {
  const item = (overrides: Record<string, unknown>) => ({
    source: 'Reuters World', title: 'Central bank holds rates', link: 'https://www.reuters.com/world/x-1',
    importanceScore: 10, credibilityScore: 70, corroborationCount: 1, ...overrides,
  });

  it('labels every story and diffs against the label its track row recorded', () => {
    const items = [
      item({ titleHash: HASH_A, corroborationCount: 2 }),
      item({ titleHash: HASH_A, source: 'BBC World', corroborationCount: 2, importanceScore: 20, title: 'Rates held' }),
      item({ titleHash: HASH_B }),
    ];
    const tracks = new Map([
      [HASH_A, { firstSeen: 1, lastSeen: 1, mentionCount: 1, sourceCount: 1, label: 'single-publisher|1' }],
      [HASH_B, { firstSeen: 1, lastSeen: 1, mentionCount: 1, sourceCount: 1, label: 'single-publisher|1' }],
    ]);
    const { labelByHash, labelChanges } = __testing__.storyLabelChanges(items as never, items as never, tracks, NOW);
    assert.equal(labelByHash.get(HASH_A), 'corroborated|2');
    assert.equal(labelByHash.get(HASH_B), 'single-publisher|1');
    assert.equal(labelChanges.length, 1);
    assert.equal(labelChanges[0]!.storyId, HASH_A);
    assert.equal(labelChanges[0]!.title, 'Rates held', 'the highest-importance member names the story');
  });

  it('names every publisher behind the label, including members past the category cap', () => {
    const served = item({ titleHash: HASH_A, corroborationCount: 2 });
    const pastCap = item({ titleHash: HASH_A, source: 'BBC World', corroborationCount: 2, importanceScore: 1, title: 'Rates held' });
    const notServed = item({ titleHash: HASH_B, corroborationCount: 2 });
    const tracks = new Map([[HASH_A, { firstSeen: 1, lastSeen: 1, mentionCount: 1, sourceCount: 1, label: 'single-publisher|1' }]]);
    const { labelByHash, labelChanges } = __testing__.storyLabelChanges([served] as never, [served, pastCap, notServed] as never, tracks, NOW);
    assert.equal(labelChanges.length, 1);
    assert.equal(labelChanges[0]!.nextPublishers, 2);
    assert.deepEqual(labelChanges[0]!.sources.map((source) => source.name).sort(), ['BBC', 'Reuters']);
    assert.equal(labelChanges[0]!.title, 'Central bank holds rates', 'the served item names the story');
    assert.equal(labelByHash.has(HASH_B), false, 'a story the digest does not serve gets no label');
  });

  it('persists the label on the existing HSET, adding no command', async () => {
    const run = async (labelByHash?: Map<string, string>) => {
      const redis = installFakeRedis();
      try {
        const items = [item({ titleHash: HASH_A, publishedAt: NOW, level: 'low', lang: 'en', description: '' })];
        await __testing__.writeStoryTracking(items as never, 'full', 'en', [HASH_A], undefined, Number.POSITIVE_INFINITY, undefined, labelByHash);
        return redis.commands;
      } finally {
        redis.restore();
      }
    };
    const without = await run();
    const withLabel = await run(new Map([[HASH_A, 'corroborated|2']]));
    assert.equal(withLabel.length, without.length);
    const hset = withLabel.find((command) => command[0] === 'HSET' && command.includes('title'))!;
    const at = hset.indexOf(STORY_LABEL_FIELD);
    assert.ok(at > 0, 'label written on the representative HSET');
    assert.equal(hset[at + 1], 'corroborated|2');
    assert.equal(without.some((command) => command.includes(STORY_LABEL_FIELD)), false);
  });

  it('an unread track row is unknown, not new: its label is left untouched', async () => {
    const items = [item({ titleHash: HASH_A, corroborationCount: 2 }), item({ titleHash: HASH_A, source: 'BBC World', corroborationCount: 2 })];
    const { labelByHash, labelChanges } = __testing__.storyLabelChanges(items as never, items as never, new Map(), NOW, new Set([HASH_A]));
    assert.equal(labelByHash.has(HASH_A), false);
    assert.deepEqual(labelChanges, []);

    const failing = installFakeRedis();
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      const unread = new Set<string>();
      const tracks = await __testing__.readStoryTracks([HASH_A, HASH_B], Number.POSITIVE_INFINITY, unread);
      assert.equal(tracks.size, 0);
      assert.deepEqual([...unread].sort(), [HASH_A, HASH_B]);
    } finally {
      failing.restore();
    }
  });

  it('reads the recorded label back from the track row', async () => {
    const redis = installFakeRedis((command) => (command[0] === 'HMGET' ? ['1', '2', '3', '1', 'corroborated|2'] : 'OK'));
    try {
      const tracks = await __testing__.readStoryTracks([HASH_A]);
      assert.equal(tracks.get(HASH_A)?.label, 'corroborated|2');
      const hmget = redis.commands.find((command) => command[0] === 'HMGET')!;
      assert.ok(hmget.includes(STORY_LABEL_FIELD));
    } finally {
      redis.restore();
    }
  });
});

describe('recording', () => {
  const change = labelChangeFor(HASH_A, 'single-publisher|1', storyLabel([
    { source: 'Reuters World', corroborationCount: 2 }, { source: 'BBC World' },
  ]), context)!;

  async function withDeadlineRedis(
    stages: Array<{ ms: number; fail?: boolean }>,
    run: (fixture: { now: () => number; budgets: number[]; commands: Command[] }) => Promise<void>,
  ) {
    const redis = installFakeRedis();
    const savedNow = Date.now;
    const savedTimeout = AbortSignal.timeout;
    const budgets: number[] = [];
    const commands: Command[] = [];
    let now = NOW;
    let budget = 0;
    Date.now = () => now;
    AbortSignal.timeout = (ms) => {
      budget = ms;
      return new AbortController().signal;
    };
    globalThis.fetch = async (_input, init) => {
      budgets.push(budget);
      const body = JSON.parse(String(init?.body)) as Command[];
      commands.push(...body);
      const stage = stages[budgets.length - 1];
      assert.ok(stage, 'unexpected pipeline');
      now += Math.min(stage.ms, budget);
      if (stage.ms > budget) throw new Error('fixture deadline abort');
      return { ok: !stage.fail, status: stage.fail ? 500 : 200,
        json: async () => body.map(() => ({ result: 'OK' })) } as Response;
    };
    try {
      await run({ now: () => now, budgets, commands });
    } finally {
      Date.now = savedNow;
      AbortSignal.timeout = savedTimeout;
      redis.restore();
    }
  }

  it('shares one absolute deadline across guard and append without renewing cleanup', async () => {
    await withDeadlineRedis([{ ms: 80 }, { ms: 80 }], async ({ now, budgets, commands }) => {
      assert.equal((await recordLabelChanges([change], NOW + 100)).size, 0);
      assert.deepEqual(budgets, [100, 20]);
      assert.equal(now(), NOW + 100);
      assert.equal(commands.some((command) => command[0] === 'DEL'), false);
      const labels = new Map([[HASH_A, 'corroborated|2']]);
      keepUnrecordedLabels(labels, [change], new Set());
      assert.equal(labels.has(HASH_A), false);
    });
  });

  it('recomputes cleanup after an immediate append failure and spends only the remainder', async () => {
    for (const cleanupMs of [5, 50]) {
      await withDeadlineRedis([{ ms: 80 }, { ms: 5, fail: true }, { ms: cleanupMs }], async ({ now, budgets, commands }) => {
        assert.equal((await recordLabelChanges([change], NOW + 100)).size, 0);
        assert.deepEqual(budgets, [100, 20, 15]);
        assert.equal(now(), NOW + 85 + Math.min(cleanupMs, 15));
        const guard = commands.find((command) => command[0] === 'SET')!;
        assert.deepEqual(commands.at(-1), ['DEL', guard[1]]);
      });
    }
  });

  it('does not append after the guard consumes the deadline', async () => {
    await withDeadlineRedis([{ ms: 100 }], async ({ budgets, commands }) => {
      assert.equal((await recordLabelChanges([change], NOW + 100)).size, 0);
      assert.deepEqual(budgets, [100]);
      assert.equal(commands.length, 1);
    });
  });

  it('retains confirmed IDs when an append response arrives at the deadline', async () => {
    await withDeadlineRedis([{ ms: 80 }, { ms: 20 }], async ({ budgets, commands }) => {
      const recorded = await recordLabelChanges([change], NOW + 100);
      assert.deepEqual([...recorded], [HASH_A]);
      assert.deepEqual(budgets, [100, 20]);
      assert.deepEqual(commands[0], ['SET', `trust:label-change-guard:v1:${HASH_A}:single-publisher:corroborated`, String(change.at), 'NX', 'EX', 900]);
      for (const [key, cap] of [[LABEL_CHANGES_KEY, 500], [STORY_LABEL_HISTORY_KEY(HASH_A), 20]] as const) {
        assert.deepEqual(commands.filter((command) => command[1] === key), [
          ['LPUSH', key, JSON.stringify(change)], ['LTRIM', key, 0, cap - 1], ['EXPIRE', key, 604800],
        ]);
      }
      const labels = new Map([[HASH_A, 'corroborated|2']]);
      keepUnrecordedLabels(labels, [change], recorded);
      assert.equal(labels.get(HASH_A), 'corroborated|2');
    });
  });

  it('refuses expired and invalid absolute deadlines before any history I/O', async () => {
    await withDeadlineRedis([], async ({ budgets }) => {
      for (const deadline of [0, -1, NOW - 1, NOW, Number.NaN, Number.NEGATIVE_INFINITY]) {
        assert.equal((await recordLabelChanges([change], deadline)).size, 0, String(deadline));
      }
      assert.equal((await recordLabelChanges([], NOW + 100)).size, 0);
      assert.deepEqual(budgets, []);
    });
  });

  it('keeps omitted, undefined and positive Infinity outer deadlines unbounded', async () => {
    for (const mode of ['omitted', 'undefined', 'infinity']) {
      await withDeadlineRedis([{ ms: 4000 }, { ms: 4000 }], async ({ now, budgets }) => {
        const recorded = mode === 'omitted' ? await recordLabelChanges([change])
          : await recordLabelChanges([change], mode === 'infinity' ? Number.POSITIVE_INFINITY : undefined);
        assert.deepEqual([...recorded], [HASH_A]);
        assert.equal(now(), NOW + 8000);
        assert.deepEqual(budgets, [REDIS_PIPELINE_TIMEOUT_MS, REDIS_PIPELINE_TIMEOUT_MS]);
      });
    }
  });

  it('appends to the global and per-story logs, bounded and expiring after seven days', async () => {
    const redis = installFakeRedis();
    try {
      assert.deepEqual([...await recordLabelChanges([change])], [HASH_A]);
      const guard = redis.commands.find((command) => command[0] === 'SET')!;
      assert.ok(guard.includes('NX'), 'a guard key decides who records the change');
      for (const key of [LABEL_CHANGES_KEY, STORY_LABEL_HISTORY_KEY(HASH_A)]) {
        const lpush = redis.commands.find((command) => command[0] === 'LPUSH' && command[1] === key)!;
        assert.deepEqual(JSON.parse(String(lpush[2])), change);
        assert.ok(redis.commands.some((command) => command[0] === 'LTRIM' && command[1] === key));
        const expire = redis.commands.find((command) => command[0] === 'EXPIRE' && command[1] === key)!;
        assert.equal(expire[2], LABEL_HISTORY_RETENTION_MS / 1000);
      }
    } finally {
      redis.restore();
    }
  });

  it('a racing build that loses the guard appends nothing and leaves the label to the winner', async () => {
    const redis = installFakeRedis((command) => (command[0] === 'SET' ? null : 'OK'));
    try {
      assert.equal((await recordLabelChanges([change])).size, 0, 'only a confirmed append persists the label');
      assert.equal(redis.commands.some((command) => command[0] === 'LPUSH'), false);
    } finally {
      redis.restore();
    }
  });

  it('a failed append is not recorded, and releases its guard for the retry', async () => {
    const redis = installFakeRedis();
    const realFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      call += 1;
      if (call === 2) return { ok: false, status: 500, json: async () => ({}) };
      return (realFetch as unknown as (i: unknown, x?: unknown) => Promise<unknown>)(input, init);
    }) as unknown as typeof fetch;
    try {
      assert.equal((await recordLabelChanges([change])).size, 0);
      assert.ok(redis.commands.some((command) => command[0] === 'DEL' && String(command[1]).includes(HASH_A)));
    } finally {
      redis.restore();
    }
  });

  it('a story whose change was not recorded keeps its previous label', () => {
    const labels = new Map([[HASH_A, 'corroborated|2'], [HASH_B, 'single-publisher|1']]);
    keepUnrecordedLabels(labels, [change], new Set());
    assert.deepEqual([...labels.keys()], [HASH_B], 'only the unchanged story is persisted');
    const recorded = new Map([[HASH_A, 'corroborated|2']]);
    keepUnrecordedLabels(recorded, [change], new Set([HASH_A]));
    assert.equal(recorded.get(HASH_A), 'corroborated|2');
  });
});

describe('ListLabelChanges', () => {
  const ctx = () => ({ request: new Request('https://example.test/api/news/v1/list-label-changes'), pathParams: {}, headers: {} });
  const stored = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    ...labelChangeFor(HASH_A, 'single-publisher|1', storyLabel([
      { source: 'Reuters World', corroborationCount: 2 }, { source: 'BBC World' },
    ]), context),
    ...overrides,
  });
  let redis: ReturnType<typeof installFakeRedis> | null = null;
  beforeEach(() => { redis = null; });
  afterEach(() => redis?.restore());

  it('serves recent changes newest first and drops expired or malformed rows', async () => {
    redis = installFakeRedis((command) => {
      if (command[0] === 'SMEMBERS') return [];
      return [stored(), stored({ at: NOW - LABEL_HISTORY_RETENTION_MS - 1 }), 'not json', stored({ previous: 'verified' })];
    });
    const response = await listLabelChanges(ctx(), { storyId: '', limit: 0 });
    assert.equal(response.state, 'ok');
    assert.equal(response.retentionDays, 7);
    assert.equal(response.changes.length, 1);
    const [first] = response.changes;
    assert.equal(first!.next, 'corroborated');
    assert.equal(first!.link, 'https://www.reuters.com/x');
    assert.equal(first!.credibilityScore, 72);
    const lrange = redis.commands.find((command) => command[0] === 'LRANGE')!;
    assert.deepEqual(lrange, ['LRANGE', LABEL_CHANGES_KEY, 0, 49]);
  });

  it('reads one story\'s history, and rejects a malformed story id without reading', async () => {
    redis = installFakeRedis((command) => (command[0] === 'SMEMBERS' ? [] : [stored()]));
    const one = await listLabelChanges(ctx(), { storyId: HASH_A.toUpperCase(), limit: 500 });
    assert.equal(one.changes.length, 1);
    assert.deepEqual(redis.commands.find((command) => command[0] === 'LRANGE'), ['LRANGE', STORY_LABEL_HISTORY_KEY(HASH_A), 0, 199]);
    const before = redis.commands.length;
    const bad = await listLabelChanges(ctx(), { storyId: 'not-a-hash', limit: 0 });
    assert.deepEqual(bad.changes, []);
    assert.equal(redis.commands.length, before);
  });

  it('blanks a link revoked after the change was recorded, keeping the change', async () => {
    redis = installFakeRedis((command) => (command[0] === 'SMEMBERS' ? ['https://www.reuters.com/x'] : [stored()]));
    const response = await listLabelChanges(ctx(), { storyId: '', limit: 0 });
    assert.equal(response.changes.length, 1);
    assert.equal(response.changes[0]!.link, '');
  });

  it('an unreadable log is unavailable, never an empty history', async () => {
    redis = installFakeRedis();
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const response = await listLabelChanges(ctx(), { storyId: '', limit: 0 });
    assert.equal(response.state, 'unavailable');
    assert.deepEqual(response.changes, []);
  });

  it('parseLabelChange keeps a report-triggered entry and normalises tiers', () => {
    const entry = parseLabelChange(stored({ trigger: 'report', sources: [{ name: 'X', tier: 9 }, { name: '' }] }), NOW)!;
    assert.equal(entry.trigger, 'report');
    assert.deepEqual(entry.sources, [{ name: 'X', tier: null }]);
  });
});

describe('scanner bundle exclusion (#9093)', () => {
  it('leaves listed operations out of the scanner JSON, keeping them in the YAML specs', async () => {
    const { SCANNER_BUNDLE_EXCLUDED_OPERATIONS, excludeScannerBundleOperations } = await import('../scripts/build-openapi-json.mjs');
    const { readFileSync } = await import('node:fs');
    const yaml = readFileSync(new URL('../docs/api/worldmonitor.openapi.yaml', import.meta.url), 'utf8');
    assert.ok('/api/news/v1/list-label-changes' in SCANNER_BUNDLE_EXCLUDED_OPERATIONS);
    for (const [path, reason] of Object.entries(SCANNER_BUNDLE_EXCLUDED_OPERATIONS)) {
      assert.ok(String(reason).length > 20, `${path} names why it is excluded`);
      assert.ok(yaml.includes(`${path}:`), `${path} stays documented in the YAML bundle`);
    }
    const spec = { paths: { '/api/news/v1/list-label-changes': { get: {} }, '/api/news/v1/list-feed-digest': { get: {} } } };
    assert.deepEqual(excludeScannerBundleOperations(spec), { excluded: 1 });
    assert.deepEqual(Object.keys(spec.paths), ['/api/news/v1/list-feed-digest']);
  });
});

describe("today's label counts (#9093 /trust)", () => {
  it('counts every state, and serves only recent, consistent counts', () => {
    const counts = countLabels(['corroborated', 'corroborated', 'single-publisher', 'tier4-only', 'unknown'], NOW);
    assert.deepEqual(counts, { at: NOW, stories: 5, corroborated: 2, singlePublisher: 1, tier4Only: 1, unknown: 1 });
    assert.deepEqual(parseLabelCounts(JSON.stringify(counts), NOW), counts);
    assert.equal(parseLabelCounts(JSON.stringify({ ...counts, at: NOW - LABEL_COUNTS_MAX_AGE_MS - 1 }), NOW), null, 'stale');
    assert.equal(parseLabelCounts(JSON.stringify({ ...counts, stories: 9 }), NOW), null, 'parts must add up');
    assert.equal(parseLabelCounts('nope', NOW), null);
    assert.equal(parseLabelCounts(null, NOW), null);
  });

  it('the digest counts the labels of every story it kept', () => {
    const items = [
      { source: 'Reuters World', title: 'A', link: 'https://www.reuters.com/a', importanceScore: 1, credibilityScore: 70, corroborationCount: 2, titleHash: HASH_A },
      { source: 'BBC World', title: 'A', link: 'https://www.bbc.co.uk/a', importanceScore: 1, credibilityScore: 70, corroborationCount: 2, titleHash: HASH_A },
      { source: 'Reuters World', title: 'B', link: 'https://www.reuters.com/b', importanceScore: 1, credibilityScore: 70, corroborationCount: 1, titleHash: HASH_B },
    ];
    const { labelCounts } = __testing__.storyLabelChanges(items as never, items as never, new Map(), NOW);
    assert.deepEqual(labelCounts, { at: NOW, stories: 2, corroborated: 1, singlePublisher: 1, tier4Only: 0, unknown: 0 });
  });

  it('the OpenAPI example shows counts whose parts add up', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/NewsService.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/news/v1/list-label-changes'].get.responses['200'].content['application/json'].example;
    assert.equal(example.state, 'ok');
    const { at, ...counts } = example.counts;
    assert.deepEqual(parseLabelCounts(JSON.stringify(example.counts), at), { at, ...counts });
    assert.equal(example.changes[0].field, 'corroboration');
  });

  it('ListLabelChanges serves the counts beside the changes', async () => {
    const counts = countLabels(['corroborated', 'single-publisher'], NOW);
    const redis = installFakeRedis((command) => {
      if (command[0] === 'GET' && command[1] === LABEL_COUNTS_KEY) return JSON.stringify(counts);
      if (command[0] === 'SMEMBERS') return [];
      return [];
    });
    try {
      const response = await listLabelChanges(
        { request: new Request('https://example.test/api/news/v1/list-label-changes'), pathParams: {}, headers: {} },
        { storyId: '', limit: 0 },
      );
      assert.equal(response.state, 'ok');
      assert.deepEqual(response.counts, counts);
    } finally {
      redis.restore();
    }
  });
});
