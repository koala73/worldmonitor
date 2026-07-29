// Regression test for issue #4864: seed-gdelt-intel tripped the #4786 240s
// fetch-phase deadline under a GDELT/Decodo 429 storm and exited 75 (a Railway
// "crash" email) instead of falling through to its 24h cached-snapshot merge.
//
// The bug: the hard raceFetchDeadline wraps the WHOLE fetch phase, so a slow
// retry-heavy topic ladder pushed fetchAllTopics past 240s and it was killed
// BEFORE reaching the
// cache-merge that backfills 429'd topics from the prior snapshot.
//
// The fix: an internal wall-clock soft budget that (a) bounds each single topic
// fetch and (b) stops starting new topics once the budget is spent, then always
// runs the cache-merge so the run publishes partial+cached data and exits 0.
//
// These tests would hang on the pre-fix code: `_fetchArticles` never settling
// had no bound, so fetchAllTopics never returned.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchAllTopics } from '../scripts/seed-gdelt-intel.mjs';

const TOPIC_IDS = ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime'];
const cachedSnapshot = () => ({
  topics: TOPIC_IDS.map((id) => ({
    id,
    articles: [{ title: `cached ${id}`, url: `https://example.test/${id}` }],
    fetchedAt: 'PREV',
  })),
});

