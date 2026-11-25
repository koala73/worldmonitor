// Google News search feeds put every result in the configured panel, so a
// loose query term is how off-topic stories reach finance, commodity and
// startup panels (#11266, #11267). This models Google's query operators over a title and the
// page text and checks each feed's shipped query against live titles.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NEWS_CATALOG } from '../shared/news-catalog.ts';

interface Story {
  title: string;
  // Page text Google matched outside the headline (site navigation, tickers, article body).
  page?: string;
}

type Matcher = (story: Story) => boolean;

const normalize = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

function termMatcher(token: string): Matcher {
  const negated = token.startsWith('-');
  const body = negated ? token.slice(1) : token;
  if (/^(site|when):/.test(body)) return () => true;
  const titleOnly = body.startsWith('intitle:');
  const needle = normalize((titleOnly ? body.slice('intitle:'.length) : body).replace(/"/g, ''));
  const contains: Matcher = ({ title, page = '' }) =>
    normalize(titleOnly ? title : `${title} ${page}`).includes(needle);
  return negated ? (story) => !contains(story) : contains;
}

function parseQuery(query: string): Matcher {
  const tokens = query.match(/\(|\)|-?(?:\w+:)?(?:"[^"]*"|[^\s()"]+)/g) ?? [];
  let pos = 0;
  const parseAnd = (): Matcher => {
    const conjuncts: Matcher[] = [];
    while (pos < tokens.length && tokens[pos] !== ')') {
      const alternatives = [parseAtom()];
      while (tokens[pos] === 'OR') {
        pos += 1;
        alternatives.push(parseAtom());
      }
      conjuncts.push((story) => alternatives.some((m) => m(story)));
    }
    return (story) => conjuncts.every((m) => m(story));
  };
  const parseAtom = (): Matcher => {
    const token = tokens[pos++]!;
    if (token !== '(') return termMatcher(token);
    const group = parseAnd();
    pos += 1;
    return group;
  };
  return parseAnd();
}

function feedQueries(name: string): string[] {
  const feed = NEWS_CATALOG.feeds.find((f) => f.name === name);
  assert.ok(feed, `${name} is in the catalog`);
  const urls = [feed.url, (feed as { browser?: { url?: unknown } }).browser?.url];
  return urls
    .filter((u): u is string => typeof u === 'string')
    .map((u) => new URL(u).searchParams.get('q') ?? '');
}

type Cases = Record<string, { drop: Story[]; keep: Story[] }>;

