#!/usr/bin/env node
// Deterministic generator for the /research/ report family (issue #5668).
//
// Consumes a committed transit snapshot (docs/snapshots/) plus a report
// definition (shared/research-reports/) and renders: the report page, the
// /research/ hub, and the machine-readable CSV/JSON downloads. Every
// quantitative value on the page is a computed metric with a documented
// observation period, transformation, and source; prose references metrics
// as {{m:<id>}} tokens and the build fails on an unresolved token so text can
// never drift from the data. No network access; inputs are repo files only.
//
// Template functions are injected by build-crawlable-corpus.mjs (the single
// owner of the corpus HTML shell) to avoid a circular import.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UMAMI_SCRIPT_TAG =
  '<script async defer src="https://abacus.worldmonitor.app/script.js" '
  + 'data-website-id="e8800335-16bc-4241-a133-0eb28c07c832" '
  + 'data-domains="worldmonitor.app,www.worldmonitor.app,happy.worldmonitor.app" '
  + 'nonce="wm-static-bootstrap"></script>';

const DATASET_LICENSE = {
  '@type': 'CreativeWork',
  name: 'World Monitor Terms of Service (27 July 2026)',
  url: 'https://www.worldmonitor.app/docs/terms',
};

const CHART_WIDTH = 720;
const LINE_CHART_HEIGHT = 260;
const BAR_CHART_HEIGHT = 240;
const CHART_MARGIN = { top: 18, right: 16, bottom: 34, left: 44 };

function round1(value) {
  return Math.round(value * 10) / 10;
}

// Throws rather than returning null: a fabricated 0.0 for an absent window is
// indistinguishable from a real blockade reading, so averaging nothing is a
// build failure, never a value.
export function mean(rows, field) {
  if (!rows.length) {
    throw new Error(`No rows to average for "${field}" — refusing to fabricate a value for missing data`);
  }
  return rows.reduce((total, row) => total + row[field], 0) / rows.length;
}

