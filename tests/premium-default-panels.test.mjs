import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelsSrc = readFileSync(resolve(__dirname, '../src/config/panels.ts'), 'utf-8');

describe('premium panels are not in default variant seeds', () => {
  it('derives VARIANT_DEFAULTS through getDefaultPanelKeys()', () => {
    assert.match(
      panelsSrc,
      /function getDefaultPanelKeys\(panels: Record<string, PanelConfig>\): string\[] \{\s*return Object\.entries\(panels\)\s*\.filter\(\(\[, config\]\) => config\.premium !== 'locked'\)\s*\.map\(\(\[key\]\) => key\);\s*\}/s,
    );
  });

  it('uses filtered defaults for full and finance variants', () => {
    assert.ok(panelsSrc.includes('full:      getDefaultPanelKeys(FULL_PANELS),'));
    assert.ok(panelsSrc.includes('finance:   getDefaultPanelKeys(FINANCE_PANELS),'));
  });

  it('removes locked finance panels from finMarkets category', () => {
    assert.ok(
      panelsSrc.includes("panelKeys: ['portfolio-impact', 'idea-radar', 'markets', 'markets-news', 'heatmap', 'macro-signals', 'analysis', 'polymarket']"),
      'finMarkets should not foreground stock-analysis, stock-backtest, or daily-market-brief',
    );
  });

  it('keeps finance guide panels in the finance default panel seed', () => {
    assert.match(
      panelsSrc,
      /const FINANCE_PANELS: Record<string, PanelConfig> = \{[\s\S]*'portfolio-impact': \{ name: 'Portfolio Impact', enabled: true, priority: 1 \},[\s\S]*'idea-radar': \{ name: 'Idea Radar', enabled: true, priority: 1 \},[\s\S]*\};/s,
    );
  });

  it('keeps fragile global external panels disabled by default', () => {
    assert.match(
      panelsSrc,
      /'satellite-fires': \{ name: 'Fires', enabled: false, priority: 2 \},[\s\S]*'fear-greed': \{ name: 'Fear & Greed', enabled: false, priority: 2 \},[\s\S]*'market-breadth': \{ name: 'Market Breadth', enabled: false, priority: 2 \},[\s\S]*'liquidity-shifts': \{ name: 'Liquidity Shifts', enabled: false, priority: 2 \},[\s\S]*'positioning-247': \{ name: '24\/7 Positioning', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /'pipeline-status': \{ name: 'Oil & Gas Pipeline Status', enabled: false, priority: 2 \},[\s\S]*'storage-facility-map': \{ name: 'Strategic Storage Atlas', enabled: false, priority: 2 \},[\s\S]*'fuel-shortages': \{ name: 'Global Fuel Shortage Registry', enabled: false, priority: 2 \},[\s\S]*'energy-disruptions': \{ name: 'Energy Disruptions Log', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /'etf-flows': \{ name: 'BTC ETF Tracker', enabled: false, priority: 2 \},[\s\S]*stablecoins: \{ name: 'Stablecoins', enabled: false, priority: 2 \},[\s\S]*'ucdp-events': \{ name: 'UCDP Conflict Events', enabled: false, priority: 2 \},[\s\S]*'disease-outbreaks': \{ name: 'Disease Outbreaks', enabled: false, priority: 2 \},[\s\S]*'social-velocity': \{ name: 'Social Velocity', enabled: false, priority: 2 \},/s,
    );
  });

  it('places finance guide panels near the top of the finance seed order', () => {
    assert.match(
      panelsSrc,
      /const FINANCE_PANELS: Record<string, PanelConfig> = \{[\s\S]*'portfolio-impact': \{ name: 'Portfolio Impact', enabled: true, priority: 1 \},[\s\S]*'idea-radar': \{ name: 'Idea Radar', enabled: true, priority: 1 \},[\s\S]*markets: \{ name: 'Live Markets', enabled: true, priority: 1 \},[\s\S]*'macro-signals': \{ name: 'Market Regime', enabled: true, priority: 1 \},[\s\S]*'live-news': \{ name: 'Market Headlines', enabled: true, priority: 1 \},/s,
    );
  });

  it('keeps fragile finance analytics disabled by default', () => {
    assert.match(
      panelsSrc,
      /'macro-tiles': \{ name: 'Macro Indicators', enabled: false, priority: 1 \},[\s\S]*'fear-greed': \{ name: 'Fear & Greed', enabled: false, priority: 1 \},[\s\S]*'market-breadth': \{ name: 'Market Breadth', enabled: false, priority: 1 \},[\s\S]*'fsi': \{ name: 'Financial Stress', enabled: false, priority: 1 \},[\s\S]*'yield-curve': \{ name: 'Yield Curve', enabled: false, priority: 1 \},[\s\S]*'earnings-calendar': \{ name: 'Earnings Calendar', enabled: false, priority: 1 \},[\s\S]*'economic-calendar': \{ name: 'Economic Calendar', enabled: false, priority: 1 \},/s,
    );
    assert.match(
      panelsSrc,
      /'crypto-heatmap': \{ name: 'Crypto Sectors', enabled: false, priority: 1 \},[\s\S]*'defi-tokens': \{ name: 'DeFi Tokens', enabled: false, priority: 2 \},[\s\S]*'ai-tokens': \{ name: 'AI Tokens', enabled: false, priority: 2 \},[\s\S]*'other-tokens': \{ name: 'Alt Tokens', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /centralbanks: \{ name: 'Central Bank Watch', enabled: false, priority: 1 \},/s,
    );
    assert.match(
      panelsSrc,
      /economic: \{ name: 'Macro Stress', enabled: false, priority: 1 \},[\s\S]*'sanctions-pressure': \{ name: 'Sanctions Pressure', enabled: false, priority: 1 \},[\s\S]*'supply-chain': \{ name: 'Supply Chain', enabled: false, priority: 1 \},[\s\S]*'economic-news': \{ name: 'Economic News', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /'live-webcams': \{ name: 'Live Webcams', enabled: false, priority: 2 \},[\s\S]*'markets-news': \{ name: 'Markets News', enabled: false, priority: 2 \},[\s\S]*'commodities-news': \{ name: 'Commodities News', enabled: false, priority: 2 \},[\s\S]*'crypto-news': \{ name: 'Crypto News', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /analysis: \{ name: 'Market Analysis', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /ipo: \{ name: 'IPOs, Earnings & M&A', enabled: false, priority: 1 \},[\s\S]*derivatives: \{ name: 'Derivatives & Options', enabled: false, priority: 2 \},[\s\S]*fintech: \{ name: 'Fintech & Trading Tech', enabled: false, priority: 2 \},[\s\S]*'fin-regulation': \{ name: 'Financial Regulation', enabled: false, priority: 2 \},[\s\S]*institutional: \{ name: 'Hedge Funds & PE', enabled: false, priority: 2 \},/s,
    );
    assert.match(
      panelsSrc,
      /'etf-flows': \{ name: 'BTC ETF Tracker', enabled: false, priority: 2 \},[\s\S]*stablecoins: \{ name: 'Stablecoins', enabled: false, priority: 2 \},[\s\S]*'gcc-investments': \{ name: 'GCC Investments', enabled: false, priority: 2 \},[\s\S]*gccNews: \{ name: 'GCC Business News', enabled: false, priority: 2 \},[\s\S]*'airline-intel': \{ name: 'Airline Intelligence', enabled: false, priority: 2 \},[\s\S]*monitors: \{ name: 'My Monitors', enabled: false, priority: 2 \},/s,
    );
  });
});
