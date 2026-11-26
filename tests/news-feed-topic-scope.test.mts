// Google News site: feeds must fetch only the publisher and section their name
// promises (#11265): a bare site: search let markets into Reuters Science,
// sports into AP News, and Euromaidan Press under the Ukrainska Pravda label.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { BROWSER_NEWS_CATALOG } from '../src/config/news-catalog.browser.generated';

const SCOPED: ReadonlyArray<{ category: string; name: string; scope: RegExp }> = [
  { category: 'science', name: 'Reuters Science', scope: /^site:reuters\.com\/science\b/ },
  { category: 'europe', name: 'Ukrainska Pravda EN', scope: /^site:pravda\.com\.ua\/eng\b/ },
  { category: 'politics', name: 'AP News', scope: /^site:apnews\.com "World News"/ },
];

const query = (url: string) => new URL(url).searchParams.get('q') ?? '';
const urlOf = (feed: { url: string | Record<string, string> } | undefined) =>
  typeof feed?.url === 'string' ? feed.url : feed?.url.en ?? '';

describe('Google News feed topic scope', () => {
  for (const { category, name, scope } of SCOPED) {
    it(`${name} searches only its labelled publisher section on the server`, () => {
      const feed = VARIANT_FEEDS.full![category]!.find((entry) => entry.name === name);
      assert.match(query(urlOf(feed)), scope);
    });

    it(`${name} searches only its labelled publisher section in the browser`, () => {
      const feed = BROWSER_NEWS_CATALOG.editions.full![category]!.find((entry) => entry.name === name);
      assert.match(query(urlOf(feed)), scope);
    });
  }
});
