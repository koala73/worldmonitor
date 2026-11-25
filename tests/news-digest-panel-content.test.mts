import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
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
        'Regulator delivers coup de grâce to merger attempt',
        'Arsenal plot transfer coup for striker',
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
        'Soldiers stage a socialist coup in Bolivia',
        'Military foils leftist coup attempt in Bolivia',
        'Conservative coup plot uncovered in Bolivia',
        'Police uncover plot for a leftist coup in Bolivia',
        'Army-backed legislative coup ousts president',
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
      ['Apple AirPods are $50 off at Amazon - 9to5Toys', '9to5Toys'],
      ['Apple Watch deals: save up to 40% at Amazon - 9to5Toys', '9to5Toys'],
      ['Apple AirPods on sale at Amazon - 9to5Toys', '9to5Toys'],
      ['Apple iPad hits lowest priced ever at Amazon - 9to5Toys', '9to5Toys'],
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
      "Judge rules Google's exclusive search deals violate antitrust law - Reuters",
      'US announces new rules on sales of AI chips to China - Reuters',
      'Amazon sued over lowest-price rules for third-party sellers - Reuters',
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

describe('search-fed category digests: topic relevance (#11266)', () => {
  const feedNamed = (category: string, name: string) => {
    const feed = Object.values(VARIANT_FEEDS).flatMap(byCategory => byCategory[category] ?? []).find(f => f.name === name);
    assert.ok(feed, `${category} feed ${name} is in the catalog`);
    return feed;
  };

  const cases = [
    {
      category: 'centralbanks', feed: 'BoE Watch', source: 'StoneX',
      offTopic: [
        'S&P 500 Quietly Shrugs Off the Bitcoin and Silver Selloff - StoneX',
        'Nasdaq 100 Forecast: NDX rises after Nvidia earnings calm AI worries - StoneX',
      ],
      onTopic: [
        'British Pound rebounds as BoE hike bets counter USD strength - FXStreet',
        'Students meet the Bank of England Governor - Bank of England',
        'Major bank predicts rate cut - Daily Express',
      ],
    },
    {
      category: 'energy', feed: 'Reuters Energy', source: 'Reuters',
      offTopic: [
        "Radar issue delaying flights at Chicago O'Hare airport, FAA says - Reuters",
        "China's Shenzhou-24 space flight takes off with Pakistani national as first foreign astronaut - Reuters",
        'Dell lifts annual forecasts after record quarter on surging AI server demand - Reuters',
      ],
      onTopic: [
        'Oil settles up $2 as traders weigh continued Hormuz ship attacks - Reuters',
        'Longer battery storage durations reshape US power markets - Reuters',
        "Nigeria's SEC approves Dangote refinery's IPO share distribution plan, sources say - Reuters",
        'Dutch TTF slides as mild weather caps demand - Reuters',
      ],
    },
    {
      category: 'commodity-news', feed: 'Bloomberg Commodities', source: 'Bloomberg',
      offTopic: [
        'Xi Probes Shanghai Boss, Widening Biggest Shakeup in Decades - Bloomberg',
        'Huawei Found Guilty of US Criminal Charges in Landmark Case - Bloomberg',
        'Airbus to Sell US Space Business to Investment Firm Cerberus - Bloomberg',
      ],
      onTopic: [
        'LME tightens rules in response to aluminium squeeze - Bloomberg',
        'ExxonMobil says Guyana output to top 1 million bpd within weeks - Bloomberg',
        'Platts launches STS Lome Gasoline differentials to Eurobob FOB AR assessments - S&P Global',
      ],
    },
    {
      category: 'crypto', feed: 'Bloomberg Crypto', source: 'Yahoo Finance',
      offTopic: [
        'Citi weighs return to Venezuela five years after exit, Bloomberg News reports - Yahoo Finance',
        "Trump Says Huang Pardon 'Always an Option,' New York Post Reports - Yahoo Finance UK",
        'ProShares Ultra Bloomberg Natural Gas (BOIL) options chain - Yahoo Finance UK',
      ],
      onTopic: [
        'Bitcoin Funds Head for Worst Month as Outflows Near $5 Billion - Bloomberg',
        'Watch Focused on Digital Shares Over Tokens: Cunningham - Bloomberg',
        'Stablecoin issuers race for bank charters - Bloomberg',
        'Decentralized finance lenders tighten collateral rules - Bloomberg',
      ],
    },
    {
      category: 'gold-silver', feed: 'FX Empire Gold', source: 'FXEmpire',
      offTopic: [
        'Crypto Price Forecasts Today: Expert Analysis & Predictions - FXEmpire',
        'Natural Gas Price Forecast: Consolidation Near Highs Puts Breakout in Focus - FXEmpire',
        'S&P500 and Nasdaq Index: AI Stocks Slide as Nvidia and Anthropic Retreat - FXEmpire',
      ],
      onTopic: [
        'PCE Inflation Rises to 3.8% as Stocks, Gold and Silver Weaken - FXEmpire',
        'Gold vs Bitcoin: Which Hedge Holds Up? - FXEmpire',
        'Platinum Price Forecast: XPT/USD Holds Above $1,500 - FXEmpire',
      ],
    },
  ];

  for (const { category, feed, source, offTopic, onTopic } of cases) {
    it(`${feed} keeps ${category} headlines and drops off-topic ones before the feed cap`, () => {
      const titles = [...offTopic, ...onTopic];
      const parsed = parseRssXml(googleNewsXml(titles.map(title => ({ title, source }))), feedNamed(category, feed), 'full');
      assert.deepEqual(parsed?.items.map(item => item.title), onTopic);
    });
  }

  it('leaves direct publisher feeds and search feeds shared with ungated categories alone', () => {
    const title = 'Hackers breach CIA intelligence network - CoinDesk';
    for (const feed of [feedNamed('crypto', 'CoinDesk'), feedNamed('crypto', 'Coinbase Blog')]) {
      const parsed = parseRssXml(googleNewsXml([{ title, source: 'CoinDesk' }]), feed, 'finance');
      assert.deepEqual(parsed?.items.map(item => item.title), [title], feed.name);
    }
  });
});
