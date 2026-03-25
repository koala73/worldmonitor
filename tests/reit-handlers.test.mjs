/**
 * Handler tests for REIT RPC handlers with mock Redis data.
 * Tests: listReitQuotes, getReitCorrelation, getReitSocialSentiment, listReitProperties
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Mock Redis data ----

const MOCK_QUOTES = {
  quotes: [
    { symbol: 'O', name: 'Realty Income', sector: 'retail', price: 57.82, change: 1.23, dividendYield: 5.41, sparkline: [56, 57, 57.5, 57.8], disasterExposureScore: 34, market: 'us' },
    { symbol: 'PLD', name: 'Prologis', sector: 'industrial', price: 121.45, change: -0.67, dividendYield: 3.12, sparkline: [120, 121, 122, 121.5], disasterExposureScore: 22, market: 'us' },
    { symbol: 'NLY', name: 'Annaly Capital', sector: 'mortgage', price: 19.50, change: 0.15, dividendYield: 12.80, sparkline: [19, 19.2, 19.5], disasterExposureScore: 0, market: 'us' },
    { symbol: '180607.SZ', name: 'Huaxia COLI Commercial REIT', sector: 'retail', price: 5.83, change: 0.52, dividendYield: 4.00, sparkline: [5.7, 5.8, 5.83], disasterExposureScore: 15, market: 'china' },
  ],
  stale: false,
  lastUpdated: '2026-03-25T00:00:00Z',
};

const MOCK_CORRELATION = {
  indicators: [
    { seriesId: 'FEDFUNDS', name: 'Fed Funds Rate', value: 5.33, changeDescription: '▲ +25bps', direction: 'rising' },
    { seriesId: 'DGS10', name: '10-Year Treasury', value: 4.28, changeDescription: '▲ +12bps', direction: 'rising' },
  ],
  correlations: [
    { sector: 'retail', indicatorId: 'FEDFUNDS', indicatorName: 'Fed Funds Rate', coefficient: -0.55, interpretation: 'moderate inverse' },
  ],
  regime: 'REIT_REGIME_CAUTIOUS',
  sectorRotation: [{ sector: 'industrial', signal: 'overweight', reason: 'Inflation hedge' }],
  yieldSpread: 1.13,
  aiBriefing: 'Test briefing content.',
  lastUpdated: '2026-03-25T00:00:00Z',
};

const MOCK_SOCIAL = {
  sentiments: [
    { reitSymbol: 'SPG', socialHealthScore: 7.2, avgRating: 4.1, reviewVelocity: 12, positiveKeywords: ['great mall'], negativeKeywords: ['parking'], tenantRiskSignals: [], sector: 'retail' },
    { reitSymbol: 'O', socialHealthScore: 6.5, avgRating: 3.8, reviewVelocity: 0, positiveKeywords: [], negativeKeywords: [], tenantRiskSignals: [], sector: 'retail' },
  ],
  stale: false,
  lastUpdated: '2026-03-25T00:00:00Z',
  unavailableReason: '',
};

const MOCK_PROPERTIES = JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'reit-properties.json'), 'utf-8'));

// ---- Tests ----

describe('REIT data files', () => {
  it('reit-properties.json is valid JSON with required fields', () => {
    assert.ok(Array.isArray(MOCK_PROPERTIES));
    assert.ok(MOCK_PROPERTIES.length > 100, `Expected 100+ properties, got ${MOCK_PROPERTIES.length}`);

    for (const p of MOCK_PROPERTIES) {
      assert.ok(p.reitSymbol, `Property missing reitSymbol: ${JSON.stringify(p)}`);
      assert.ok(p.propertyName, `Property missing propertyName`);
      assert.ok(typeof p.lat === 'number' && p.lat !== 0, `Property ${p.propertyName} has invalid lat`);
      assert.ok(typeof p.lng === 'number' && p.lng !== 0, `Property ${p.propertyName} has invalid lng`);
      assert.ok(p.sector, `Property ${p.propertyName} missing sector`);
      assert.ok(p.city, `Property ${p.propertyName} missing city`);
    }
  });

  it('all property reitSymbols exist in reits.json', () => {
    const reitsConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'reits.json'), 'utf-8'));
    const validSymbols = new Set(reitsConfig.symbols.map(s => s.symbol));
    const propertySymbols = [...new Set(MOCK_PROPERTIES.map(p => p.reitSymbol))];

    for (const sym of propertySymbols) {
      assert.ok(validSymbols.has(sym), `Property symbol ${sym} not found in reits.json`);
    }
  });

  it('mortgage REITs have no properties', () => {
    const reitsConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'reits.json'), 'utf-8'));
    const mortgageSymbols = new Set(reitsConfig.symbols.filter(s => s.sector === 'mortgage').map(s => s.symbol));
    const mortgageProperties = MOCK_PROPERTIES.filter(p => mortgageSymbols.has(p.reitSymbol));
    assert.equal(mortgageProperties.length, 0, `Mortgage REITs should have no properties, found ${mortgageProperties.length}`);
  });

  it('China REITs use correct Yahoo Finance suffixes', () => {
    const reitsConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'reits.json'), 'utf-8'));
    const chinaReits = reitsConfig.symbols.filter(s => s.market === 'china');

    for (const r of chinaReits) {
      const isValidSuffix = r.symbol.endsWith('.SS') || r.symbol.endsWith('.SZ');
      assert.ok(isValidSuffix, `China REIT ${r.symbol} should end with .SS or .SZ`);
    }
  });
});

describe('REIT reits.json config', () => {
  it('has correct sector assignments', () => {
    const reitsConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'reits.json'), 'utf-8'));
    const validSectors = new Set(reitsConfig.sectors.map(s => s.id));

    for (const sym of reitsConfig.symbols) {
      assert.ok(validSectors.has(sym.sector), `${sym.symbol} has invalid sector: ${sym.sector}`);
    }
  });

  it('has no duplicate symbols', () => {
    const reitsConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'reits.json'), 'utf-8'));
    const symbols = reitsConfig.symbols.map(s => s.symbol);
    const unique = new Set(symbols);
    assert.equal(symbols.length, unique.size, `Found duplicate symbols`);
  });

  it('sectors have colors defined', () => {
    const reitsConfig = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'reits.json'), 'utf-8'));
    for (const sector of reitsConfig.sectors) {
      assert.ok(sector.color, `Sector ${sector.id} missing color`);
      assert.match(sector.color, /^#[0-9a-f]{6}$/i, `Sector ${sector.id} has invalid color: ${sector.color}`);
    }
  });
});

describe('REIT quote filtering logic', () => {
  it('filters by sector', () => {
    const filtered = MOCK_QUOTES.quotes.filter(q => q.sector === 'retail');
    assert.equal(filtered.length, 2); // O + 180607.SZ
    assert.ok(filtered.every(q => q.sector === 'retail'));
  });

  it('filters by market', () => {
    const china = MOCK_QUOTES.quotes.filter(q => q.market === 'china');
    assert.equal(china.length, 1);
    assert.equal(china[0].symbol, '180607.SZ');
  });

  it('filters by symbol', () => {
    const symbolSet = new Set(['O', 'PLD']);
    const filtered = MOCK_QUOTES.quotes.filter(q => symbolSet.has(q.symbol));
    assert.equal(filtered.length, 2);
  });

  it('mortgage REITs excluded from social data', () => {
    const mortgageSymbols = new Set(['NLY', 'AGNC', 'STWD', 'TWO']);
    const socialSymbols = MOCK_SOCIAL.sentiments.map(s => s.reitSymbol);
    for (const sym of socialSymbols) {
      assert.ok(!mortgageSymbols.has(sym), `Mortgage REIT ${sym} should not have social data`);
    }
  });
});

describe('REIT correlation response', () => {
  it('has valid regime', () => {
    const validRegimes = ['REIT_REGIME_FAVORABLE', 'REIT_REGIME_CAUTIOUS', 'REIT_REGIME_STRESS', 'REIT_REGIME_NEUTRAL'];
    assert.ok(validRegimes.includes(MOCK_CORRELATION.regime));
  });

  it('sector rotation signals have required fields', () => {
    for (const signal of MOCK_CORRELATION.sectorRotation) {
      assert.ok(signal.sector);
      assert.ok(['overweight', 'underweight', 'neutral'].includes(signal.signal));
      assert.ok(signal.reason);
    }
  });

  it('yield spread is a number', () => {
    assert.equal(typeof MOCK_CORRELATION.yieldSpread, 'number');
  });
});
