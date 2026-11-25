// Reworded reports of one event must share a story card, while templated
// series and same-topic stories stay apart (#11266). Titles are live digest rows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clusterNewsCore } from '../shared/news-clustering-core.js';

const at = new Date('2026-11-25T10:00:00Z');
const item = (title, source = 'Google News') => ({ title, source, link: `https://example.test/${encodeURIComponent(title)}`, pubDate: at });
const groups = (titles, source) => clusterNewsCore(titles.map((t) => item(t, source)), () => 3)
  .map((c) => c.allItems.map((i) => i.title).sort());
const together = (titles, source) => assert.equal(groups(titles, source).length, 1, titles.join(' / '));
const apart = (titles, source) => assert.equal(groups(titles, source).length, titles.length, titles.join(' / '));

describe('clusterNewsCore groups reworded reports of one event (#11266)', () => {
  it('merges the Ontario mine-legislation paraphrases', () => {
    together([
      'Ontario to introduce legislation to speed up mine development - QP Briefing',
      'Ontario plans to speed up mine development with new legislation - The Globe and Mail',
    ]);
  });

  it('merges the Saba Capital / BNY Mellon DHF stake filing reports', () => {
    together([
      'Saba Capital Pushes for Changes at BNY Mellon High Yield Strategies Fund with 5.11% Stake - TradingView',
      'A stake in BNY Mellon High Yield Strategies Fund (DHF) cost about $8.21M. - Stock Titan',
    ]);
  });

  it('merges the Mississippi plane crash and Naver Cloud partnership reports', () => {
    together([
      'Plane carrying 6 people crashes off Mississippi coast, search ongoing: US Coast Guard - ABC News',
      '4 adults and 2 kids are missing after plane crashes off Mississippi coast - NBC News',
    ]);
    together([
      'Naver Cloud Teams Up with Korea Hydro & Nuclear Power, KEPCO KDN on AI Transformation of Nuclear Power... - BigGo Finance',
      'NAVER Cloud is partnering with Korea Hydro & Nuclear Power (KHNP) and KEPCO KDN to accelerate th.. - 매일경제',
    ]);
  });

  it('merges Shirudo launch reports carried by one aggregator feed', () => {
    together([
      'Cisco, OpenAI Launch Shirudo to Fight Cyberattacks Using AI - The 420.in',
      'Cisco, OpenAI Launch Shirudo: eBPF Shields, 0 Reboots - shattered.io',
      'Cisco & OpenAI launch Shirudo to shield Linux systems - SecurityBrief Asia',
    ], 'Open Source News');
  });

  it('keeps one outlet\'s templated stories about different companies apart', () => {
    apart([
      'IAMGOLD Corporation (TSX:IMG) Stock Declines 2.07%: Production Costs and Gold Market Volatility Weigh on Investor Sentiment - kalkine.ca',
      'Cameco Corporation (TSX:CCO) Stock Declines 3.52%: Uranium Market Volatility and Valuation Risks Pressure Investor Sentiment - kalkine.ca',
    ], 'Kalkine Media');
    apart([
      'Sugar Price India, 25 Nov 2026: Output at Decade Low — CMB News - CMB News',
      'Sugar Price India, 25 Nov 2026: Policy Shift Caps Domestic Rally — CMB News - CMB News',
    ], 'CMB News');
    const bylined = [
      item('IAMGOLD Corporation (TSX:IMG) Stock Declines 2.07%: Production Costs and Gold Market Volatility Weigh on Investor Sentiment - Kalkine Media', 'Google News'),
      item('Cameco Corporation (TSX:CCO) Stock Declines 3.52%: Uranium Market Volatility and Valuation Risks Pressure Investor Sentiment', 'Kalkine Media'),
    ];
    assert.equal(clusterNewsCore(bylined, () => 3).length, 2, 'a byline and a feed label naming one outlet are one publisher');
    const domainCredited = [
      item('IAMGOLD Corporation (TSX:IMG) Stock Declines 2.07%: Production Costs and Gold Market Volatility Weigh on Investor Sentiment - bbc.com', 'Google News'),
      item('Cameco Corporation (TSX:CCO) Stock Declines 3.52%: Uranium Market Volatility and Valuation Risks Pressure Investor Sentiment', 'BBC News'),
    ];
    assert.equal(clusterNewsCore(domainCredited, () => 3).length, 2, 'a domain credit and a feed label of one outlet are one publisher');
  });

  it('keeps different events that share an organisation or topic apart', () => {
    apart([
      'PBOC sets USD/CNY reference rate at 6.7088 vs. 6.7111 previous - FXStreet',
      'PBOC is expected to set the USD/CNY reference rate at 6.6559 – Reuters estimate - investingLive',
    ]);
    apart([
      'Ontario to introduce legislation to speed up mine development - QP Briefing',
      'Ontario mine workers strike over pay as development stalls - CBC News',
    ]);
    apart([
      'Saba Capital Pushes for Changes at BNY Mellon High Yield Strategies Fund with 5.11% Stake - TradingView',
      'Saba Capital takes 7% stake in Nuveen Municipal Credit Fund - Bloomberg',
    ]);
    apart([
      'Gold prices hit record high as Fed rate cut bets grow - Reuters',
      'Gold prices slip from record high as dollar firms ahead of Fed decision - CNBC',
    ]);
  });
});
