import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { parseRssXml } = __testing__;

const FEED = {
  url: 'https://news.google.com/rss/search?q=site%3Amarketwatch.com%20markets%20when%3A1d&hl=en-US&gl=US&ceid=US:en',
  name: 'MarketWatch',
  lang: 'en',
} as const;

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function keeps(title: string): boolean {
  const publisher = title.slice(title.lastIndexOf(' - ') + 3);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item>`
    + `<title>${escapeXml(title)}</title>`
    + `<link>https://news.google.com/rss/articles/CBMiTest?oc=5</link>`
    + `<pubDate>${new Date(Date.now() - 60 * 60 * 1000).toUTCString()}</pubDate>`
    + `<source url="https://www.example.com">${escapeXml(publisher)}</source>`
    + `</item></channel></rss>`;
  const result = parseRssXml(xml, FEED, 'finance');
  return (result?.items ?? []).some(item => item.title === title);
}

describe('parseRssXml: quote, chart, tag and section pages are not articles', () => {
  const referencePages = [
    'AMD Stock Price | Advanced Micro Devices Inc. Stock Quote (U.S.: Nasdaq) - MarketWatch',
    'DJIA | Dow Jones Industrial Average Overview - MarketWatch',
    'GC00 | Gold Continuous Contract Overview - MarketWatch',
    'S&P Dow Jones Indices - S&P Global',
    'CNBC Asia Video News Clips on the Stock Market - CNBC',
    "Check out Clywedog Therapeutics's stock price (CLYD) in real time - CNBC",
    'TAG: First Quantum Minerals - Kitco',
    'COMMODITIES News - Kitco',
    'Gold, Silver, Platinum News, Opinion & Analysis - Kitco',
    'Silver Price Today | Price of Silver Per Ounce | 24 Hour Spot Chart - Kitco',
    'Price of Copper per Pound - Kitco',
    'Videos - Kitco',
    'Research Center - PitchBook - PitchBook',
    'Jiaxing Huansu RMB Fund: Performance - PitchBook',
    'TPG AG Realty Value XII Co-Investment 4: Fund Performance - PitchBook',
    'My Fan Picks - AP News',
    'Invesco US Treasury Bond 7-10 Year UCITS ETF USD Dist (TRXG.L) Seasonal returns chart - Yahoo Finance Australia',
    'Harbor Funds - Harbor High-Yield Bond Fund (HYFAX) Seasonal Returns Chart - Yahoo Finance - Yahoo! Finance Canada',
    'CIBC 2031 Investment Grade Bond Fund ETF Series (CTBG.NE) performance history - Yahoo Finance UK',
    'iShares iBoxx $ High Yield Corporate Bond ETF (HYG) options chain - Yahoo Finance Australia',
    'SPY Nov 2026 657.000 put (SPY261125P00657000) Stock Price, News, Quote & History - Yahoo Finance',
  ];
  for (const title of referencePages) {
    it(`drops "${title}"`, () => assert.equal(keeps(title), false));
  }

  const articles = [
    'The S&P 500 is headed to 8,200 — and downturns like this one are actually part of the reason why, says JPMorgan - MarketWatch',
    'Micron’s stock falls as an analyst warns about a future supply glut - MarketWatch',
    'Tilray Brands Inc. stock falls Tuesday, underperforms market - MarketWatch',
    'Anthropic closes below $83 IPO price, but analysts are still largely positive - CNBC',
    'Nasdaq futures slide amid reports of fresh U.S. tariffs as tech sell-off intensifies - CNBC',
    'Gold’s selloff is sowing the seeds of its next rally – Theo’s Iggy Ioppe - Kitco',
    'COMMODITY TRACKER: 5 charts to watch this week - S&P Global',
    'Anthropic’s $81.3B haul makes it the largest tech IPO ever - PitchBook',
    'TCW MetWest High Yield Bond Fund Q3 2026 Commentary (MWHIX) - Seeking Alpha',
    'HYGH: Rate-Hedged High-Yield Bond ETF, Good Performance, Terrible Price - Seeking Alpha',
    'Turkish military helicopter crashes during training flight, killing 5 crew members - AP News',
  ];
  for (const title of articles) {
    it(`keeps "${title}"`, () => assert.equal(keeps(title), true));
  }
});
