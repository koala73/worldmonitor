import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBudgetLabEffectiveTariffHtml, toIsoDate, htmlToPlainText, BUDGET_LAB_TARIFFS_URL } from '../scripts/_trade-parse-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const protoSrc = readFileSync(join(root, 'proto/worldmonitor/trade/v1/get_tariff_trends.proto'), 'utf-8');
const tradeDataProtoSrc = readFileSync(join(root, 'proto/worldmonitor/trade/v1/trade_data.proto'), 'utf-8');
const seedSrc = readFileSync(join(root, 'scripts/seed-supply-chain-trade.mjs'), 'utf-8');
const panelSrc = readFileSync(join(root, 'src/components/TradePolicyPanel.ts'), 'utf-8');
const serviceSrc = readFileSync(join(root, 'src/services/trade/index.ts'), 'utf-8');
const clientGeneratedSrc = readFileSync(join(root, 'src/generated/client/worldmonitor/trade/v1/service_client.ts'), 'utf-8');
const serverGeneratedSrc = readFileSync(join(root, 'src/generated/server/worldmonitor/trade/v1/service_server.ts'), 'utf-8');

describe('Trade tariff proto contract', () => {
  it('adds EffectiveTariffRate message to shared trade data', () => {
    assert.match(tradeDataProtoSrc, /message EffectiveTariffRate/);
    assert.match(tradeDataProtoSrc, /string source_name = 1;/);
    assert.match(tradeDataProtoSrc, /double tariff_rate = 5;/);
  });

  it('adds optional effective_tariff_rate to GetTariffTrendsResponse', () => {
    assert.match(protoSrc, /EffectiveTariffRate effective_tariff_rate = 4;/);
  });
});

describe('Generated tariff types', () => {
  it('client types expose an optional effectiveTariffRate snapshot', () => {
    assert.match(clientGeneratedSrc, /effectiveTariffRate\?: EffectiveTariffRate/);
  });

  it('server types expose an optional effectiveTariffRate snapshot', () => {
    assert.match(serverGeneratedSrc, /effectiveTariffRate\?: EffectiveTariffRate/);
  });

  it('trade service re-exports EffectiveTariffRate', () => {
    assert.match(serviceSrc, /export type \{[^}]*EffectiveTariffRate/);
  });
});

describe('FRED effective tariff rate seed integration', () => {
  it('uses FRED customs duties and imports of goods series', () => {
    assert.match(seedSrc, /B235RC1Q027SBEA/);
    assert.match(seedSrc, /A255RC1Q027SBEA/);
  });

  it('attaches the effective tariff snapshot only to the US tariff payload', () => {
    assert.match(seedSrc, /reporter === '840' && usEffectiveTariffRate/);
  });

  it('keeps restrictions snapshot labeled as WTO MFN baseline data', () => {
    assert.match(seedSrc, /measureType: 'WTO MFN Baseline'/);
    assert.match(seedSrc, /description: `WTO MFN baseline: \$\{value\.toFixed\(1\)\}%`/);
  });
});

describe('parseBudgetLabEffectiveTariffHtml — pattern 1 (rate reaching … in period)', () => {
  it('parses tariff rate, observation period, and updated date', () => {
    const html = `
      <html><body>
        <div>Updated: March 2, 2026</div>
        <p>U.S. consumers face tariff changes, raising the effective tariff rate reaching 9.9% in December 2025.</p>
      </body></html>
    `;
    assert.deepEqual(parseBudgetLabEffectiveTariffHtml(html), {
      sourceName: 'Yale Budget Lab',
      sourceUrl: BUDGET_LAB_TARIFFS_URL,
      observationPeriod: 'December 2025',
      updatedAt: '2026-03-02',
      tariffRate: 9.9,
    });
  });

  it('rounds to 2 decimal places', () => {
    const html = '<p>effective tariff rate reaching 12.345% in January 2026</p>';
    assert.equal(parseBudgetLabEffectiveTariffHtml(html)?.tariffRate, 12.35);
  });
});