describe('seed-gdelt-intel fetchAllTopics soft budget (issue #4864)', () => {
  it('fatal runSeed rejection exits nonzero so Railway/bundles see the failure', () => {
    const source = readFileSync(new URL('../scripts/seed-gdelt-intel.mjs', import.meta.url), 'utf8');
    const fatalCatch = source.match(/\.catch\(\(err\) => \{[\s\S]*?console\.error\('FATAL:'[\s\S]*?\n {2}\}\);/);

    assert.ok(fatalCatch, 'seed-gdelt-intel must keep an explicit fatal catch');
    assert.match(fatalCatch[0], /process\.exit\(1\)/);
    assert.doesNotMatch(fatalCatch[0], /process\.exit\(0\)/);
  });

  it('budget spent up front → every topic backfilled from cache, returns immediately (no deadline churn)', async () => {
    const started = Date.now();
    const out = await fetchAllTopics({
      _softBudgetMs: 40,            // spent before the first topic can start
      _sleep: async () => {},
      _fetchArticles: () => new Promise(() => {}), // would hang forever on old code
      _fetchTimeline: async () => [],
      _loadPrevious: async () => cachedSnapshot(),
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 3000, `should be bounded by the soft budget, took ${elapsed}ms`);
    assert.deepEqual(out.topics.map((t) => t.id), TOPIC_IDS, 'all 6 topics represented, in canonical order');
    for (const t of out.topics) {
      assert.equal(t.articles[0]?.title, `cached ${t.id}`, `${t.id} carries cached articles`);
    }
  });

  it('a hanging topic fetch is bounded per-topic, then backfilled from cache', async () => {
    let attempts = 0;
    const started = Date.now();
    const out = await fetchAllTopics({
      _softBudgetMs: 150,
      _minRequestBudgetMs: 20,     // allow one request to be attempted, then break
      _sleep: async () => {},
      _fetchArticles: () => { attempts++; return new Promise(() => {}); }, // never settles
      _fetchTimeline: async () => [],
      _loadPrevious: async () => cachedSnapshot(),
    });
    const elapsed = Date.now() - started;

    assert.ok(attempts >= 1, 'at least one topic fetch was attempted and bounded');
    assert.ok(elapsed < 3000, `per-topic budget bounded the hang, took ${elapsed}ms`);
    assert.deepEqual(out.topics.map((t) => t.id), TOPIC_IDS);
    for (const t of out.topics) {
      assert.equal(t.articles[0]?.title, `cached ${t.id}`, `${t.id} fell back to cache`);
    }
  });

  it('happy path: topics that succeed in time publish FRESH articles (transparent, no cache read)', async () => {
    const out = await fetchAllTopics({
      _softBudgetMs: 60_000,
      _sleep: async () => {},
      _fetchArticles: async (topic) => ({
        id: topic.id,
        articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
        fetchedAt: 'NOW',
      }),
      _fetchTimeline: async () => [{ date: '2026-07-05', value: 1 }],
      _loadPrevious: async () => { throw new Error('cache must not be consulted on the happy path'); },
    });
    assert.deepEqual(out.topics.map((t) => t.id), TOPIC_IDS);
    for (const t of out.topics) {
      assert.equal(t.articles[0].title, `fresh ${t.id}`);
      assert.ok(Array.isArray(t._tone) && Array.isArray(t._vol), 'timelines attached');
    }
  });

  it('paces every healthy DOC request instead of bursting article/tone/volume', async () => {
    const sleeps = [];
    await fetchAllTopics({
      _softBudgetMs: 60_000,
      _interRequestDelayMs: 5_500,
      _sleep: async (ms) => { sleeps.push(ms); },
      _fetchArticles: async (topic) => ({
        id: topic.id,
        articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
        fetchedAt: 'NOW',
      }),
      _fetchTimeline: async () => ({ points: [{ date: '2026-07-05', value: 1 }], errorCode: null }),
      _loadPrevious: async () => { throw new Error('cache must not be consulted'); },
    });

    assert.equal(sleeps.length, 17, '18 DOC calls have exactly 17 inter-request gaps');
    assert.equal(sleeps.every((ms) => ms === 5_500), true);
  });

  it('article transport failure opens the run circuit before timelines or later topics', async () => {
    const articleCalls = [];
    const timelineCalls = [];
    const out = await fetchAllTopics({
      _softBudgetMs: 60_000,
      _sleep: async () => {},
      _fetchArticles: async (topic) => {
        articleCalls.push(topic.id);
        return {
          id: topic.id,
          articles: [],
          fetchedAt: 'NOW',
          failureCode: 'GDELT_SHARED_PROXY_HTTP_429',
        };
      },
      _fetchTimeline: async (topic, mode) => {
        timelineCalls.push(`${topic.id}/${mode}`);
        return { points: [], errorCode: null };
      },
      _loadPrevious: async () => cachedSnapshot(),
    });
    assert.deepEqual(articleCalls, ['military']);
    assert.deepEqual(timelineCalls, [], 'a failed article route must not launch tone/vol');
    assert.equal(out._gdeltFailureCode, 'GDELT_SHARED_PROXY_HTTP_429');
    assert.equal(out._freshTopicCount, 0);
    for (const id of TOPIC_IDS) {
      assert.equal(out.topics.find((t) => t.id === id).articles[0].title, `cached ${id}`);
    }
  });

  it('first timeline transport failure is sequential and stops the remaining DOC fanout', async () => {
    const articleCalls = [];
    const timelineCalls = [];
    const out = await fetchAllTopics({
      _softBudgetMs: 60_000,
      _sleep: async () => {},
      _fetchArticles: async (topic) => {
        articleCalls.push(topic.id);
        return {
          id: topic.id,
          articles: [{ title: `fresh ${topic.id}`, url: `https://x/${topic.id}` }],
          fetchedAt: 'NOW',
        };
      },
      _fetchTimeline: async (topic, mode) => {
        timelineCalls.push(`${topic.id}/${mode}`);
        return { points: [], errorCode: 'GDELT_SHARED_PROXY_TLS' };
      },
      _loadPrevious: async () => cachedSnapshot(),
    });
    assert.deepEqual(articleCalls, ['military']);
    assert.deepEqual(timelineCalls, ['military/TimelineTone']);
    assert.equal(out._gdeltFailureCode, 'GDELT_SHARED_PROXY_TLS');
    assert.equal(out._freshTopicCount, 1);
    assert.equal(out.topics[0].articles[0].title, 'fresh military');
    assert.equal(out.topics[1].articles[0].title, 'cached cyber');
  });

  it('does not launch a timeline after the article consumes the remaining budget', async () => {
    let now = 0;
    let timelineCalls = 0;
    const out = await fetchAllTopics({
      _now: () => now,
      _softBudgetMs: 100,
      _minRequestBudgetMs: 1,
      _sleep: async () => {},
      _fetchArticles: async (topic) => {
        now = 100;
        return {
          id: topic.id,
          articles: [{ title: `fresh ${topic.id}`, url: `https://x/${topic.id}` }],
          fetchedAt: 'NOW',
        };
      },
      _fetchTimeline: async () => {
        timelineCalls += 1;
        return { points: [], errorCode: null };
      },
      _loadPrevious: async () => cachedSnapshot(),
    });

    assert.equal(timelineCalls, 0, 'an exhausted budget must not create another request');
    assert.equal(out._gdeltFailureCode, 'GDELT_FETCH_BUDGET_EXCEEDED');
    assert.equal(out._freshTopicCount, 1);
  });

  it('all-empty successful ArticleList responses remain honestly degraded after cache backfill', async () => {
    const out = await fetchAllTopics({
      _softBudgetMs: 60_000,
      _sleep: async () => {},
      _fetchArticles: async (topic) => ({
        id: topic.id,
        articles: [],
        fetchedAt: 'NOW',
      }),
      _fetchTimeline: async () => ({ points: [], errorCode: null }),
      _loadPrevious: async () => cachedSnapshot(),
    });
    assert.equal(out._gdeltFailureCode, 'GDELT_EMPTY_ARTICLE_RESULTS');
    assert.equal(out._freshTopicCount, 0);
    assert.equal(out.topics.every((topic) => topic.fetchedAt === 'PREV'), true);
  });
});
