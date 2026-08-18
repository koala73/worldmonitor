import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import {
  buildPhysicalPremiumPayload,
  convertSgePriceToUsdPerOz,
  fetchSgeHtml,
  parseSeedTargetArgs,
  parseSgeBenchmarkHtml,
  physicalPremiumActivationWrite,
  shouldWritePhysicalPremiumActivationMarker,
  validatePhysicalPremiumPayload,
} from '../scripts/seed-physical-premiums.mjs';

const fixture = (name) => readFileSync(
  resolve(import.meta.dirname, 'fixtures/physical-premiums', name),
  'utf8',
);

const goldHtml = fixture('sge-gold-daily.html');
const silverHtml = fixture('sge-silver-daily.html');

describe('physical premium seed', () => {
  it('parses the latest PM prints from real SGE response fixtures', () => {
    const gold = parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' });
    const silver = parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' });

    assert.equal(gold.length, 7);
    assert.deepEqual(gold[0], {
      asOf: '2026-08-18',
      contract: 'SHAU',
      amPrice: 953.79,
      pmPrice: 953.88,
      price: 953.88,
      session: 'PM',
      currency: 'CNY',
      unit: 'gram',
    });
    assert.equal(silver[0].price, 15941);
    assert.equal(silver[0].unit, 'kilogram');
  });

  it('labels an AM fallback as AM when the PM print is absent', () => {
    const html = `
      <table>
        <tr><th>Trade Date</th><th>Contract</th><th>Benchmark Price AM</th><th>Benchmark Price PM</th></tr>
        <tr><td>20260818</td><td>SHAU</td><td>953.79</td><td></td></tr>
      </table>`;
    const [row] = parseSgeBenchmarkHtml(html, { contract: 'SHAU', unit: 'gram' });
    assert.equal(row.session, 'AM');
    const payload = buildPhysicalPremiumPayload({
      goldRows: [row],
      silverRows: [{ ...row, contract: 'SHAG', unit: 'kilogram', price: 15941 }],
      commodityQuotes: { quotes: [{ symbol: 'GC=F', price: 4455.6 }, { symbol: 'SI=F', price: 65.31 }] },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:30:00.000Z',
    });
    assert.equal(payload.premiums[0].physical.source, 'Shanghai Gold Exchange SHAU AM benchmark');
  });

  it('rejects oversized and off-origin SGE responses before parsing', async () => {
    const headers = new Headers({ 'content-type': 'text/html', 'content-length': '256001' });
    await assert.rejects(
      fetchSgeHtml('https://en.sge.com.cn/data', 'SHAU', async () => ({
        ok: true, url: 'https://en.sge.com.cn/data', headers, text: async () => '<table></table>',
      })),
      /exceeds 256 KB/,
    );
    await assert.rejects(
      fetchSgeHtml('https://en.sge.com.cn/data', 'SHAU', async () => ({
        ok: true, url: 'https://example.com/data', headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<table></table>',
      })),
      /Unexpected SHAU response origin/,
    );
  });

  it('uses the official SHAU gram and SHAG kilogram units in the troy-ounce conversion', () => {
    assert.ok(Math.abs(convertSgePriceToUsdPerOz(953.88, 'gram', 0.1486) - 4408.811089267622) < 1e-9);
    assert.ok(Math.abs(convertSgePriceToUsdPerOz(15941, 'kilogram', 0.1486) - 73.67892981718369) < 1e-9);
  });

  it('builds auditable physical and paper legs plus the derived premiums', () => {
    const payload = buildPhysicalPremiumPayload({
      goldRows: parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' }),
      silverRows: parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' }),
      commodityQuotes: {
        quotes: [
          { symbol: 'GC=F', price: 4455.6 },
          { symbol: 'SI=F', price: 65.31 },
        ],
      },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:30:00.000Z',
    });

    assert.equal(payload.premiums.length, 2);
    assert.deepEqual(payload.premiums[0].physical, {
      price: 953.88,
      currency: 'CNY',
      unit: 'gram',
      source: 'Shanghai Gold Exchange SHAU PM benchmark',
      asOf: '2026-08-18',
    });
    assert.deepEqual(payload.premiums[0].paper, {
      price: 4455.6,
      source: 'COMEX GC=F futures snapshot',
      asOf: '2026-08-18T12:30:00.000Z',
    });
    assert.equal(payload.premiums[0].premiumUsdPerOz, -46.7889);
    assert.equal(payload.premiums[0].premiumPct, -1.0501);
    assert.equal(payload.premiums[1].premiumUsdPerOz, 8.3689);
    assert.equal(payload.premiums[1].premiumPct, 12.8142);
    assert.deepEqual(payload.fx, {
      pair: 'CNY/USD',
      rate: 0.1486,
      source: 'shared:fx-rates:v1',
      asOf: '2026-08-18T12:30:00.000Z',
    });
    assert.equal(validatePhysicalPremiumPayload(payload), true);
  });

  it('fails closed on changed SGE markup', () => {
    assert.throws(
      () => parseSgeBenchmarkHtml('<table><tr><td>changed format</td></tr></table>', { contract: 'SHAU', unit: 'gram' }),
      /SHAU benchmark/,
    );
  });

  it('scopes non-production keys by environment and revision', () => {
    assert.deepEqual(parseSeedTargetArgs([]), { env: 'production', sha: '' });
    assert.deepEqual(
      parseSeedTargetArgs(['--env', 'preview', '--sha', 'abc123']),
      { env: 'preview', sha: 'abc123' },
    );
    assert.deepEqual(
      parseSeedTargetArgs(['--env=development']),
      { env: 'development', sha: 'dev' },
    );
    assert.throws(() => parseSeedTargetArgs(['--env=staging']), /Invalid --env/);
  });

  it('writes the unprefixed activation marker only for production publishes', () => {
    assert.equal(shouldWritePhysicalPremiumActivationMarker('production'), true);
    assert.equal(shouldWritePhysicalPremiumActivationMarker('preview'), false);
    assert.equal(shouldWritePhysicalPremiumActivationMarker('development'), false);
    assert.deepEqual(
      physicalPremiumActivationWrite('production'),
      ['SET', 'seed-activated:market:physical-premium', '1'],
    );
    assert.equal(physicalPremiumActivationWrite('preview'), null);
    assert.equal(physicalPremiumActivationWrite('development'), null);
    assert.equal(
      physicalPremiumActivationWrite(parseSeedTargetArgs(['--env', 'preview']).env),
      null,
    );
    assert.equal(
      physicalPremiumActivationWrite(parseSeedTargetArgs(['--env=development']).env),
      null,
    );
  });
});