function inRange(history, start, end) {
  return history.filter((row) => row.date >= start && row.date <= end);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isIsoCalendarDate(value) {
  if (!ISO_DATE_PATTERN.test(value ?? '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertCompleteDailyCoverage(id, series) {
  const history = series?.history;
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error(`${id} has incomplete daily coverage: no observations`);
  }

  const start = series.observationStart;
  const end = series.observationEnd;
  if (!isIsoCalendarDate(start) || !isIsoCalendarDate(end) || start > end) {
    throw new Error(
      `${id} has incomplete daily coverage: invalid observation range ${start ?? 'unknown'} → ${end ?? 'unknown'}`,
    );
  }

  const present = new Set();
  let previousDate = null;
  for (const row of history) {
    const date = row?.date;
    if (!isIsoCalendarDate(date)) {
      throw new Error(`${id} has incomplete daily coverage: invalid observation date ${date ?? 'unknown'}`);
    }
    if (previousDate !== null && date <= previousDate) {
      throw new Error(
        `${id} has incomplete daily coverage: dates must be unique and ascending (${previousDate}, ${date})`,
      );
    }
    present.add(date);
    previousDate = date;
  }

  const missing = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (; cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (!present.has(date)) missing.push(date);
  }
  if (missing.length > 0) {
    const preview = missing.slice(0, 5).join(', ');
    const remainder = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
    throw new Error(`${id} has incomplete daily coverage: missing ${preview}${remainder}`);
  }

  if (history[0].date !== start || history.at(-1).date !== end) {
    throw new Error(
      `${id} has incomplete daily coverage: history bounds do not match ${start} → ${end}`,
    );
  }
  if (series.rowCount !== history.length) {
    throw new Error(
      `${id} has incomplete daily coverage: rowCount ${series.rowCount} does not match ${history.length} observations`,
    );
  }
  if (!Array.isArray(series.missingDates) || series.missingDates.length > 0) {
    throw new Error(
      `${id} has incomplete daily coverage: missingDates metadata must be an empty array`,
    );
  }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(isoMonth) {
  const [year, month] = isoMonth.split('-').map(Number);
  return `${SHORT_MONTHS[month - 1]} ${year}`;
}

function monthDayLabel(isoDate) {
  const [, month, day] = isoDate.split('-').map(Number);
  return `${SHORT_MONTHS[month - 1]} ${day}`;
}

// "Jul 1–19 2026" for an observation window that ends mid-month.
function partialRangeLabel(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${SHORT_MONTHS[month - 1]} 1–${day} ${year}`;
}

function formatInt(value) {
  return Math.round(value).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Compute every published figure for a chokepoint transit report. Each metric
 * carries the observation period, the transformation ("method"), and a
 * machine-readable raw value alongside its formatted display string, so the
 * page, the downloads, and the provenance table stay in agreement by
 * construction.
 */
// The metric windows below are the 2026-07 edition's analysis, not generic
// arithmetic. A future edition must update them deliberately; this tripwire
// turns "silently republish July's analysis under an August title" into a
// build failure.
const METRIC_WINDOWS_EDITION = '2026-07';

export function computeReportMetrics(snapshot, report) {
  if (report.edition !== METRIC_WINDOWS_EDITION || snapshot.edition !== report.edition) {
    throw new Error(
      `computeReportMetrics implements the ${METRIC_WINDOWS_EDITION} edition windows; `
      + `got report edition ${report.edition} with snapshot edition ${snapshot.edition}. `
      + 'Update the metric windows for the new edition before publishing.',
    );
  }
  const focus = snapshot.chokepoints[report.focusChokepointId];
  if (!focus) throw new Error(`Snapshot has no focus chokepoint ${report.focusChokepointId}`);
  const publishedSeriesIds = new Set([
    ...Object.keys(snapshot.chokepoints),
    report.focusChokepointId,
    ...(report.contextChokepointIds ?? []),
  ]);
  for (const id of publishedSeriesIds) {
    const series = snapshot.chokepoints[id];
    if (!series) throw new Error(`Snapshot has no published chokepoint ${id}`);
    assertCompleteDailyCoverage(id, series);
  }
  const history = focus.history;
  const observationEnd = focus.observationEnd;
  const capturedAtDate = String(snapshot.capturedAt).slice(0, 10);
  const source = `IMF PortWatch snapshot ${snapshot.snapshotId} (retrieved ${capturedAtDate})`;

  const metrics = new Map();
  const add = (id, metric) => {
    if (metrics.has(id)) throw new Error(`Duplicate metric id: ${id}`);
    metrics.set(id, { id, source, ...metric });
  };
  const addDailyAvg = (id, label, start, end, field = 'total', extra = {}) => {
    const rows = inRange(history, start, end);
    if (!rows.length) throw new Error(`No rows for metric ${id} (${start} → ${end})`);
    add(id, {
      label,
      kind: 'number',
      value: round1(mean(rows, field)),
      unit: 'transits/day',
      period: `${start} → ${end}`,
      method: `mean of daily ${field} transit calls`,
      ...extra,
    });
  };

  const feb = ['2026-02-01', '2026-02-28'];
  addDailyAvg('febAvgTotal', 'February 2026 daily average', ...feb);
  addDailyAvg('febAvgTanker', 'February 2026 tanker daily average', ...feb, 'tanker');
  addDailyAvg('avg2025Total', '2025 full-year daily average', '2025-01-01', '2025-12-31');
  addDailyAvg('marAvgTotal', 'March 2026 daily average', '2026-03-01', '2026-03-31');
  addDailyAvg('aprAvgTotal', 'April 2026 daily average', '2026-04-01', '2026-04-30');
  addDailyAvg('mayAvgTotal', 'May 2026 daily average', '2026-05-01', '2026-05-31');
  addDailyAvg('junAvgTotal', 'June 2026 daily average', '2026-06-01', '2026-06-30');
  addDailyAvg('junAvgTanker', 'June 2026 tanker daily average', '2026-06-01', '2026-06-30', 'tanker');
  addDailyAvg('jun25AvgTanker', 'June 2025 tanker daily average', '2025-06-01', '2025-06-30', 'tanker');
  addDailyAvg(
    'julToDateAvgTotal',
    'July 2026 daily average (partial month)',
    '2026-07-01',
    observationEnd,
  );

  const mar1 = inRange(history, '2026-03-01', '2026-03-01');
  if (!mar1.length) throw new Error('Snapshot is missing the 2026-03-01 observation required by mar1Total');
  add('mar1Total', {
    label: 'Transits on 2026-03-01',
    kind: 'count',
    value: mar1[0].total,
    unit: 'transits',
    period: '2026-03-01',
    method: 'daily total transit calls',
  });

  const disruption = inRange(history, '2026-03-01', observationEnd);
  const disruptionSum = disruption.reduce((total, row) => total + row.total, 0);
  add('disruptionDays', {
    label: 'Days in disruption window',
    kind: 'count',
    value: disruption.length,
    unit: 'days',
    period: `2026-03-01 → ${observationEnd}`,
    method: 'count of observed days',
  });
  add('disruptionTransits', {
    label: 'Total transits since 2026-03-01',
    kind: 'count',
    value: disruptionSum,
    unit: 'transits',
    period: `2026-03-01 → ${observationEnd}`,
    method: 'sum of daily total transit calls',
  });
  add('disruptionDailyAvg', {
    label: 'Daily average since 2026-03-01',
    kind: 'number',
    value: round1(disruptionSum / disruption.length),
    unit: 'transits/day',
    period: `2026-03-01 → ${observationEnd}`,
    method: 'sum of daily totals ÷ observed days',
  });

  const sameWindow2025 = inRange(history, '2025-03-01', observationEnd.replace('2026-', '2025-'));
  const sameWindow2025Sum = sameWindow2025.reduce((total, row) => total + row.total, 0);
  add('sameWindow2025Transits', {
    label: 'Total transits, same 2025 window',
    kind: 'count',
    value: sameWindow2025Sum,
    unit: 'transits',
    period: `2025-03-01 → ${observationEnd.replace('2026-', '2025-')}`,
    method: 'sum of daily total transit calls',
  });
  add('sameWindow2025DailyAvg', {
    label: 'Daily average, same 2025 window',
    kind: 'number',
    value: round1(sameWindow2025Sum / sameWindow2025.length),
    unit: 'transits/day',
    period: `2025-03-01 → ${observationEnd.replace('2026-', '2025-')}`,
    method: 'sum of daily totals ÷ observed days',
  });
  add('declinePct', {
    label: 'Transit decline vs same 2025 window',
    kind: 'percent',
    value: round1((1 - disruptionSum / sameWindow2025Sum) * 100),
    unit: '%',
    period: `2026-03-01 → ${observationEnd} vs 2025 equivalent`,
    method: '1 − (2026 window sum ÷ 2025 window sum)',
  });
  add('julVsFebShare', {
    label: 'July 2026 (partial) as share of February 2026',
    kind: 'percent-round',
    value: Math.round((metrics.get('julToDateAvgTotal').value / metrics.get('febAvgTotal').value) * 100),
    unit: '%',
    period: `2026-07-01 → ${observationEnd} vs 2026-02`,
    method: 'July partial-month daily average ÷ February daily average',
  });

  const marZero = inRange(history, '2026-03-01', '2026-03-31').filter((row) => row.total === 0);
  const allZero = disruption.filter((row) => row.total === 0);
  const preCollapse = history.filter((row) => row.date < '2026-03-01');
  add('marZeroDays', {
    label: 'Zero-transit days in March 2026',
    kind: 'count',
    value: marZero.length,
    unit: 'days',
    period: '2026-03-01 → 2026-03-31',
    method: 'count of days with total = 0',
  });
  add('zeroTransitDays', {
    label: 'Zero-transit days since 2026-03-01',
    kind: 'count',
    value: allZero.length,
    unit: 'days',
    period: `2026-03-01 → ${observationEnd}`,
    method: 'count of days with total = 0',
  });
  add('preCollapseMinTotal', {
    label: 'Pre-collapse daily minimum (2019 → February 2026)',
    kind: 'count',
    value: Math.min(...preCollapse.map((row) => row.total)),
    unit: 'transits',
    period: `${focus.observationStart} → 2026-02-28`,
    method: 'minimum daily total transit calls',
  });

  const peak = disruption.reduce((max, row) => (row.total > max.total ? row : max), { total: -1 });
  add('peakRecoveryDate', {
    label: 'Strongest day since the collapse',
    kind: 'date',
    value: peak.date,
    period: `2026-03-01 → ${observationEnd}`,
    method: 'date of maximum daily total',
  });
  add('peakRecoveryTotal', {
    label: 'Transits on the strongest post-collapse day',
    kind: 'count',
    value: peak.total,
    unit: 'transits',
    period: peak.date,
    method: 'daily total transit calls',
  });
  add('peakVsFebNote', {
    label: 'Strongest post-collapse day vs February average',
    kind: 'percent-round',
    value: Math.round((1 - peak.total / metrics.get('febAvgTotal').value) * 100),
    unit: '%',
    period: `${peak.date} vs 2026-02`,
    method: '1 − (peak daily total ÷ February daily average)',
  });

  const last7 = history.slice(-7);
  add('last7Avg', {
    label: 'Final observed week daily average',
    kind: 'number',
    value: round1(mean(last7, 'total')),
    unit: 'transits/day',
    period: `${last7[0].date} → ${observationEnd}`,
    method: 'mean of daily total transit calls',
  });

  const dwt = (id, label, start, end) => {
    const rows = inRange(history, start, end);
    add(id, {
      label,
      kind: 'number2',
      value: Math.round((mean(rows, 'capTanker') / 1e6) * 100) / 100,
      unit: 'million DWT/day',
      period: `${start} → ${end}`,
      method: 'mean of daily aggregate tanker deadweight tonnage ÷ 10⁶',
    });
  };
  dwt('febAvgTankerDwtM', 'February 2026 tanker capacity', '2026-02-01', '2026-02-28');
  dwt('junAvgTankerDwtM', 'June 2026 tanker capacity', '2026-06-01', '2026-06-30');

  add('observationEnd', {
    label: 'Observation window end',
    kind: 'date',
    value: observationEnd,
    period: observationEnd,
    method: 'latest date in the retrieved series',
  });
  add('capturedAtDate', {
    label: 'Snapshot retrieval date',
    kind: 'date',
    value: capturedAtDate,
    period: capturedAtDate,
    method: 'UTC date of the snapshot retrieval',
  });
  add('missingDatesTotal', {
    label: 'Missing days across all series',
    kind: 'count',
    value: Object.values(snapshot.chokepoints)
      .reduce((total, chokepoint) => total + chokepoint.missingDates.length, 0),
    unit: 'days',
    period: `${focus.observationStart} → ${observationEnd}`,
    method: 'sum of enumerated calendar gaps across snapshot series',
  });

  return metrics;
}

export function formatMetric(metric) {
  switch (metric.kind) {
    case 'number':
      return metric.value.toFixed(1);
    case 'number2':
      return metric.value.toFixed(2);
    case 'count':
      return formatInt(metric.value);
    case 'percent':
      return `${metric.value.toFixed(1)}%`;
    case 'percent-round':
      return `${formatInt(metric.value)}%`;
    case 'date':
      return metric.value;
    default:
      throw new Error(`Unknown metric kind: ${metric.kind}`);
  }
}

// Replace {{m:id}} tokens with <data>/<time> elements carrying the raw value,
// so tests can reconcile visible text, structured data, and downloads.
export function resolveMetricTokens(text, metrics, escapeHtml) {
  return String(text).replace(/\{\{m:([a-zA-Z0-9]+)\}\}/g, (_, id) => {
    const metric = metrics.get(id);
    if (!metric) throw new Error(`Unresolved metric token: ${id}`);
    const formatted = formatMetric(metric);
    if (metric.kind === 'date') {
      return `<time datetime="${escapeHtml(metric.value)}">${escapeHtml(metric.value)}</time>`;
    }
    return `<data data-metric="${escapeHtml(metric.id)}" value="${escapeHtml(String(metric.value))}">${escapeHtml(formatted)}</data>`;
  });
}

// Plain-text variant for surfaces that cannot carry markup (meta description,
// JSON-LD, alt text). Same fail-closed contract as resolveMetricTokens.
export function resolvePlainMetricTokens(text, metrics) {
  return String(text).replace(/\{\{m:([a-zA-Z0-9]+)\}\}/g, (_, id) => {
    const metric = metrics.get(id);
    if (!metric) throw new Error(`Unresolved metric token: ${id}`);
    return formatMetric(metric);
  });
}

// Backstop for tokens the resolver regex does not recognize (a snake_case or
// spaced id would otherwise ship literally): every rendered research document
// passes through this before being returned.
export function assertNoUnresolvedTokens(html) {
  const match = html.match(/\{\{m:[^}]*\}\}/);
  if (match) throw new Error(`Unresolved metric token in output: ${match[0]}`);
}

// ---------------------------------------------------------------------------
// Charts (inline SVG, no JavaScript requirement)
// ---------------------------------------------------------------------------

function svgScaleFactory(domainMax, plotWidth, plotHeight) {
  return {
    x: (index, count) => CHART_MARGIN.left + (index / Math.max(count - 1, 1)) * plotWidth,
    y: (value) => CHART_MARGIN.top + plotHeight - (value / domainMax) * plotHeight,
  };
}

function gridAndAxis(scale, domainMax, step, plotWidth) {
  const lines = [];
  for (let tick = 0; tick <= domainMax; tick += step) {
    const y = scale.y(tick);
    lines.push(
      `<line x1="${CHART_MARGIN.left}" y1="${y}" x2="${CHART_MARGIN.left + plotWidth}" y2="${y}" stroke="#1b2b22" stroke-width="1"/>`,
      `<text x="${CHART_MARGIN.left - 8}" y="${y + 4}" text-anchor="end" fill="#a8b8ad" font-size="11">${tick}</text>`,
    );
  }
  return lines.join('');
}

export function renderDailyLineChart(history, { title, description, collapseDate, escapeHtml }) {
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = LINE_CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const domainMax = 160;
  const scale = svgScaleFactory(domainMax, plotWidth, plotHeight);

  const points = history.map((row, index) => {
    const x = scale.x(index, history.length);
    const y = scale.y(Math.min(row.total, domainMax));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const monthTicks = history
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.date.endsWith('-01'))
    .map(({ row, index }) => {
      const x = scale.x(index, history.length);
      return `<text x="${x.toFixed(1)}" y="${LINE_CHART_HEIGHT - 12}" text-anchor="middle" fill="#a8b8ad" font-size="11">${monthLabel(row.date.slice(0, 7))}</text>`;
    })
    .join('');

  const collapseIndex = history.findIndex((row) => row.date === collapseDate);
  if (collapseIndex === -1) throw new Error(`Daily chart annotation date ${collapseDate} is not in the plotted series`);
  const collapseX = scale.x(collapseIndex, history.length);
  const peak = history.reduce(
    (max, row, index) => (row.date >= collapseDate && row.total > max.total ? { ...row, index } : max),
    { total: -1, index: -1 },
  );
  const peakX = scale.x(peak.index, history.length);
  const peakY = scale.y(peak.total);

  return `<figure role="group" aria-labelledby="daily-chart-caption">
        <svg viewBox="0 0 ${CHART_WIDTH} ${LINE_CHART_HEIGHT}" role="img" aria-label="${escapeHtml(title)}" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
          <title>${escapeHtml(title)}</title>
          <desc>${escapeHtml(description)}</desc>
          ${gridAndAxis(scale, domainMax, 40, plotWidth)}
          <line x1="${collapseX.toFixed(1)}" y1="${CHART_MARGIN.top}" x2="${collapseX.toFixed(1)}" y2="${CHART_MARGIN.top + plotHeight}" stroke="#a8b8ad" stroke-width="1" stroke-dasharray="4 4"/>
          <text x="${(collapseX + 6).toFixed(1)}" y="${CHART_MARGIN.top + 12}" fill="#eef8f0" font-size="11">${escapeHtml(monthDayLabel(collapseDate))} — collapse begins</text>
          <polyline points="${points.join(' ')}" fill="none" stroke="#4ade80" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          <circle cx="${peakX.toFixed(1)}" cy="${peakY.toFixed(1)}" r="4" fill="#4ade80" stroke="#0c1210" stroke-width="2"/>
          <text x="${(peakX - 6).toFixed(1)}" y="${(peakY - 8).toFixed(1)}" text-anchor="end" fill="#eef8f0" font-size="11">${escapeHtml(monthDayLabel(peak.date))} — ${peak.total} transits</text>
          ${monthTicks}
        </svg>
        <figcaption id="daily-chart-caption">${escapeHtml(description)}</figcaption>
      </figure>`;
}

export function renderMonthlyBarChart(monthlyRows, { title, description, partialMonth, partialThrough, escapeHtml }) {
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = BAR_CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const domainMax = 120;
  const scale = svgScaleFactory(domainMax, plotWidth, plotHeight);
  const slot = plotWidth / monthlyRows.length;
  const barWidth = Math.floor(slot) - 6;
  const labelledMonths = new Set(['2026-02', '2026-03', '2026-06', '2026-07']);

  const bars = monthlyRows.map((row, index) => {
    const x = CHART_MARGIN.left + index * slot + 3;
    const y = scale.y(row.avg);
    const height = CHART_MARGIN.top + plotHeight - y;
    const isPartial = row.month === partialMonth;
    const label = labelledMonths.has(row.month)
      ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" fill="#eef8f0" font-size="11">${row.avg.toFixed(row.avg < 20 ? 1 : 0)}</text>`
      : '';
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${Math.max(height, 1).toFixed(1)}" rx="2" fill="#4ade80"${isPartial ? ' fill-opacity="0.55" stroke="#4ade80" stroke-dasharray="3 3"' : ''}><title>${escapeHtml(`${monthLabel(row.month)}${isPartial ? ` (partial: through ${partialThrough})` : ''}: ${row.avg.toFixed(1)} transits/day`)}</title></rect>${label}</g>`;
  }).join('');

  const monthTicks = monthlyRows.map((row, index) => {
    const x = CHART_MARGIN.left + index * slot + 3 + barWidth / 2;
    return `<text x="${x.toFixed(1)}" y="${BAR_CHART_HEIGHT - 12}" text-anchor="middle" fill="#a8b8ad" font-size="10">${monthLabel(row.month).replace(' 20', ' ’')}</text>`;
  }).join('');

  return `<figure role="group" aria-labelledby="monthly-chart-caption">
        <svg viewBox="0 0 ${CHART_WIDTH} ${BAR_CHART_HEIGHT}" role="img" aria-label="${escapeHtml(title)}" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
          <title>${escapeHtml(title)}</title>
          <desc>${escapeHtml(description)}</desc>
          ${gridAndAxis(scale, domainMax, 40, plotWidth)}
          ${bars}
          ${monthTicks}
        </svg>
        <figcaption id="monthly-chart-caption">${escapeHtml(`${description} The ${monthLabel(partialMonth)} bar is partial (through ${partialThrough}) and drawn hatched.`)}</figcaption>
      </figure>`;
}

export function computeMonthlyAverages(history, startMonth, endMonth) {
  const byMonth = new Map();
  for (const row of history) {
    const month = row.date.slice(0, 7);
    if (month < startMonth || month > endMonth) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row.total);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({
      month,
      days: values.length,
      avg: round1(values.reduce((total, value) => total + value, 0) / values.length),
    }));
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

// Download filenames derive from the report id so a saved file self-identifies.
export function downloadFileNames(report) {
  return { csv: `${report.id}.csv`, json: `${report.id}.json` };
}

const CSV_COLUMNS = [
  ['date', 'date', 'ISO 8601 date (UTC)'],
  ['container', 'container', 'container-vessel transit calls'],
  ['dry_bulk', 'dryBulk', 'dry-bulk transit calls'],
  ['general_cargo', 'generalCargo', 'general-cargo transit calls'],
  ['roro', 'roro', 'ro-ro transit calls'],
  ['tanker', 'tanker', 'tanker transit calls'],
  ['cargo_total', 'cargo', 'container + dry bulk + general cargo + ro-ro'],
  ['total', 'total', 'all transit calls'],
  ['cap_container_dwt', 'capContainer', 'aggregate container capacity, DWT'],
  ['cap_dry_bulk_dwt', 'capDryBulk', 'aggregate dry-bulk capacity, DWT'],
  ['cap_general_cargo_dwt', 'capGeneralCargo', 'aggregate general-cargo capacity, DWT'],
  ['cap_roro_dwt', 'capRoro', 'aggregate ro-ro capacity, DWT'],
  ['cap_tanker_dwt', 'capTanker', 'aggregate tanker capacity, DWT'],
];

export function buildCsvDownload(snapshot, report) {
  const focus = snapshot.chokepoints[report.focusChokepointId];
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = focus.history.map((row) => CSV_COLUMNS.map(([, field]) => {
    const value = row[field];
    // Pin the injection-safety guarantee at the emission point: every cell is
    // an ISO date or a finite number, never free text a spreadsheet could
    // evaluate.
    if (field === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`Non-ISO date in CSV row: ${value}`);
    } else if (!Number.isFinite(value)) {
      throw new Error(`Non-numeric value for ${field} in CSV row ${row.date}: ${value}`);
    }
    return value;
  }).join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

export function buildJsonDownload(snapshot, report, metrics, canonicalUrl) {
  const metricsOut = {};
  for (const metric of metrics.values()) {
    metricsOut[metric.id] = {
      label: metric.label,
      value: metric.value,
      unit: metric.unit ?? null,
      observationPeriod: metric.period,
      method: metric.method,
      source: metric.source,
    };
  }
  return `${JSON.stringify(
    {
      reportId: report.id,
      title: report.title,
      version: report.version,
      author: report.author.name,
      datePublished: report.datePublished,
      dateModified: report.dateModified,
      canonicalUrl,
      license:
        'Report text and derived figures: © World Monitor, citation welcome with attribution. Underlying transit data: IMF PortWatch (portwatch.imf.org); consult upstream terms.',
      source: snapshot.source,
      snapshotId: snapshot.snapshotId,
      snapshotCapturedAt: snapshot.capturedAt,
      units: snapshot.units,
      csvSchema: CSV_COLUMNS.map(([name, , description]) => ({ column: name, description })),
      metrics: metricsOut,
      series: Object.fromEntries(
        Object.entries(snapshot.chokepoints).map(([id, chokepoint]) => [
          id,
          {
            portwatchName: chokepoint.portwatchName,
            observationStart: chokepoint.observationStart,
            observationEnd: chokepoint.observationEnd,
            rowCount: chokepoint.rowCount,
            missingDates: chokepoint.missingDates,
            history: chokepoint.history,
          },
        ]),
      ),
    },
  )}\n`;
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

const LAYER_LABELS = {
  observed: 'Observed transport data',
  derived: 'Derived analysis',
  news: 'News context',
  methodology: 'Methodology',
  data: 'Machine-readable data',
  product: 'Live product',
};

function layerBadge(layer, escapeHtml) {
  const label = LAYER_LABELS[layer];
  return label ? `<p class="eyebrow">${escapeHtml(label)}</p>` : '';
}

function trackedLink(href, text, target, escapeHtml, extraAttrs = '') {
  return `<a href="${escapeHtml(href)}" data-umami-event="research-cta" data-umami-event-target="${escapeHtml(target)}"${extraAttrs}>${text}</a>`;
}

export function renderResearchReportPage({
  report,
  snapshot,
  metrics,
  tpl,
  baseUrl,
  lastmod,
  chokepointSlug,
  dataCatalog,
  includedInDataCatalog,
}) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, withUtmSource, pageDocument } = tpl;
  const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
  if (!SLUG_PATTERN.test(report.slug) || !SLUG_PATTERN.test(report.id)) {
    throw new Error(`Report slug/id must match ${SLUG_PATTERN}: ${report.slug} / ${report.id}`);
  }
  if (!chokepointSlug) {
    throw new Error(
      `Report ${report.id}: focusChokepointId ${report.focusChokepointId} has no entry in the chokepoint registry — refusing to render a /chokepoints/undefined/ handoff link`,
    );
  }
  const path = `/research/${report.slug}/`;
  const canonical = absoluteUrl(baseUrl, path);
  const focus = snapshot.chokepoints[report.focusChokepointId];
  const resolve = (text) => resolveMetricTokens(escapeHtml(text), metrics, escapeHtml);
  const m = (id) => {
    const metric = metrics.get(id);
    if (!metric) throw new Error(`Unknown metric: ${id}`);
    return metric;
  };
  // Plain-text description for surfaces that cannot carry <data> markup; the
  // definition writes it with {{m:...}} tokens so its numbers cannot drift
  // from the computed metrics.
  const description = resolvePlainMetricTokens(report.description, metrics);
  const partialMonth = focus.observationEnd.slice(0, 7);

  const daily2026 = focus.history.filter((row) => row.date >= '2026-01-01');
  const monthly = computeMonthlyAverages(focus.history, '2025-07', partialMonth);

  const statTiles = [
    { headline: `−${formatMetric(m('declinePct'))}`, label: `transits vs the same 2025 window (2026-03-01 → ${m('observationEnd').value})` },
    { headline: `${formatMetric(m('disruptionDailyAvg'))}/day`, label: `average since March 1 — versus ${formatMetric(m('sameWindow2025DailyAvg'))}/day in 2025` },
    { headline: `${formatMetric(m('junAvgTanker'))}/day`, label: `June 2026 tanker transits — versus ${formatMetric(m('jun25AvgTanker'))} in June 2025` },
    { headline: formatMetric(m('zeroTransitDays')), label: 'zero-transit days since March 1 — none in the prior seven years' },
  ];

  const monthlyTable = `<div style="overflow-x:auto"><table>
        <caption>Average daily transits by month, Strait of Hormuz (textual equivalent of the charts)</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Avg daily transits</th><th scope="col">Observed days</th></tr></thead>
        <tbody>
${monthly.map((row) => `          <tr><td>${monthLabel(row.month)}${row.month === partialMonth ? ' (partial)' : ''}</td><td>${row.avg.toFixed(1)}</td><td>${row.days}</td></tr>`).join('\n')}
        </tbody>
      </table></div>`;

  const contextRows = report.contextChokepointIds.map((id) => {
    const chokepoint = snapshot.chokepoints[id];
    const history = chokepoint.history;
    const cell = (start, end) => round1(mean(inRange(history, start, end), 'total')).toFixed(1);
    return `          <tr><td>${escapeHtml(chokepoint.portwatchName)}</td><td>${cell('2025-01-01', '2025-12-31')}</td><td>${cell('2026-02-01', '2026-02-28')}</td><td>${cell('2026-06-01', '2026-06-30')}</td><td>${cell('2026-07-01', focus.observationEnd)}</td></tr>`;
  }).join('\n');
  const contextTable = `<div style="overflow-x:auto"><table>
        <caption>Context chokepoints: average daily transits (same snapshot, same units)</caption>
        <thead><tr><th scope="col">Chokepoint</th><th scope="col">2025 avg</th><th scope="col">Feb 2026</th><th scope="col">Jun 2026</th><th scope="col">${escapeHtml(partialRangeLabel(focus.observationEnd))}</th></tr></thead>
        <tbody>
${contextRows}
        </tbody>
      </table></div>`;

  const newsItems = report.newsContext.map((item) => `        <li><p>${escapeHtml(item.claim)}</p><p class="source">Source: <a href="${escapeHtml(item.url)}" rel="noopener">${escapeHtml(item.source)}</a> &middot; source date ${escapeHtml(item.sourceDate)} &middot; retrieved ${escapeHtml(item.retrievedAt)}.</p></li>`).join('\n');

  const notCovered = report.layersNotCovered.map((entry) => `        <li><strong>${escapeHtml(entry.layer)}:</strong> ${escapeHtml(entry.note)}</li>`).join('\n');

  const provenanceRows = [...metrics.values()].map((metric) => `          <tr><td>${escapeHtml(metric.label)}</td><td><data data-metric-row="${escapeHtml(metric.id)}" value="${escapeHtml(String(metric.value))}">${escapeHtml(formatMetric(metric))}${metric.unit && metric.kind !== 'percent' && metric.kind !== 'percent-round' ? ` ${escapeHtml(metric.unit)}` : ''}</data></td><td>${escapeHtml(metric.period)}</td><td>${escapeHtml(metric.method)}</td></tr>`).join('\n');

  const files = downloadFileNames(report);
  const downloadsBlock = `<ul class="result-list">
        <li>${trackedLink(`${path}${files.csv}`, files.csv, 'download-csv', escapeHtml, ' download')} — the focus-chokepoint daily series, ${escapeHtml(String(focus.rowCount))} rows (${escapeHtml(focus.observationStart)} → ${escapeHtml(focus.observationEnd)}), one row per day, columns documented in the JSON schema below.</li>
        <li>${trackedLink(`${path}${files.json}`, files.json, 'download-json', escapeHtml, ' download')} — all four chokepoint series plus every published figure with its observation period, method, provenance, units, CSV schema, licensing/attribution notes, and version identifier.</li>
      </ul>
      <p>Both files are versioned (report version ${escapeHtml(report.version)}, snapshot ${escapeHtml(snapshot.snapshotId)}) and regenerate byte-identically from the committed snapshot. Underlying data: IMF PortWatch; cite it when reusing the raw series.</p>`;

  const sectionsHtml = report.sections.map((section) => {
    const parts = [`      <section id="${escapeHtml(section.id)}">`,
      `        ${layerBadge(section.layer, escapeHtml)}`,
      `        <h2>${escapeHtml(section.heading)}</h2>`];
    for (const paragraph of section.paragraphs ?? []) {
      parts.push(`        <p>${resolve(paragraph)}</p>`);
    }
    switch (section.block) {
      case 'stats':
        parts.push(`        <div class="grid" aria-label="Key report figures">
${statTiles.map((tile) => `          <div class="metric"><span>${escapeHtml(tile.label)}</span><strong>${escapeHtml(tile.headline)}</strong></div>`).join('\n')}
        </div>`);
        break;
      case 'charts':
        parts.push(
          `        ${renderDailyLineChart(daily2026, {
            title: 'Daily transit calls, Strait of Hormuz, January – July 2026',
            description: `Daily AIS-observed transit calls from 2026-01-01 to ${focus.observationEnd}. Traffic averaged ${formatMetric(m('febAvgTotal'))}/day in February, collapsed from ${monthDayLabel(report.disruptionStart)}, and has partially recovered to ${formatMetric(m('julToDateAvgTotal'))}/day in July.`,
            collapseDate: report.disruptionStart,
            escapeHtml,
          })}`,
          `        ${renderMonthlyBarChart(monthly, {
            title: 'Average daily transits by month, July 2025 – July 2026',
            description: 'Monthly averages of the same daily series, July 2025 through July 2026.',
            partialMonth,
            partialThrough: focus.observationEnd,
            escapeHtml,
          })}`,
          `        ${monthlyTable}`,
        );
        break;
      case 'context-table':
        parts.push(`        ${contextTable}`);
        break;
      case 'news-context':
        parts.push(`        <ul class="result-list">
${newsItems}
        </ul>`);
        break;
      case 'downloads':
        parts.push(`        ${downloadsBlock}`);
        break;
      case 'provenance':
        parts.push(`        <p>Every figure in this report, with its observation period, transformation, and source. Recompute any of them from the downloadable data.</p>
        <div style="overflow-x:auto"><table>
          <caption>Published figures and their provenance</caption>
          <thead><tr><th scope="col">Figure</th><th scope="col">Value</th><th scope="col">Observation period</th><th scope="col">Method</th></tr></thead>
          <tbody>
${provenanceRows}
          </tbody>
        </table></div>`);
        break;
      case 'citation':
        // Generated from the report fields so a version bump can never leave a
        // stale recommended citation behind.
        parts.push(`        <p>Cite the report as:</p>
        <blockquote><p>${escapeHtml(`${report.author.name}, “${report.title}”, version ${report.version}, published ${report.datePublished}. ${canonical} — underlying transit data: IMF PortWatch (portwatch.imf.org).`)}</p></blockquote>
        <p>The canonical URL is stable, editions are append-only, and corrections bump the version and modified date rather than silently rewriting figures.</p>`);
        break;
      case 'live-handoff': {
        const dashboardUrl = withUtmSource(absoluteUrl(baseUrl, `/?chokepoint=${report.focusChokepointId}`), 'research-report');
        parts.push(`        <p>This report is a dated snapshot. For the current picture: the ${trackedLink(`/chokepoints/${chokepointSlug}/`, 'live Strait of Hormuz status page', 'chokepoint-page', escapeHtml)} shows today's disruption pulse, and the ${trackedLink(dashboardUrl, 'World Monitor dashboard', 'dashboard', escapeHtml)} adds map layers, alerts, and vessel context around it.</p>
        <p>Programmatic access: the same chokepoint status and transit history are available through the ${trackedLink('/docs/api-reference', 'World Monitor REST API', 'developer', escapeHtml)} and the ${trackedLink('/docs/mcp-overview', 'MCP server', 'developer', escapeHtml)} for AI agents. Higher request limits and research briefings come with ${trackedLink(withUtmSource(absoluteUrl(baseUrl, '/pro'), 'research-report'), 'World Monitor Pro', 'pricing', escapeHtml)}. The research itself stays free and ungated.</p>`);
        break;
      }
      default:
        break;
    }
    parts.push('      </section>');
    return parts.join('\n');
  }).join('\n');

  const justification = `      <section id="why-this-report">
        <p class="eyebrow">Why this report exists</p>
        <h2>Topic selection, from evidence</h2>
        <ul class="result-list">
${report.topicJustification.map((reason) => `          <li>${escapeHtml(reason)}</li>`).join('\n')}
        </ul>
      </section>`;

  const notCoveredSection = `      <section id="not-covered">
        <p class="eyebrow">Declared gaps</p>
        <h2>What this edition does not cover</h2>
        <ul class="result-list">
${notCovered}
        </ul>
      </section>`;

  const body = `      <p class="eyebrow">Research &middot; ${escapeHtml(report.series)} &middot; v${escapeHtml(report.version)}</p>
      <h1>${escapeHtml(report.title)}</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p class="source">By ${escapeHtml(report.author.name)} &middot; published <time datetime="${escapeHtml(report.datePublished)}">${escapeHtml(report.datePublished)}</time> &middot; modified <time datetime="${escapeHtml(report.dateModified)}">${escapeHtml(report.dateModified)}</time> &middot; data through <time datetime="${escapeHtml(focus.observationEnd)}">${escapeHtml(focus.observationEnd)}</time>.</p>
${sectionsHtml}
${notCoveredSection}
${justification}
      <p class="source">Snapshot: ${escapeHtml(report.snapshotPath)} (retrieved ${escapeHtml(String(snapshot.capturedAt))}). Attribution: ${escapeHtml(snapshot.source.attribution)} Methodology: <a href="/docs/methodology/chokepoints">chokepoint monitoring methodology</a>.</p>
      ${UMAMI_SCRIPT_TAG}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Report',
    headline: report.title,
    name: report.title,
    description,
    url: canonical,
    datePublished: report.datePublished,
    dateModified: report.dateModified,
    version: report.version,
    inLanguage: 'en-US',
    author: { '@type': 'Organization', name: report.author.name, url: report.author.url },
    publisher: { '@type': 'Organization', name: 'World Monitor', url: 'https://www.worldmonitor.app/' },
    isBasedOn: 'https://portwatch.imf.org/',
    temporalCoverage: `${focus.observationStart}/${focus.observationEnd}`,
    hasPart: {
      '@type': 'Dataset',
      name: `Strait of Hormuz daily transit calls, ${focus.observationStart} to ${focus.observationEnd}`,
      description:
        'Daily AIS-observed vessel transit calls by class with deadweight-tonnage aggregates, from IMF PortWatch, frozen in a versioned snapshot.',
      creator: { '@type': 'Organization', name: report.author.name, url: report.author.url },
      license: DATASET_LICENSE,
      datePublished: report.datePublished,
      temporalCoverage: `${focus.observationStart}/${focus.observationEnd}`,
      isAccessibleForFree: true,
      includedInDataCatalog,
      variableMeasured: [
        'Daily vessel transit calls',
        'Transit calls by vessel class',
        'Deadweight-tonnage aggregates',
      ],
      spatialCoverage: {
        '@type': 'Place',
        name: focus.portwatchName,
        identifier: report.focusChokepointId,
      },
      isBasedOn: 'https://portwatch.imf.org/',
      distribution: [
        {
          '@type': 'DataDownload',
          encodingFormat: 'text/csv',
          contentUrl: `${canonical}${files.csv}`,
        },
        {
          '@type': 'DataDownload',
          encodingFormat: 'application/json',
          contentUrl: `${canonical}${files.json}`,
        },
      ],
    },
  };

  const html = pageDocument({
    baseUrl,
    path,
    title: `${report.metaTitle} | World Monitor`,
    description,
    lastmod,
    jsonLd: [jsonLd, dataCatalog].filter(Boolean),
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Research', path: '/research/' },
      { name: report.title, path },
    ]),
    body,
    ogImage: `/research-assets/${report.slug}-og.png`,
    ogImageAlt: `Chart of daily Strait of Hormuz transit calls collapsing from about ${formatMetric(m('febAvgTotal'))} per day in February 2026 to single digits in March, partially recovering to about ${formatMetric(m('julToDateAvgTotal'))} in July — ${report.title}, World Monitor`,
  });
  assertNoUnresolvedTokens(html);
  return html;
}

export function renderResearchIndex({ reports, tpl, baseUrl, lastmod, dataCatalog }) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, pageDocument } = tpl;
  const path = '/research/';
  const description =
    'Original, source-backed World Monitor research: dated, versioned reports built from committed data snapshots, with downloadable data, explicit methodology, and declared gaps.';
  const body = `      <p class="eyebrow">Research corpus</p>
      <h1>World Monitor research reports</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
${reports.map((report) => `        <a class="card" href="/research/${escapeHtml(report.slug)}/"><strong>${escapeHtml(report.title)}</strong><br><span>Published ${escapeHtml(report.datePublished)} &middot; v${escapeHtml(report.version)}</span></a>`).join('\n')}
      </div>
      <h2>How these reports work</h2>
      <p>Each report is generated deterministically from a versioned, committed data snapshot — no live fetches at build time — so every published figure can be recomputed from the downloadable data beside it. Observed data, derived analysis, and third-party context are labelled separately and never blended into a combined score. Missing or unverifiable data is declared, not zero-filled.</p>
      <p>Editions are append-only: corrections bump the version and modified date. Report families expand only when the pilot demonstrates real demand, per the <a href="/docs/methodology/chokepoints">methodology</a> and measurement guardrails.</p>
      ${UMAMI_SCRIPT_TAG}`;
  const html = pageDocument({
    baseUrl,
    path,
    title: 'Research Reports | World Monitor',
    description,
    lastmod,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'World Monitor research reports',
        description,
        url: absoluteUrl(baseUrl, path),
        inLanguage: 'en-US',
      },
      dataCatalog,
    ].filter(Boolean),
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Research', path },
    ]),
    body,
  });
  assertNoUnresolvedTokens(html);
  return html;
}

// Renders and writes the whole /research/ section (hub, report pages,
// downloads). Owns its own file IO so build-crawlable-corpus.mjs stays the
// template owner without also carrying the research wiring.
export function writeResearchSection({ data, outDir, baseUrl, tpl, dataCatalog, includedInDataCatalog }) {
  if (!dataCatalog?.['@id'] || !includedInDataCatalog?.['@id']) {
    throw new Error(
      'writeResearchSection requires the canonical DataCatalog identity so research Datasets can join the catalog graph',
    );
  }
  mkdirSync(join(outDir, 'research'), { recursive: true });
  writeFileSync(
    join(outDir, 'research', 'index.html'),
    renderResearchIndex({
      reports: data.researchReports.map(({ report }) => report),
      tpl,
      baseUrl,
      lastmod: data.lastmod.research,
      dataCatalog,
    }),
  );
  const chokepointSlugById = new Map(data.chokepoints.map((entry) => [entry.id, entry.slug]));
  for (const { report, snapshot } of data.researchReports) {
    const metrics = computeReportMetrics(snapshot, report);
    const reportDir = join(outDir, 'research', report.slug);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'index.html'),
      renderResearchReportPage({
        report,
        snapshot,
        metrics,
        tpl,
        baseUrl,
        lastmod: data.lastmod.research,
        chokepointSlug: chokepointSlugById.get(report.focusChokepointId),
        dataCatalog,
        includedInDataCatalog,
      }),
    );
    const downloadFiles = downloadFileNames(report);
    writeFileSync(join(reportDir, downloadFiles.csv), buildCsvDownload(snapshot, report));
    writeFileSync(
      join(reportDir, downloadFiles.json),
      buildJsonDownload(snapshot, report, metrics, tpl.absoluteUrl(baseUrl, `/research/${report.slug}/`)),
    );
  }
}
