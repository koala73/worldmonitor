import {
  escapeHtml,
  finiteNumber,
  formatStaticDateTime,
  formatUsdCompact,
  formatUsdWhole,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';
import ISO2_TO_ISO3 from '../../shared/iso2-to-iso3.js';

// Monthly seed; health allows 60 days (api/health.js nationalDebt).
const MAX_AGE_MS = 60 * 24 * 3_600_000;
const TOP_COUNTRIES = 10;

// Inverted from the JS map: Vercel's middleware bundler rejects JSON import
// attributes, and this module is bundled into middleware.ts.
const ISO3_TO_ISO2 = Object.fromEntries(Object.entries(ISO2_TO_ISO3).map(([iso2, iso3]) => [iso3, iso2]));

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(iso3) {
  const iso2 = ISO3_TO_ISO2[iso3];
  if (!iso2) return iso3;
  try {
    return COUNTRY_NAMES.of(iso2) || iso3;
  } catch {
    return iso3;
  }
}

/** The dashboard panel's own extrapolation (src/components/NationalDebtPanel.ts). */
export function debtAt(entry, now) {
  const base = finiteNumber(entry.debtUsd) ?? 0;
  const rate = finiteNumber(entry.perSecondRate);
  const baselineTs = finiteNumber(entry.baselineTs);
  if (!rate || !baselineTs) return base;
  return base + rate * ((now - baselineTs) / 1000);
}

export function nationalDebtRecord(payload, now = Date.now()) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (entries.length === 0) throw new UnpublishableReading('national debt: no entries');
  const seededAt = requireFreshTimestamp(payload.seededAt, { now, maxAgeMs: MAX_AGE_MS, label: 'national debt' });
  const countries = entries
    .map((entry) => ({
      iso3: String(entry.iso3 || ''),
      debtUsd: debtAt(entry, now),
      debtToGdp: finiteNumber(entry.debtToGdp),
      perSecondUsd: finiteNumber(entry.perSecondRate) ?? 0,
      source: String(entry.source || ''),
    }))
    .filter((country) => country.iso3 && country.debtUsd > 0);
  const us = countries.find((country) => country.iso3 === 'USA');
  if (!us) throw new UnpublishableReading('national debt: no United States entry');
  const top = [...countries].sort((a, b) => b.debtUsd - a.debtUsd).slice(0, TOP_COUNTRIES)
    .map((country) => ({ ...country, name: countryName(country.iso3) }));
  return {
    asOf: new Date(now).toISOString(),
    seededAt,
    countryCount: countries.length,
    worldDebtUsd: countries.reduce((sum, country) => sum + country.debtUsd, 0),
    us: { ...us, name: 'United States' },
    top,
  };
}

function answerText(record) {
  if (!record) return 'World Monitor has no current national debt estimate. The seeded IMF data is older than 60 days or unavailable.';
  return `As of ${formatStaticDateTime(record.asOf)}, World Monitor estimates US government debt at ${formatUsdCompact(record.us.debtUsd)}, growing by about ${formatUsdWhole(record.us.perSecondUsd)} per second, and total government debt across ${record.countryCount} countries at ${formatUsdCompact(record.worldDebtUsd)}. The estimate extrapolates the latest IMF figures by each country's projected deficit.`;
}

function bodyHtml(record) {
  if (!record) return '        <p class="tool-note">Open the live dashboard for the running national debt clock.</p>';
  const rows = record.top
    .map((country, index) => `            <tr><td>${index + 1}</td><td>${escapeHtml(country.name)}</td><td>${escapeHtml(formatUsdCompact(country.debtUsd))}</td><td>${country.debtToGdp !== null ? `${country.debtToGdp.toFixed(1)}%` : '—'}</td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metric('US government debt', formatUsdCompact(record.us.debtUsd), `${formatUsdWhole(record.us.perSecondUsd)} per second`)}
${metric('US debt to GDP', record.us.debtToGdp !== null ? `${record.us.debtToGdp.toFixed(1)}%` : '—')}
${metric(`Government debt, ${record.countryCount} countries`, formatUsdCompact(record.worldDebtUsd))}
        </div>
        <div class="table-scroll">
          <table>
            <caption>Largest government debts, estimated at the time above</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Country</th><th scope="col">Government debt</th><th scope="col">Debt to GDP</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`;
}

export const nationalDebtPage = Object.freeze({
  slug: 'national-debt-clock',
  path: '/tools/national-debt-clock/',
  statusPath: '/api/economic/v1/get-national-debt?public=1',
  title: 'National Debt Clock: US and World Government Debt Today | World Monitor',
  h1: 'National debt clock',
  question: 'How much is the US national debt right now?',
  description: 'US and world government debt estimated to the second from IMF World Economic Outlook data, with debt-to-GDP and the largest national debts, updated live.',
  dashboardPanel: 'National Debt',
  record: nationalDebtRecord,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: answerText(record),
      bodyHtml: bodyHtml(record),
      asOf: record?.asOf,
      sourceHtml: `Source: IMF World Economic Outlook (<a href="https://www.imf.org/en/Publications/WEO" rel="nofollow">imf.org</a>)${record?.us.source.includes('Treasury') ? '; US Treasury FiscalData (<a href="https://fiscaldata.treasury.gov/" rel="nofollow">fiscaldata.treasury.gov</a>)' : ''}. IMF data captured ${record ? escapeHtml(formatStaticDateTime(record.seededAt)) : 'when available'}.`,
    });
  },
  explainer: `      <h2>How the clock is estimated</h2>
      <p>World Monitor starts from each country's government debt-to-GDP ratio and GDP in the IMF World Economic Outlook, which measures debt at the end of its reporting period. A country running a deficit accrues debt at its projected annual deficit spread evenly over the year, reaching the IMF figure at the period end; a country in surplus does not tick upward.</p>
      <p>Egypt's verified fiscal period ends on June 30 of the WEO-labelled year. India's ends on March 31 of the following year. The clock uses midnight UTC immediately after each period ends. Other countries use the December 31 calendar-year fallback. When US Treasury FiscalData is available, it replaces the IMF figure for the United States and the clock starts from its record date.</p>
      <p>The result is an estimate, not an official count: official debt figures move in steps when governments borrow and repay.</p>
      <h2>What counts as government debt</h2>
      <p>The IMF measure is general government gross debt: central, state and local government and social security funds. It is broader than the US "debt subject to limit" and is not netted against government-held assets.</p>`,
});