const CASES: Cases = {
  'Treasury Watch': {
    drop: [{ title: 'Researchers Take Over Five US Treasury Subdomains for About $3 Each - Hackread' }],
    keep: [
      { title: 'Treasury yields fall as investors await key inflation signal - CNBC' },
      { title: 'U.S. Treasury Yields Fall Ahead of PCE Inflation Data - marketscreener.com' },
    ],
  },
  'Banking Rules': {
    drop: [
      { title: 'An exceptional painting by Willem de Kooning sold for $32 million at Art Basel Miami auction' },
      { title: 'SOA Artists Prominently Featured in Miami Art Week and Art Basel - Columbia School of the Arts' },
    ],
    keep: [
      { title: 'Basel Committee agrees to consult on updating its 2008 liquidity principles - Tokyo Brief' },
      { title: 'What Basel 3.1 will change for UK banks in 2027 - Consultancy.uk' },
    ],
  },
  'Forex News': {
    drop: [{ title: 'AION2 adds Currency Deduction sanctions and limits server transfers - A 90s Kid', page: 'gaming' }],
    keep: [{ title: 'Results of foreign currency trading on KASE as of 15: 30 - www.marketscreener.com' }],
  },
  'FX Empire Gold': {
    drop: [
      { title: 'iShares Core S&P 500 ETF (IVV) Technical Analysis Today - FXEmpire', page: 'Gold' },
      { title: 'XRP Price Prediction: Next Leg Down Could Start After Sweeping $0.94 - FXEmpire', page: 'Gold' },
      { title: 'Natural Gas Price Forecast: Consolidation Near Highs Puts Breakout in Focus - FXEmpire', page: 'Gold' },
    ],
    keep: [
      { title: 'Gold Price Forecast: ETF Outflows Threaten Gold’s Sharp Recovery - FXEmpire' },
      { title: 'Silver (XAG/USD) Price Forecast: Deepening Selloff Puts Major Support to the Test - FXEmpire' },
    ],
  },
  'Hedge Fund News': {
    drop: [{ title: '3 Citadel cadets arrested on second-degree assault and battery charges - WCIV' }],
    keep: [
      { title: 'Citadel Securities Says 2018 Playbook Warns of More Market Pain - Bloomberg' },
      { title: 'Renaissance Technologies Opened $739 Million in New Positions in Three Big Banks - Yahoo Finance' },
      { title: 'Hedge fund leverage hits five-year low amid AI selloff - Hedgeweek' },
    ],
  },
  'Private Equity': {
    drop: [{ title: 'Artesia Approves Eagle Scout-Led Memorial for Apollo 14 Astronaut Edgar Mitchell - Artesia Daily Press' }],
    keep: [
      { title: 'NBA rallies private equity for €10bn European arena fund - Financial Times' },
      { title: 'KKR & Co.: Will The Last Private Credit Fund Please Turn Off The Lights (NYSE:KKR) - Seeking Alpha' },
    ],
  },
  'Commodity Trading': {
    drop: [{ title: 'E-mini Nasdaq-100 futures drop over 2% as chipmakers slide. - CME Group' }],
    keep: [
      { title: 'NYMEX: Precious Metals Prices Down - 24-11-26 - Armenpress' },
      { title: "Commodities Trading: Gold Stocks, Oil Stocks, Silver, Natural Gas - Investor's Business Daily" },
    ],
  },
  'Mine Web (SNL)': {
    drop: [{ title: 'CleanSpark Q4 revenue falls 46% on lower bitcoin mining operations, fair-value loss - TradingView' }],
    keep: [
      { title: 'Hitachi Energy, LKAB and Scania take the next step in electrifying mining operations in Malmberget, Sweden - Hitachi' },
      { title: 'Mining company close to securing a prospecting permit to drill in northern Wisconsin - BusinessNorth' },
    ],
  },
  'Reuters Nasdaq Futures': {
    drop: [{ title: 'Indian shares may open higher as foreign inflows, lower oil prices aid sentiment - Reuters', page: 'Nasdaq futures' }],
    keep: [
      { title: "Nasdaq, S&P 500 slip following Monday's Nvidia-fueled rally - Reuters" },
      { title: 'US stock futures extend losses after economic data - Reuters' },
    ],
  },
  'Bloomberg Crypto': {
    drop: [{ title: 'Citi weighs return to Venezuela five years after exit, Bloomberg News reports - Yahoo Finance', page: 'crypto' }],
    keep: [
      { title: 'Bitcoin Funds Head for Worst Month as Outflows Near $5 Billion - Bloomberg' },
      { title: 'OKXICE Makes the Case for Tokenized Stocks During Crypto Winter - Bloomberg' },
    ],
  },
  'Bloomberg Commodities': {
    drop: [
      { title: 'Huawei Found Guilty of US Criminal Charges in Landmark Case - Bloomberg', page: 'Commodities' },
      { title: 'Xi Probes Shanghai Boss, Widening Biggest Shakeup in Decades - Bloomberg', page: 'Commodities' },
    ],
    keep: [
      { title: 'Codelco Offers Lower Copper Premiums to Revive Sales to China - Bloomberg' },
      { title: 'Metals Rout Deepens as AI, Fed Worries Fuel Bearish Sentiment - Bloomberg' },
    ],
  },
  'Reuters Commodities': {
    drop: [
      {
        title: "China's Shenzhou-24 space flight takes off with Pakistani national as first foreign astronaut - Reuters",
        page: 'Commodities',
      },
    ],
    keep: [{ title: 'Gold falters ahead of key US inflation print - Reuters' }],
  },
  'CNBC Commodities': {
    drop: [
      { title: 'Anthropic shares fall below IPO price. Traders see even more pain - CNBC', page: 'gold oil' },
      {
        title: 'Kilmar Ábrego García, a Salvadoran national mistakenly deported from the U.S., arrives in Spain - CNBC',
        page: 'commodities',
      },
    ],
    keep: [{ title: 'Oil prices fall as supply glut concerns offset Middle East disruption fears - CNBC' }],
  },
};

