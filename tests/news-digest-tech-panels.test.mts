import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';

const { parseRssXml, storyTrackLinkForPersist } = __testing__;

function techFeed(name: string) {
  const feed = Object.values(VARIANT_FEEDS.tech).flat().find(candidate => candidate.name === name);
  assert.ok(feed, `tech feed ${name} is configured`);
  return feed;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rss(items: Array<{ title: string; link: string; source?: string }>): string {
  const pubDate = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
  const body = items.map(({ title, link, source }) => `<item><title>${escapeXml(title)}</title>`
    + `<link>${escapeXml(link)}</link><pubDate>${pubDate}</pubDate>`
    + (source ? `<source url="https://www.example.com">${escapeXml(source)}</source>` : '')
    + `</item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

function keptTitles(feedName: string, titles: string[]): string[] {
  const feed = techFeed(feedName);
  const google = feed.url.startsWith('https://news.google.com/');
  const xml = rss(titles.map((title, i) => ({
    title,
    link: google ? `https://news.google.com/rss/articles/item-${i}?oc=5` : `https://www.tomshardware.com/news/item-${i}`,
    source: google ? title.slice(title.lastIndexOf(' - ') + 3) : undefined,
  })));
  return (parseRssXml(xml, feed, 'tech')?.items ?? []).map(item => item.title);
}

function keepsEach(feedName: string, titles: string[], expected: boolean) {
  for (const title of titles) {
    it(`${expected ? 'keeps' : 'drops'} "${title}"`, () => {
      assert.equal(keptTitles(feedName, [title]).includes(title), expected);
    });
  }
}

describe('funding panel: only headlines about a financing event', () => {
  describe('Startup Funding', () => {
    keepsEach('Startup Funding', [
      'Missing money raised for rescue chihuahua recovered with help of NBC 5 Responds - NBC Chicago',
      'Gov. Gretchen Whitmer fund has raised $40 million from secret donors - The Detroit News',
      'FAAS Jewelry Sale Raised $30K for Alameda Animal Shelter - Alameda Post',
      'Should Raised 2026 Outlook Require Action From Quanta Services (PWR) Investors? - Yahoo Finance',
      'Merck Just Raised Its Dividend. These 3 Dow Healthcare Giants Are Paying More - Yahoo Finance',
      'Arts news: Peninsula-raised artists earn Grammy nominations - Palo Alto Online',
      'Reward raised to $250K in 2013 killing of Maryland mail carrier - WTOP News',
    ], false);
    keepsEach('Startup Funding', [
      'Anthropic valued at $1.5 trillion as IPO raises record $81 billion - Reuters',
    ], true);
  });

  describe('VC News', () => {
    keepsEach('VC News', [
      'Venture Capital Lawyers India: A 2026 Hiring Guide for Founders and Investors - Global Advisory Experts',
      'Venture Capital Process Italy: 2026 Founder Guide - Global Advisory Experts',
      'Yard Stick PBC: What Climate Tech Founders Need to Know About Venture Capital - Harvard Business School',
      'Ten Lessons From Real Financial Models Help Founders Raise Capital - The Des Moines Register',
      'MetLife Series A Preferreds: The Limitations Of Floating-Rate Protection (NYSE:MET.PR.A) - Seeking Alpha',
      'The Hisense U7 Series: A Game-Changer of a TV That Is Always the Center of Attention - Gizmodo',
    ], false);
    keepsEach('VC News', [
      'Jordanian Fintech invoiceQ Raises $5 Million in Series A Funding - CairoScene',
      'Recruitment agent Archer raises $10 million in funding round - Staffing Industry Analysts',
      'Peak Energy expands Series B to $157m for sodium-ion scale-up - Energy Monitor',
      'Japanese group Persol joins Series A investment in India-based Wiffy - Consultancy.asia',
      'Romanian startup Outcome1 raises 1 mln euro in Catalyst-led funding round - SeeNews',
      'HIRAC leads Series B for Japan\'s frozen toddler-meal brand Mogumo - Dealroom',
      'Villanova launches $5M venture capital fund as universities push into investing - The Business Journals',
    ], true);
  });

  describe('Seed & Pre-Seed and SEC Filings', () => {
    keepsEach('Seed & Pre-Seed', ['Seed Funding Explained: A Guide for Tech Startups - Oracle NetSuite'], false);
    keepsEach('Seed & Pre-Seed', [
      'Dante Security Raises $10M in Seed Funding - FinSMEs',
      'Google\'s first backer, a Champions League winner join RHISE AI angel round - Dealroom',
    ], true);
    keepsEach('SEC Filings', ['NYC Tech Week in Review: 11/15/26 – 11/21/26 - AlleyWatch'], false);
    keepsEach('SEC Filings', [
      'Legal tech startup Finch eyes $85M raise - Axios',
      'Investors scramble for a piece of AI giant Anthropic in blockbuster IPO - NPR',
      'Insurance AI startup Voltaire adds $573K via SAFEs - Dealroom',
    ], true);
  });
});

