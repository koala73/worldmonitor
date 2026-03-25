/**
 * Config guardrail tests for REIT panels and map layer.
 * Ensures REIT panels are registered in the finance variant
 * and the map layer is properly configured.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(relPath) {
  return readFileSync(resolve(__dirname, '..', relPath), 'utf-8');
}

describe('REIT panel config guardrails', () => {
  it('finance variant includes reits panel', () => {
    const src = readSrc('src/config/variants/finance.ts');
    assert.ok(src.includes("reits:"), 'Finance variant must include reits panel');
    assert.ok(src.includes("'reit-correlation':"), 'Finance variant must include reit-correlation panel');
    assert.ok(src.includes("'reit-social':"), 'Finance variant must include reit-social panel');
  });

  it('REIT panels are priority 1 or 2', () => {
    const src = readSrc('src/config/variants/finance.ts');
    // reits should be priority 1
    const reitsLine = src.split('\n').find(l => l.includes("reits:") && l.includes('priority'));
    assert.ok(reitsLine?.includes('priority: 1'), 'reits panel should be priority 1');
  });

  it('reitProperties is in MapLayers interface', () => {
    const src = readSrc('src/types/index.ts');
    assert.ok(src.includes('reitProperties: boolean'), 'MapLayers must include reitProperties');
  });

  it('reitProperties is in finance variant map layers', () => {
    const src = readSrc('src/config/variants/finance.ts');
    assert.ok(src.includes('reitProperties'), 'Finance variant map layers must include reitProperties');
  });

  it('reitProperties is in map layer registry', () => {
    const src = readSrc('src/config/map-layer-definitions.ts');
    assert.ok(src.includes("reitProperties"), 'Layer registry must include reitProperties');
    assert.ok(src.includes("'REIT Properties'"), 'Layer registry must have REIT Properties label');
  });

  it('reitProperties is in finance VARIANT_LAYER_ORDER', () => {
    const src = readSrc('src/config/map-layer-definitions.ts');
    const financeSection = src.slice(src.indexOf('finance: ['), src.indexOf(']', src.indexOf('finance: [')));
    assert.ok(financeSection.includes('reitProperties'), 'Finance VARIANT_LAYER_ORDER must include reitProperties');
  });

  it('REIT panels are created in panel-layout.ts', () => {
    const src = readSrc('src/app/panel-layout.ts');
    assert.ok(src.includes("createPanel('reits'"), 'panel-layout must create reits panel');
    assert.ok(src.includes("createPanel('reit-correlation'"), 'panel-layout must create reit-correlation panel');
    assert.ok(src.includes("createPanel('reit-social'"), 'panel-layout must create reit-social panel');
  });

  it('REIT components are exported from components/index.ts', () => {
    const src = readSrc('src/components/index.ts');
    assert.ok(src.includes("'./REITPanel'"), 'Must export REITPanel');
    assert.ok(src.includes("'./REITCorrelationPanel'"), 'Must export REITCorrelationPanel');
    assert.ok(src.includes("'./REITSocialPanel'"), 'Must export REITSocialPanel');
    assert.ok(src.includes("'./REITPeerOverlay'"), 'Must export REITPeerOverlay');
  });

  it('REIT service is exported from services/index.ts', () => {
    const src = readSrc('src/services/index.ts');
    assert.ok(src.includes("'./reits'"), 'Services barrel must export reits');
  });

  it('REIT data loading exists in data-loader.ts', () => {
    const src = readSrc('src/app/data-loader.ts');
    assert.ok(src.includes('loadReits'), 'data-loader must have loadReits method');
    assert.ok(src.includes('fetchReitQuotes'), 'data-loader must import fetchReitQuotes');
    assert.ok(src.includes('fetchReitCorrelation'), 'data-loader must import fetchReitCorrelation');
  });

  it('REIT Redis keys are in health.js', () => {
    const src = readSrc('api/health.js');
    assert.ok(src.includes('reitQuotes'), 'health.js must include reitQuotes key');
    assert.ok(src.includes('reitCorrelation'), 'health.js must include reitCorrelation key');
    assert.ok(src.includes('reitProperties'), 'health.js must include reitProperties key');
    assert.ok(src.includes('reitSocial'), 'health.js must include reitSocial key');
  });

  it('REIT cache tiers are in gateway.ts', () => {
    const src = readSrc('server/gateway.ts');
    assert.ok(src.includes('/api/reits/v1/list-reit-quotes'), 'gateway must have list-reit-quotes cache tier');
    assert.ok(src.includes('/api/reits/v1/get-reit-correlation'), 'gateway must have get-reit-correlation cache tier');
    assert.ok(src.includes('/api/reits/v1/list-reit-properties'), 'gateway must have list-reit-properties cache tier');
    assert.ok(src.includes('/api/reits/v1/get-reit-social-sentiment'), 'gateway must have get-reit-social-sentiment cache tier');
  });

  it('reits DataSourceId exists in types', () => {
    const src = readSrc('src/types/index.ts');
    assert.ok(src.includes("'reits'"), 'DataSourceId must include reits');
  });

  it('REIT i18n strings exist', () => {
    const en = JSON.parse(readSrc('src/locales/en.json'));
    assert.ok(en.panels.reits, 'i18n must have panels.reits');
    assert.ok(en.panels.reitCorrelation, 'i18n must have panels.reitCorrelation');
    assert.ok(en.panels.reitSocial, 'i18n must have panels.reitSocial');
  });

  it('all variant configs include reitProperties in MapLayers', () => {
    const variants = ['full', 'tech', 'finance', 'commodity', 'happy'];
    for (const v of variants) {
      const src = readSrc(`src/config/variants/${v}.ts`);
      assert.ok(src.includes('reitProperties'), `${v} variant must include reitProperties in MapLayers`);
    }
  });
});