const STARTUP_CASES: Cases = {
  'YC News': {
    drop: [
      { title: 'A few questions for the guy who went snorkeling in a Home Depot retention pond' },
      { title: 'Button Sounds – collection of professionally-recorded button clicks and presses' },
      { title: 'Matrix Multiplication is Θ(n^2.25) [pdf]' },
    ],
    keep: [
      { title: 'YC-backed LATO raises $4.7M seed to put AI agents on private equity’s due diligence calls - Tech Funding News' },
      { title: 'Madrone raises $500K from NVIDIA, Y Combinator for data-center cooling - Dealroom' },
    ],
  },
  'Startup Funding': {
    drop: [
      { title: "Six key questions raised by Jensen Huang's return to Nvidia - CNBC" },
      { title: 'More Than $1.2 Million Raised at Sleep Out at the Ballpark - MLB.com' },
    ],
    keep: [
      { title: 'Israeli startup secures $2.5M to recycle industrial gas waste instead of burning it - CTech' },
      { title: 'Swedish startup raises $3 million seed to help retailers become more visible in AI-powered shopping - ArcticStartup' },
    ],
  },
  'VC News': {
    drop: [
      { title: 'Venture capital in developing economies: five key facts - World Bank Blogs' },
      { title: 'Yard Stick PBC: What Climate Tech Founders Need to Know About Venture Capital - Harvard Business School' },
      { title: 'MetLife Series A Preferreds: The Limitations Of Floating-Rate Protection (NYSE:MET.PR.A) - Seeking Alpha' },
      { title: '‘Secret Service’ series a twist on espionage drama - Boston Herald' },
    ],
    keep: [
      { title: "Agon raises $70 million in Series A round to build Europe's defence AI lab - AFP.com" },
      { title: 'Codex lands $30m Series A to scale stablecoin FX - FinTech Global' },
    ],
  },
  'IPO Filing News': {
    drop: [
      { title: 'Hot Upcoming IPOs to Watch - Kiplinger' },
      { title: 'Insurance AI startup Voltaire adds $573K via SAFEs - Dealroom' },
      { title: 'Phio Pharmaceuticals Begins PH-762 Phase 2b Study Start-Up with Prosoft - TradingView' },
    ],
    keep: [
      { title: 'Nvidia-Backed SB Energy Updates IPO Filing - Moomoo' },
      { title: 'NLC India Renewables Files For IPO, Draft Prospectus Shows - TradingView' },
    ],
  },
};

function assertScope(cases: Cases) {
  for (const [name, { drop, keep }] of Object.entries(cases)) {
    it(name, () => {
      for (const query of feedQueries(name)) {
        const matches = parseQuery(query);
        for (const story of drop) assert.equal(matches(story), false, `${query} admits "${story.title}"`);
        for (const story of keep) assert.equal(matches(story), true, `${query} drops "${story.title}"`);
      }
    });
  }
}

describe('finance and commodity search feeds match only their topic (#11266)', () => assertScope(CASES));

describe('startup and accelerator search feeds match only their topic (#11267)', () => {
  assertScope(STARTUP_CASES);

  it('labels name what the feed carries', () => {
    const urlOf = (name: string) => NEWS_CATALOG.feeds.find((f) => f.name === name)?.url;
    assert.equal(urlOf('YC Launches'), 'https://hnrss.org/launches', 'YC Launches reads only Launch HN posts');
    assert.equal(urlOf('SEC Filings'), undefined, 'no news search is labelled as SEC filings');
  });
});
