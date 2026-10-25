import {
  escapeHtml,
  finiteNumber,
  formatStaticDateTime,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';

const LISTED_OUTAGES = 15;
// The seed runs every 30 minutes and health flags it after 30 (api/health.js
// outages). Retention can keep a list alive after Radar fails; past this age
// it is not current.
const MAX_AGE_MS = 2 * 3_600_000;

// The seeder sets severity from Cloudflare's scope (scripts/seed-internet-outages.mjs):
// nationwide is TOTAL, regional is MAJOR, anything narrower is PARTIAL.
const SEVERITY_LABELS = {
  OUTAGE_SEVERITY_TOTAL: 'Nationwide',
  OUTAGE_SEVERITY_MAJOR: 'Regional',
  OUTAGE_SEVERITY_PARTIAL: 'Network',
};

// Cloudflare Radar tags each disruption with its cause in upper case.
const CAUSE_LABELS = {
  'POWER OUTAGE': 'Power outage',
  'CABLE CUT': 'Cable cut',
  'GOVERNMENT DIRECTED': 'Government directed',
  'NATURAL DISASTER': 'Natural disaster',
  'MILITARY ACTION': 'Military action',
  'TECHNICAL PROBLEM': 'Technical problem',
  WEATHER: 'Weather',
  MAINTENANCE: 'Maintenance',
  'CYBER ATTACK': 'Cyberattack',
};

function causeOf(outage) {
  const categories = Array.isArray(outage.categories) ? outage.categories : [];
  const tag = categories.find((category) => CAUSE_LABELS[category]);
  return tag ? CAUSE_LABELS[tag] : null;
}

/**
 * `fetchedAt` is when the seeder last read Cloudflare Radar. The handler fails
 * (and the page keeps its built reading) when the seed is missing, so an empty
 * list here is a real "no disruptions" reading.
 */
export function internetOutagesRecord(payload, now = Date.now()) {
  if (!Array.isArray(payload?.outages)) throw new UnpublishableReading('internet outages: no outage list');
  const asOf = requireFreshTimestamp(payload.fetchedAt, { now, maxAgeMs: MAX_AGE_MS, label: 'internet outages' });
  const outages = payload.outages
    .map((outage) => {
      const detectedAt = finiteNumber(outage.detectedAt);
      const endedAt = finiteNumber(outage.endedAt);
      if (!detectedAt || !outage.country) return null;
      return {
        country: String(outage.country),
        severity: SEVERITY_LABELS[outage.severity] || 'Reported',
        cause: causeOf(outage),
        detectedAt: new Date(detectedAt).toISOString(),
        ongoing: !endedAt || endedAt > now,
        description: String(outage.description || '').trim(),
        link: /^https:\/\//.test(outage.link || '') ? outage.link : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  return {
    asOf,
    total: outages.length,
    ongoing: outages.filter((outage) => outage.ongoing).length,
    countries: new Set(outages.map((outage) => outage.country)).size,
    oldest: outages.at(-1)?.detectedAt ?? null,
    outages: outages.slice(0, LISTED_OUTAGES),
  };
}

export function internetOutagesAnswer(record) {
  if (!record) return 'World Monitor has no current internet outage reading.';
  if (record.total === 0) return `As of ${formatStaticDateTime(record.asOf)}, World Monitor lists no internet disruptions in the current Cloudflare Radar window.`;
  const latest = record.outages[0];
  const disruptions = record.total === 1 ? '1 internet disruption' : `${record.total} internet disruptions`;
  const countries = record.countries === 1 ? '1 country' : `${record.countries} countries`;
  const status = record.total === 1 ? (record.ongoing ? 'still ongoing' : 'now ended') : `${record.ongoing} of them ongoing`;
  return `As of ${formatStaticDateTime(record.asOf)}, World Monitor lists ${disruptions} in ${countries} reported by Cloudflare Radar since ${formatStaticDateTime(record.oldest)}, ${status}. ${record.total === 1 ? 'It was' : 'The most recent is'} a ${latest.severity.toLowerCase()} disruption in ${latest.country}${latest.cause ? ` (${latest.cause.toLowerCase()})` : ''}, detected ${formatStaticDateTime(latest.detectedAt)}.`;
}

/** The metrics and the most recent rows; `rows` caps the table for a page that shows a digest of the list. */
export function internetOutagesBody(record, { rows: rowLimit = LISTED_OUTAGES } = {}) {
  if (!record) return '        <p class="tool-note">Open the live dashboard for the internet outage map.</p>';
  const rows = record.outages
    .slice(0, rowLimit)
    .map((outage) => `            <tr><td>${escapeHtml(formatStaticDateTime(outage.detectedAt))}</td><td>${escapeHtml(outage.country)}</td><td>${escapeHtml(outage.severity)}${outage.ongoing ? ', ongoing' : ''}</td><td>${escapeHtml(outage.cause || '—')}</td><td>${outage.description ? escapeHtml(outage.description) : '—'}${outage.link ? ` <a href="${escapeHtml(outage.link)}" rel="nofollow">Source</a>` : ''}</td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metric('Disruptions listed', String(record.total))}
${metric('Ongoing', String(record.ongoing))}
${metric('Countries affected', String(record.countries))}
        </div>
${record.total === 0 ? '' : `        <div class="table-scroll">
          <table>
            <caption>Most recent internet disruptions</caption>
            <thead><tr><th scope="col">Detected</th><th scope="col">Country</th><th scope="col">Scope</th><th scope="col">Cause</th><th scope="col">What happened</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`}`;
}

export const internetOutagesPage = Object.freeze({
  slug: 'internet-outages',
  path: '/tools/internet-outages/',
  statusPath: '/api/infrastructure/v1/list-internet-outages?public=1',
  title: 'Internet Outages Today: Country-Level Disruptions Worldwide | World Monitor',
  h1: 'Internet outages around the world',
  question: 'Where is the internet down right now?',
  description: 'Current internet disruptions worldwide from Cloudflare Radar: the country, how wide each outage is, its cause, and whether it is still ongoing, updated live.',
  dashboardPanel: 'Internet Outages map layer',
  record: internetOutagesRecord,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: internetOutagesAnswer(record),
      bodyHtml: internetOutagesBody(record),
      asOf: record?.asOf,
      sourceHtml: 'Source: Cloudflare Radar outage center (<a href="https://radar.cloudflare.com/outage-center" rel="nofollow">radar.cloudflare.com</a>).',
    });
  },
  explainer: `      <h2>What this page tracks</h2>
      <p>These are disruptions to a country's or a region's internet connectivity as confirmed by Cloudflare Radar: nationwide shutdowns, regional cuts and network-level failures, with the cause Cloudflare assigns, such as a power outage, a cable cut, a government-directed shutdown or military action. It does not track individual websites or apps going down, or a single home connection.</p>
      <h2>How to read the scope</h2>
      <p>Scope is how widely Cloudflare reports the disruption: nationwide, regional, or limited to one or more networks such as a single provider. It describes reach, not how far traffic fell. "Ongoing" means Cloudflare has not yet reported an end time.</p>`,
});
