import {
  escapeHtml,
  finiteNumber,
  formatStaticDate,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';

// EIA reports the week ending Friday on the following Wednesday, a day later
// after a federal holiday, so the latest week is up to 13 days old on a normal
// schedule. 21 days tolerates one missed report.
const MAX_AGE_MS = 21 * 24 * 3_600_000;
const EU_GAS_MAX_AGE_MS = 4 * 24 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

function weekMs(period) {
  return typeof period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(period) ? Date.parse(`${period}T00:00:00Z`) : NaN;
}

function newestFirst(weeks, valueKey) {
  return (Array.isArray(weeks) ? weeks : [])
    .map((week) => ({ period: week?.period, ms: weekMs(week?.period), value: finiteNumber(week?.[valueKey]) }))
    .filter((week) => Number.isFinite(week.ms) && week.value !== null && week.value > 0)
    .sort((left, right) => right.ms - left.ms);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function euGasReading(euGas, now) {
  const history = (Array.isArray(euGas?.history) ? euGas.history : [])
    .map((day) => ({ ms: weekMs(day?.date), fillPct: finiteNumber(day?.fillPct) }))
    .filter((day) => Number.isFinite(day.ms) && day.fillPct !== null && day.fillPct > 0)
    .sort((left, right) => right.ms - left.ms);
  const latest = history[0];
  if (!latest || now - latest.ms > EU_GAS_MAX_AGE_MS) return null;
  return { date: new Date(latest.ms).toISOString(), fillPct: round1(latest.fillPct) };
}

export function crudeOilInventoriesRecord(payload, now = Date.now()) {
  const crude = newestFirst(payload?.crudeWeeks, 'stocksMb');
  if (crude.length === 0) throw new UnpublishableReading('crude inventories: no weeks');
  const asOf = requireFreshTimestamp(crude[0].ms, { now, maxAgeMs: MAX_AGE_MS, label: 'crude inventories' });
  const changes = new Map((payload.crudeWeeks || []).map((week) => [week?.period, finiteNumber(week?.weeklyChangeMb)]));
  const spr = newestFirst(payload?.spr?.weeks, 'stocksMb');
  const sprByPeriod = new Map(spr.map((week) => [week.period, week.value]));
  const gas = newestFirst(payload?.natGasWeeks, 'storBcf');
  const latestPeriod = crude[0].period;
  // A section from another report week would put two dates behind one claim.
  const sameWeek = (weeks) => (weeks[0]?.period === latestPeriod ? weeks[0] : null);
  const sprLatest = sameWeek(spr);
  // The producer skips invalid rows, so the next record can be two weeks back.
  const sprPrior = sprLatest && spr[1]?.ms === sprLatest.ms - WEEK_MS ? spr[1] : null;
  const gasLatest = sameWeek(gas);
  const refinery = payload?.refinery?.period === latestPeriod ? finiteNumber(payload.refinery.inputsMbpd) : null;
  return {
    asOf,
    crudeMb: round1(crude[0].value),
    crudeChangeMb: changes.get(latestPeriod) ?? null,
    sprMb: sprLatest ? round1(sprLatest.value) : null,
    sprChangeMb: sprLatest && sprPrior ? round1(sprLatest.value - sprPrior.value) : null,
    refineryMbpd: refinery !== null && refinery > 0 ? round1(refinery) : null,
    natGasBcf: gasLatest ? Math.round(gasLatest.value) : null,
    euGas: euGasReading(payload?.euGas, now),
    weeks: crude.slice(0, 8).map((week) => ({
      period: week.period,
      crudeMb: round1(week.value),
      changeMb: changes.get(week.period) ?? null,
      sprMb: sprByPeriod.has(week.period) ? round1(sprByPeriod.get(week.period)) : null,
    })),
  };
}

function changeText(changeMb, unit) {
  const rounded = round1(changeMb);
  if (rounded === 0) return 'unchanged from the prior week';
  return `${rounded > 0 ? 'up' : 'down'} ${Math.abs(rounded).toFixed(1)} ${unit} from the prior week`;
}

function signed(value) {
  if (value === null) return '';
  const rounded = round1(value);
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

function weekNote(changeMb) {
  if (changeMb === null) return '';
  return round1(changeMb) === 0 ? 'Unchanged on the week' : `${signed(changeMb)}M bbl on the week`;
}

function answerText(record) {
  if (!record) return 'World Monitor has no current US crude oil inventory reading. The latest EIA week is older than 21 days or unavailable.';
  const crude = `For the week ending ${formatStaticDate(record.asOf)}, US commercial crude oil inventories were ${record.crudeMb.toFixed(1)} million barrels${record.crudeChangeMb !== null ? `, ${changeText(record.crudeChangeMb, 'million barrels')}` : ''}, according to the EIA.`;
  const parts = [crude];
  if (record.sprMb !== null) parts.push(`The Strategic Petroleum Reserve held ${record.sprMb.toFixed(1)} million barrels.`);
  if (record.natGasBcf !== null) parts.push(`US working natural gas in storage was ${record.natGasBcf.toLocaleString('en-US')} billion cubic feet.`);
  return parts.join(' ');
}

function bodyHtml(record) {
  if (!record) return '        <p class="tool-note">Open the live dashboard for the latest oil and gas inventory panel.</p>';
  const metrics = [
    metric('Commercial crude', `${record.crudeMb.toFixed(1)}M bbl`, weekNote(record.crudeChangeMb)),
    record.sprMb !== null ? metric('Strategic Petroleum Reserve', `${record.sprMb.toFixed(1)}M bbl`, weekNote(record.sprChangeMb)) : '',
    record.refineryMbpd !== null ? metric('Refinery crude inputs', `${record.refineryMbpd.toFixed(1)}M bbl/day`) : '',
    record.natGasBcf !== null ? metric('US natural gas storage', `${record.natGasBcf.toLocaleString('en-US')} Bcf`) : '',
    record.euGas ? metric('EU gas storage', `${record.euGas.fillPct}% full`, `GIE AGSI+, ${formatStaticDate(record.euGas.date)}`) : '',
  ].filter(Boolean).join('\n');
  const rows = record.weeks
    .map((week) => `            <tr><td>${escapeHtml(formatStaticDate(week.period))}</td><td>${week.crudeMb.toFixed(1)}</td><td>${week.changeMb !== null ? signed(week.changeMb) : 'n/a'}</td><td>${week.sprMb !== null ? week.sprMb.toFixed(1) : 'n/a'}</td></tr>`)
    .join('\n');
  return `        <div class="grid">
${metrics}
        </div>
        <div class="table-scroll">
          <table>
            <caption>US crude oil stocks by report week, in millions of barrels</caption>
            <thead><tr><th scope="col">Week ending</th><th scope="col">Commercial crude</th><th scope="col">Weekly change</th><th scope="col">SPR</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`;
}

export const crudeOilInventoriesPage = Object.freeze({
  slug: 'crude-oil-inventories',
  path: '/tools/crude-oil-inventories/',
  statusPath: '/api/economic/v1/get-oil-inventories?public=1',
  title: 'Crude Oil Inventories This Week: EIA US Stocks and SPR | World Monitor',
  h1: 'US crude oil inventories this week',
  question: 'What are US crude oil inventories this week?',
  description: 'The latest weekly EIA figures for US commercial crude oil stocks and the Strategic Petroleum Reserve, with refinery inputs, US natural gas storage and EU gas storage.',
  dashboardPanel: 'Oil Inventories',
  record: crudeOilInventoriesRecord,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: answerText(record),
      bodyHtml: bodyHtml(record),
      asOf: record?.asOf,
      dateOnly: true,
      sourceHtml: `Source: US Energy Information Administration, Weekly Petroleum Status Report and Weekly Natural Gas Storage Report (<a href="https://www.eia.gov/petroleum/supply/weekly/" rel="nofollow">eia.gov</a>)${record?.euGas ? '; EU gas storage from GIE AGSI+ (<a href="https://agsi.gie.eu/" rel="nofollow">agsi.gie.eu</a>)' : ''}.`,
    });
  },
  explainer: `      <h2>What the weekly inventory report measures</h2>
      <p>Every week the US Energy Information Administration surveys refiners, terminals and pipelines and reports how much crude oil is held in commercial storage across the country. The figure above excludes the Strategic Petroleum Reserve, which is shown separately. The report covers the week ending Friday and is usually published the following Wednesday.</p>
      <h2>Why traders watch it</h2>
      <p>A larger draw than expected suggests demand is outrunning supply and tends to lift oil prices; a build suggests the opposite. Refinery inputs show how hard US refiners are running, and the Strategic Petroleum Reserve shows the government's emergency stock, which is drawn down or refilled by policy rather than by the market.</p>
      <h2>Natural gas storage</h2>
      <p>The EIA reports working natural gas in underground storage each Thursday, in billion cubic feet. Europe's storage fill level comes from Gas Infrastructure Europe's AGSI+ platform and is updated daily.</p>`,
});