describe('hardware panel: Tom\'s Hardware headlines must be about hardware', () => {
  keepsEach('Tom\'s Hardware', [
    'US DOJ touts "largest-ever" crackdown on scammers across the globe as it seizes 14,000 devices and $17 billion in illicit funds',
    'The best Black Friday VPN deals 2026, save up to 88%',
    'Saudi OpenAI eavesdropper who bugged company office had hundreds of private recordings',
  ], false);
  keepsEach('Tom\'s Hardware', [
    '7 new Intel Nova Lake-S Core Ultra 4000-series CPUs detailed in new leak',
    'Buying single sticks of DDR5 memory can save you more than buying a kit',
    'AMD\'s Radeon RX 9060 XT sets new GPU frequency world record of 4.837 GHz',
    'Bambu Lab P3C Review: A more affordable tool changer',
    'TP-Link\'s Archer 770 tri-band Wi-Fi 7 router is $120 off',
    'The state of China\'s memory industry in 2026',
    '512GB MacBook Neo drops to $699',
  ], true);

  it('leaves the SemiAnalysis feed in the same panel ungated', () => {
    const feed = techFeed('SemiAnalysis');
    const xml = rss([{ title: 'Robotics Levels of Autonomy', link: 'https://www.semianalysis.com/p/robotics' }]);
    assert.deepEqual(parseRssXml(xml, feed, 'tech')?.items.map(item => item.title), ['Robotics Levels of Autonomy']);
  });
});

describe('link aggregators keep the submitted article link', () => {
  for (const name of ['YC News', 'Hacker News', 'Show HN', 'Lobsters']) {
    it(`${name} items link to the external article`, () => {
      const xml = rss([{ title: 'How PyTorch autograd works', link: 'https://example.org/autograd' }]);
      assert.equal(parseRssXml(xml, techFeed(name), 'tech')?.items[0]?.link, 'https://example.org/autograd');
    });
  }

  it('keeps the article link when the story is stored', () => {
    const item = { link: 'https://example.org/autograd', source: 'YC News', originPublisher: '', originPublisherTrusted: false };
    assert.equal(storyTrackLinkForPersist(item), 'https://example.org/autograd');
    assert.equal(storyTrackLinkForPersist({ ...item, link: 'javascript:alert(1)' }), '');
  });

  it('still rejects non-HTTP links from an aggregator', () => {
    const xml = rss([{ title: 'Bad link', link: 'javascript:alert(1)' }]);
    assert.equal(parseRssXml(xml, techFeed('YC News'), 'tech')?.items[0]?.link, '');
  });

  it('still blanks off-publisher links on ordinary publisher feeds', () => {
    const xml = rss([{ title: 'New GPU leak', link: 'https://evil.example/gpu' }]);
    assert.equal(parseRssXml(xml, techFeed('Tom\'s Hardware'), 'tech')?.items[0]?.link, '');
  });
});
