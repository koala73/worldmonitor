import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { classifyByKeyword } from '../server/worldmonitor/news/v1/_classifier';
import { classifyByKeyword as classifyInBrowser } from '../shared/threat-keyword-classifier';

const { parseRssXml, isCategoryEligible } = __testing__;

function googleNewsXml(items: Array<{ title: string; source: string }>): string {
  const pubDate = new Date().toUTCString();
  const body = items.map(({ title, source }, i) => `<item><title>${title}</title>
    <link>https://news.google.com/rss/articles/item-${i}?oc=5</link><pubDate>${pubDate}</pubDate>
    <source url="https://www.justice.gov">${source}</source></item>`).join('');
  return `<rss><channel>${body}</channel></rss>`;
}

describe('gov digest: publisher-only titles', () => {
  const feed = { name: 'DOJ', url: 'https://news.google.com/rss/search?q=site%3Ajustice.gov' };

  it('drops titles that are only the publisher suffix and keeps real headlines', () => {
    const parsed = parseRssXml(googleNewsXml([
      { title: ' - Department of Justice (.gov)', source: 'Department of Justice (.gov)' },
      { title: '- Department of Justice (.gov)', source: 'Department of Justice (.gov)' },
      { title: ' - Reuters', source: 'Reuters' },
      {
        title: 'Portland Drug Trafficker Pleads Guilty to Possessing Cocaine - Department of Justice (.gov)',
        source: 'Department of Justice (.gov)',
      },
    ]), feed, 'full');
    assert.deepEqual(
      parsed?.items.map(item => item.title),
      ['Portland Drug Trafficker Pleads Guilty to Possessing Cocaine - Department of Justice (.gov)'],
    );
  });
});

describe('keyword classifier: metaphorical coup language', () => {
  for (const [name, classify] of [['digest', classifyByKeyword], ['browser', classifyInBrowser]] as const) {
    it(`${name}: political and business metaphors are not military alerts`, () => {
      for (const title of [
        'Opinion | A Progressive Coup Fails in California',
        'Boardroom coup topples Acme chief executive',
        'Signing the striker is a transfer coup for Arsenal',
        'Landing the summit is a diplomatic coup for Brazil',
        "The ruling delivered the coup de grâce to the merger",
      ]) {
        const result = classify(title);
        assert.notEqual(result.category, 'military', title);
        assert.notEqual(result.level, 'critical', title);
      }
    });

    it(`${name}: real coups stay critical military events`, () => {
      for (const title of [
        'Military coup in Niger as soldiers seize presidential palace',
        'Coup attempt foiled in Bolivia',
        'Boardroom coup at Acme as army stages coup in Gabon',
        'Bolivia foils conservative coup attempt',
      ]) {
        const result = classify(title);
        assert.equal(result.level, 'critical', title);
        assert.equal(result.category, 'military', title);
      }
    });
  }
});

describe('policy digest: AI and digital policy eligibility', () => {
  it('rejects consumer offers and non-digital reports', () => {
    for (const [title, publisher] of [
      ['Black Friday Deals: AirPods Pro 3 for $149, Apple Watch 12 for $299, & More - OS X Daily', 'OS X Daily'],
      ['Clean Energy Technology Observatory: Hydropower and Pumped Storage Hydropower in the European Union - 2026 status report on technology development, trends, value chains and markets - JRC Publications', 'JRC Publications'],
      ['European Cinema Night 2026 - Shaping Europe’s digital future', 'Shaping Europe’s digital future'],
    ]) {
      assert.equal(isCategoryEligible('policy', title, publisher), false, title);
    }
  });

  it('keeps AI, platform and antitrust policy headlines', () => {
    for (const title of [
      'Commission seeks feedback on draft template for the fundamental rights impact assessment under the AI Act - Shaping Europe’s digital future',
      'Commission preliminarily finds Temu in breach of the Digital Services Act for failure to tackle the sale of illegal products - Shaping Europe’s digital future',
      'Apple Pay antitrust class action must ‘get moving,’ US judge says - MLex',
      'Google adtech monopoly trial in New York pushed to Oct. 25, 2027 - MLex',
      "Google Antitrust Trial: Apple's $20B Deal, 140 Days Late - shattered.io",
      'Congressional Staffing Is the Biggest Tech Policy Problem No One Talks About - Tech Policy Press',
      'First European standard published to support the Cyber Resilience Act - Shaping Europe’s digital future',
    ]) {
      assert.equal(isCategoryEligible('policy', title), true, title);
    }
  });

  it('backfills a policy feed from eligible items instead of spending slots on rejected ones', () => {
    const techAntitrust = { name: 'Tech Antitrust', url: 'https://news.google.com/rss/search?q=(antitrust%20OR%20%22competition%20law%22)%20(%22Big%20Tech%22%20OR%20Google%20OR%20Apple%20OR%20Amazon%20OR%20Meta%20OR%20Microsoft%20OR%20Nvidia)%20when%3A7d&hl=en-US&gl=US&ceid=US:en' };
    const titles = [
      'Black Friday Deals: AirPods Pro 3 for $149, Apple Watch 12 for $299, & More - OS X Daily',
      ...Array.from({ length: 5 }, (_, i) => `Google antitrust ruling ${i + 1} - Reuters`),
    ];
    const parsed = parseRssXml(googleNewsXml(titles.map(title => ({ title, source: 'Reuters' }))), techAntitrust, 'tech');
    assert.deepEqual(parsed?.items.map(item => item.title), titles.slice(1));
  });

  it('leaves other categories unconstrained', () => {
    assert.equal(isCategoryEligible('gov', 'Black Friday Deals: AirPods Pro 3 for $149'), true);
  });
});
