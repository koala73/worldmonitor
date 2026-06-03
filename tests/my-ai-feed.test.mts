import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMyAiFeeds } from '../src/config/my-ai-feed.ts';

describe('buildMyAiFeeds — native sources (env empty)', () => {
  const feeds = buildMyAiFeeds({});

  it('returns exactly the three native sources when no env is set', () => {
    assert.equal(feeds.length, 3);
    assert.deepEqual(
      feeds.map((f) => f.name).sort(),
      ['AI Engineer', 'Google DeepMind', 'OpenAI News'],
    );
  });

  it('emits well-formed https native URLs', () => {
    for (const f of feeds) {
      assert.equal(typeof f.url, 'string');
      assert.match(f.url as string, /^https:\/\//);
    }
    const byName = Object.fromEntries(feeds.map((f) => [f.name, f.url as string]));
    assert.equal(byName['OpenAI News'], 'https://openai.com/news/rss.xml');
    assert.equal(byName['Google DeepMind'], 'https://deepmind.google/blog/rss.xml');
    assert.equal(
      byName['AI Engineer'],
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCLKPca3kwwd-B59HNr-_lvA',
    );
  });
});

describe('buildMyAiFeeds — RSSHub sources (env set)', () => {
  const feeds = buildMyAiFeeds({
    VITE_RSSHUB_BASE: 'https://rsshub.example.com/',
    VITE_AI_X_HANDLES: 'swyx, karpathy',
    VITE_AI_LINKEDIN_PAGES: 'anthropic',
  });
  const byName = Object.fromEntries(feeds.map((f) => [f.name, f.url as string]));

  it('adds the static RSSHub sources with a trailing slash trimmed from the base', () => {
    assert.equal(byName['Anthropic Engineering'], 'https://rsshub.example.com/anthropic/engineering');
    assert.equal(byName['OpenAI Research'], 'https://rsshub.example.com/openai/research');
  });

  it('adds one source per X handle and LinkedIn slug, trimming whitespace', () => {
    assert.equal(byName['X · @swyx'], 'https://rsshub.example.com/twitter/user/swyx');
    assert.equal(byName['X · @karpathy'], 'https://rsshub.example.com/twitter/user/karpathy');
    assert.equal(byName['LinkedIn · anthropic'], 'https://rsshub.example.com/linkedin/company/anthropic');
  });

  it('totals 3 native + 2 static RSSHub + 2 X + 1 LinkedIn = 8', () => {
    assert.equal(feeds.length, 8);
  });
});
