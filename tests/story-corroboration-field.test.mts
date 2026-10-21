// #9213: every digest variant persists the corroboration verdict it served on
// the story's track row, so the digest cron renders the same verdict the
// dashboard showed instead of recomputing it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { assessCorroboration, evidenceFromCluster } from '../server/_shared/corroboration';
import { STORY_CORROBORATION_FIELD, storyLabel } from '../server/_shared/label-history.ts';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const require = createRequire(import.meta.url);
const { parseCorroboration } = require('../scripts/lib/corroboration-text.cjs');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const NOW = Date.now();

type Command = Array<string | number>;

function installFakeRedis() {
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
    return { ok: true, status: 200, json: async () => body.map(() => ({ result: 'OK' })) };
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

const item = (overrides: Record<string, unknown>) => ({
  source: 'Reuters World', title: 'Central bank holds rates', link: 'https://www.reuters.com/world/x-1',
  importanceScore: 10, credibilityScore: 70, corroborationCount: 1, publishedAt: NOW, level: 'low',
  lang: 'en', description: '', ...overrides,
});

describe('storyCorroborationByHash', () => {
  it('encodes the verdict storyLabel gives each served story, over its whole servable cluster', () => {
    const served = [
      item({ titleHash: HASH_A, corroborationCount: 3 }),
      item({ titleHash: HASH_B }),
    ];
    const pastCap = item({ titleHash: HASH_B, source: 'BBC World', corroborationCount: 2 });
    const notServed = item({ titleHash: HASH_C, corroborationCount: 4 });
    const servable = [...served, pastCap, notServed];
    const byHash = __testing__.storyCorroborationByHash(served as never, servable as never);

    assert.equal(byHash.get(HASH_A), 'corroborated|3');
    assert.equal(byHash.get(HASH_B), 'corroborated|2', 'a member past the category cap still counts');
    assert.equal(byHash.has(HASH_C), false, 'a story the variant does not serve gets no value');

    for (const [hash, encoded] of byHash) {
      const label = storyLabel(servable.filter((candidate) => candidate.titleHash === hash) as never);
      assert.deepEqual(parseCorroboration(encoded), { state: label.state, publishers: label.publishers });
    }
  });

  it('counts a reprint once, as the News panel does (#9095 same-copy check)', () => {
    const lead = 'Dockworkers at the port walked out on Monday after talks over pay and automation '
      + 'collapsed, halting container traffic at the largest terminal in the region for a second day.';
    const served = [
      item({ titleHash: HASH_A, source: 'Reuters World', title: 'Port strike halts container traffic', description: lead }),
      item({ titleHash: HASH_A, source: 'Harbour Gazette', title: 'Port strike halts container traffic', description: lead, link: 'https://harbour.example/x' }),
    ];
    const panel = assessCorroboration(evidenceFromCluster({
      allItems: served.map((s) => ({ source: s.source, title: s.title, snippet: s.description, corroborationCount: s.corroborationCount })),
    }));
    assert.deepEqual(panel, { state: 'single-publisher', publishers: 1 });
    assert.equal(__testing__.storyCorroborationByHash(served as never, served as never).get(HASH_A), 'single-publisher|1');
  });

  it('keeps tier4-only, which the change log stores as untracked', () => {
    const served = [
      item({ titleHash: HASH_A, source: 'Hacker News', link: 'https://news.ycombinator.com/x' }),
      item({ titleHash: HASH_A, source: 'The Verge', link: 'https://www.theverge.com/x' }),
    ];
    assert.equal(__testing__.storyCorroborationByHash(served as never, served as never).get(HASH_A), 'tier4-only|2');
  });
});

describe('writeStoryTracking', () => {
  const run = async (variant: string, corroborationByHash?: Map<string, string>) => {
    const redis = installFakeRedis();
    try {
      await __testing__.writeStoryTracking(
        [item({ titleHash: HASH_A })] as never, variant, 'en', [HASH_A], undefined,
        Number.POSITIVE_INFINITY, undefined, undefined, corroborationByHash,
      );
      return redis.commands;
    } finally {
      redis.restore();
    }
  };

  it('writes the variant-scoped field on the existing HSET, adding no command', async () => {
    const without = await run('tech');
    const withField = await run('tech', new Map([[HASH_A, 'single-publisher|1']]));
    assert.equal(withField.length, without.length);
    const hset = withField.find((command) => command[0] === 'HSET' && command.includes('title'))!;
    const at = hset.indexOf(STORY_CORROBORATION_FIELD('tech', 'en'));
    assert.ok(at > 0, 'field written on the representative HSET');
    assert.equal(hset[at + 1], 'single-publisher|1');
    assert.equal(withField.some((command) => command.includes(STORY_CORROBORATION_FIELD('full', 'en'))), false);
    assert.equal(without.some((command) => command.some((part) => String(part).startsWith('corroboration:'))), false);
  });
});
