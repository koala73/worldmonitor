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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const feedsSrc = readFileSync(resolve(ROOT, 'src/config/feeds.ts'), 'utf-8');

describe('feeds.ts registration', () => {
  it('imports the My AI Feed builder', () => {
    assert.match(feedsSrc, /import \{ buildMyAiFeeds \} from '\.\/my-ai-feed';/);
  });

  it('registers my-ai-feed as a CANONICAL-only category with rss-wrapped urls', () => {
    assert.match(
      feedsSrc,
      /'my-ai-feed':\s*buildMyAiFeeds\(\)\.map\(\(f\) => \(\{ \.\.\.f, url: rss\(f\.url as string\) \}\)\)/,
    );
  });

  it('does NOT add my-ai-feed to any variant FEEDS preset', () => {
    const occurrences = feedsSrc.match(/'my-ai-feed':/g) ?? [];
    assert.equal(occurrences.length, 1, 'my-ai-feed should appear exactly once (CANONICAL map only)');
  });

  it('tags the static My AI Feed sources in SOURCE_TYPES', () => {
    for (const name of ['OpenAI News', 'Google DeepMind', 'AI Engineer', 'Anthropic Engineering', 'OpenAI Research']) {
      assert.match(feedsSrc, new RegExp(`'${name}':\\s*'tech'`), `${name} should be a tech SOURCE_TYPE`);
    }
  });

  it('does NOT add my-ai-feed to DEFAULT_ENABLED_SOURCES (CANONICAL sources are enabled by default)', () => {
    assert.doesNotMatch(feedsSrc, /DEFAULT_ENABLED_SOURCES[\s\S]*'my-ai-feed':/);
  });
});