describe('parseBudgetLabEffectiveTariffHtml — pattern 2 (average effective … to X% … in period)', () => {
  it('parses rate and period via "average effective tariff rate … to X% … in" phrasing', () => {
    const html = `
      <html><body>
        <div>Updated: January 15, 2026</div>
        <p>Our estimates show the average effective U.S. tariff rate has risen to 18.5% in February 2026 from pre-tariff levels.</p>
      </body></html>
    `;
    const result = parseBudgetLabEffectiveTariffHtml(html);
    assert.ok(result, 'expected a non-null result for pattern 2');
    assert.equal(result.tariffRate, 18.5);
    assert.equal(result.observationPeriod, 'February 2026');
    assert.equal(result.updatedAt, '2026-01-15');
  });
});

describe('parseBudgetLabEffectiveTariffHtml — pattern 3 (rate without period)', () => {
  it('parses rate when observation period is absent, leaving observationPeriod empty', () => {
    const html = '<p>The average effective tariff rate has climbed to 22.1%.</p>';
    const result = parseBudgetLabEffectiveTariffHtml(html);
    assert.ok(result, 'expected a non-null result for pattern 3');
    assert.equal(result.tariffRate, 22.1);
    assert.equal(result.observationPeriod, '');
  });
});

describe('parseBudgetLabEffectiveTariffHtml — edge cases', () => {
  it('returns null when page contains no recognizable rate', () => {
    assert.equal(parseBudgetLabEffectiveTariffHtml('<html><body><p>No tariff data here.</p></body></html>'), null);
  });

  it('strips HTML tags before matching', () => {
    const html = '<p>effective tariff rate reaching <strong>7.5%</strong> in <em>March 2026</em></p>';
    const result = parseBudgetLabEffectiveTariffHtml(html);
    assert.ok(result);
    assert.equal(result.tariffRate, 7.5);
  });
});

describe('toIsoDate helper', () => {
  it('converts "March 2, 2026" to 2026-03-02', () => {
    assert.equal(toIsoDate('March 2, 2026'), '2026-03-02');
  });

  it('passes through an already-ISO date unchanged', () => {
    assert.equal(toIsoDate('2026-01-15'), '2026-01-15');
  });

  it('returns empty string for unparseable input', () => {
    assert.equal(toIsoDate('not a date'), '');
    assert.equal(toIsoDate(''), '');
  });
});

describe('Trade policy tariff panel', () => {
  it('renames the misleading Restrictions tab to Overview', () => {
    assert.match(panelSrc, /components\.tradePolicy\.overview/);
    assert.match(panelSrc, /components\.tradePolicy\.noOverviewData/);
  });

  it('labels the WTO series as an MFN baseline', () => {
    assert.match(panelSrc, /components\.tradePolicy\.baselineMfnTariff/);
    assert.match(panelSrc, /components\.tradePolicy\.mfnAppliedRate/);
  });

  it('shows effective tariff and gap cards when coverage exists', () => {
    assert.match(panelSrc, /components\.tradePolicy\.effectiveTariffRateLabel/);
    assert.match(panelSrc, /components\.tradePolicy\.gapLabel/);
    assert.match(panelSrc, /components\.tradePolicy\.effectiveMinusBaseline/);
  });

  it('keeps a graceful MFN-only fallback for countries without effective-rate coverage', () => {
    assert.match(panelSrc, /components\.tradePolicy\.noEffectiveCoverageForCountry/);
  });

  it('clarifies on the Restrictions tab that WTO figures are baselines, not live tariff burden', () => {
    assert.match(panelSrc, /components\.tradePolicy\.overviewNoteNoEffective/);
    assert.match(panelSrc, /components\.tradePolicy\.overviewNoteTail/);
  });

  it('adds inline US effective-rate context on the overview card', () => {
    assert.match(panelSrc, /renderRestrictionEffectiveContext/);
    assert.match(panelSrc, /components\.tradePolicy\.gapVsMfnLabel/);
  });
});
