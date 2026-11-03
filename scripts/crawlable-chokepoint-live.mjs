// The live section of a /chokepoints/<slug>/ page, rendered by ONE function for
// both the corpus build (the frozen weekly pulse) and the routing middleware
// (the current reading at request time). Crawlers do not run the hydrate
// script, so without the middleware path an answer engine reading "Is the
// Strait of Hormuz open right now?" quoted a week-old pulse.
//
// Pure module: no Node or DOM APIs, so middleware.ts can bundle it.

import {
  chokepointCoverageMetrics,
  chokepointEvidenceNarrative,
  chokepointOfficialMetrics,
} from './crawlable-live-tools.mjs';

export const CHOKEPOINT_LIVE_START = '<!--wm-live:chokepoint-->';
export const CHOKEPOINT_LIVE_END = '<!--/wm-live:chokepoint-->';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatStaticDateTime(iso) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return String(iso || '');
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}

export function liveUpdatedMarkup({ asOf, fallbackLabel, prefix = 'Published pulse' }) {
  if (asOf) {
    return `<time data-live-updated datetime="${escapeHtml(asOf)}">${escapeHtml(prefix)} ${escapeHtml(formatStaticDateTime(asOf))}</time>`;
  }
  // Never put loading prose in a <time> without datetime — crawlers treat that
  // as an undated temporal claim.
  return `<span data-live-updated>${escapeHtml(fallbackLabel)}</span>`;
}

export const OBSERVED_EVIDENCE = Object.freeze({ coverage: true });

// A dimension carries an imputationClass ONLY when observedWeight === 0 -- see the
// four-class taxonomy in proto/worldmonitor/resilience/v1/resilience.proto and
// server/worldmonitor/resilience/v1/_shared.ts. So an empty class is the allow-list
// for "observed", exactly as buildMicrostateEvidenceProfile already requires.
// Enumerating the withheld classes instead would fail OPEN on any fifth class
// (it already omitted 'stable-absence', whose imputed scores run 85-88).
export function hasObservedValue(value, { coverage, evidenceState = '' } = {}) {
  const numericValue = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const numericCoverage = Number(coverage);
  return numericValue !== ''
    && numericValue != null
    && Number.isFinite(Number(numericValue))
    && Number.isFinite(numericCoverage)
    && numericCoverage > 0
    && String(evidenceState || '') === '';
}

export function formatObservedNumber(value, evidence, formatter, fallback = '—') {
  if (!hasObservedValue(value, evidence)) return fallback;
  const numeric = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
  return formatter(numeric);
}

export function formatScoreNumber(numeric) {
  return numeric.toFixed(1).replace(/\.0$/, '');
}

export function formatScore(value, evidence) {
  return formatObservedNumber(value, evidence, formatScoreNumber);
}

export const LEGACY_ABSENT_STATUS_NOTE = 'No additional status note was supplied.';

function chokepointDescriptionParagraph(description) {
  const raw = typeof description === 'string' ? description.trim() : '';
  const text = raw === LEGACY_ABSENT_STATUS_NOTE ? '' : raw;
  return text
    ? `        <p data-chokepoint-description>${escapeHtml(text)}</p>`
    : '        <p data-chokepoint-description hidden></p>';
}

function optionalChokepointMetric(label, attribute, value, available) {
  return `          <div class="metric"${available ? '' : ' hidden'}><span>${escapeHtml(label)}</span><strong ${attribute}>${available ? escapeHtml(value) : ''}</strong></div>`;
}

// Operator-facing review-hygiene text the chokepoint status contract appends
// (THREAT_CONFIG_STALE_NOTE in server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts).
// It is useful in the live tool but must not reach crawlable HTML, where it
// becomes indexed, quotable page content.
const INTERNAL_NOTE_RE = /\s*;?\s*Threat baseline last reviewed[^;]*?review recommended\.?/gi;
const NO_ACTIVE_DISRUPTIONS_DESCRIPTION = 'No active disruptions';

// Returns null, never a placeholder sentence. "No additional status note was
// supplied." used to be frozen and rendered as a real <p> in <main> — an
// absence described in prose reads to a crawler as published content, and it
// was the only body text 7 of 13 chokepoint pages carried (#7530). An absent
// note has no page representation: the paragraph is emitted `hidden`.
export function publishableChokepointDescription(value) {
  const cleaned = String(value || '')
    .replace(INTERNAL_NOTE_RE, '')
    .replace(/^[\s;·—-]+|[\s;·—-]+$/g, '')
    .trim();
  return cleaned && cleaned !== NO_ACTIVE_DISRUPTIONS_DESCRIPTION ? cleaned : null;
}

// chokepointStatusViewModel output → the record the page renders. The weekly
// freeze stores this record; the middleware builds it from the same view.
// The official* and baseline* fields are IMF PortWatch figures; records frozen
// before they existed carry none of them and render with the figures withheld.
export function chokepointPulseRecord(view) {
  return {
    disruptionScore: view.disruptionScore,
    status: view.status,
    congestion: view.congestion,
    navigationalWarnings: view.navigationalWarnings,
    navigationalWarningsAvailable: view.navigationalWarnings !== null,
    aisDisruptions: view.aisDisruptions,
    aisSnapshotAvailable: view.aisDisruptions !== null,
    description: publishableChokepointDescription(view.description),
    officialLatestDate: view.officialLatestDate ?? null,
    officialLatestTotal: view.officialLatestTotal ?? null,
    officialAvg7d: view.officialAvg7d ?? null,
    baselineAvgDaily: view.baselineAvgDaily ?? null,
    baselineFrom: view.baselineFrom ?? null,
    baselineTo: view.baselineTo ?? null,
    weekMovement: view.weekMovement,
    partial: view.partial === true,
    asOf: new Date(view.fetchedAt).toISOString(),
  };
}

function officialMetricCells(official) {
  return `          <div class="metric"><span>Latest daily transits (IMF PortWatch)</span><strong><span data-chokepoint-official-transits>${escapeHtml(official.latestTransits ?? '—')}</span><small data-chokepoint-official-date>${escapeHtml(official.latestDate ?? '')}</small></strong></div>
          <div class="metric"><span>7-day average vs year-earlier</span><strong data-chokepoint-official-average>${escapeHtml(official.average ?? '—')}</strong></div>`;
}

/**
 * @param {{ chokepoint: { id: string, displayName: string },
 *           pulse: object | null, live?: boolean }} input
 *   `live` marks a reading taken at request time; otherwise the pulse is the
 *   frozen weekly capture and is labelled as published.
 */
export function renderChokepointLiveSection({ chokepoint, pulse, live = false }) {
  const hasPulse = hasObservedValue(pulse?.disruptionScore, { coverage: pulse != null });
  const coverageMetrics = chokepointCoverageMetrics({
    navigationalWarnings: pulse?.navigationalWarnings,
    navigationalWarningsAvailable: pulse?.navigationalWarningsAvailable === true,
    aisDisruptions: pulse?.aisDisruptions,
    aisSnapshotAvailable: pulse?.aisSnapshotAvailable === true,
    congestionLevel: pulse?.congestion,
    weekMovement: pulse?.weekMovement ?? null,
  });
  // A legacy record (pre-PortWatch headline) has no official fields: every
  // label here is null and the figures are withheld, never zero-filled.
  const official = chokepointOfficialMetrics({
    officialLatestDate: pulse?.officialLatestDate,
    officialLatestTotal: pulse?.officialLatestTotal,
    officialAvg7d: pulse?.officialAvg7d,
    baselineAvgDaily: pulse?.baselineAvgDaily,
    baselineFrom: pulse?.baselineFrom,
    baselineTo: pulse?.baselineTo,
  });
  const officialWithheld = hasPulse && official.latestTransits === null;
  const pulsePartial = pulse?.partial === true
    || officialWithheld
    || coverageMetrics.navigationalWarnings === null
    || coverageMetrics.aisDisruptions === null;
  const liveState = hasPulse ? (pulsePartial ? 'partial' : 'ready') : 'loading';
  // Same wording as the hydrate script (loadChokepoint) for a live reading.
  const statusLabels = live
    ? { full: 'Live reading', partial: 'Partial live reading' }
    : { full: 'Published pulse', partial: 'Published partial pulse' };
  const liveStatus = hasPulse
    ? (pulsePartial ? statusLabels.partial : statusLabels.full)
    : 'Waiting for live enhancement';
  const narrative = hasPulse
    ? chokepointEvidenceNarrative({
      displayName: chokepoint.displayName,
      score: pulse.disruptionScore,
      bandLabel: pulse.status,
      description: pulse.description,
      asOfText: formatStaticDateTime(pulse.asOf),
      partial: pulsePartial,
      warningsLabel: coverageMetrics.navigationalWarnings,
      congestionLabel: coverageMetrics.congestion,
      aisEventCountLabel: coverageMetrics.aisDisruptions,
      officialLatestDate: pulse.officialLatestDate,
      officialLatestTotal: pulse.officialLatestTotal,
      officialAvg7d: pulse.officialAvg7d,
      baselineAvgDaily: pulse.baselineAvgDaily,
      baselineFrom: pulse.baselineFrom,
      baselineTo: pulse.baselineTo,
    })
    : null;
  const openStatusHtml = narrative !== null
    ? escapeHtml(narrative.passage)
    : `World Monitor has not published current passage evidence for ${escapeHtml(chokepoint.displayName)} yet.`;
  const openStatusSection = `        <h2>Is ${escapeHtml(chokepoint.displayName)} open right now?</h2>
        <p data-chokepoint-open-status>${openStatusHtml}</p>
${narrative !== null
    ? `        <p data-chokepoint-score-driver>${escapeHtml(narrative.scoreDriver)}</p>`
    : '        <p data-chokepoint-score-driver hidden></p>'}`;
  const liveGrid = hasPulse
    ? `        <div class="grid" data-live-grid aria-label="Current chokepoint status" aria-busy="false">
          <div class="metric"><span>Disruption score</span><strong><span data-chokepoint-score>${escapeHtml(formatScore(pulse.disruptionScore, { coverage: hasPulse }))}</span><small data-chokepoint-band>${escapeHtml(pulse.status)}</small></strong></div>
${optionalChokepointMetric('Navigational warnings', 'data-chokepoint-warnings', coverageMetrics.navigationalWarnings, coverageMetrics.navigationalWarnings !== null)}
${optionalChokepointMetric('AIS disruptions', 'data-chokepoint-ais-disruptions', coverageMetrics.aisDisruptions, coverageMetrics.aisDisruptions !== null)}
${optionalChokepointMetric('AIS congestion', 'data-chokepoint-congestion', coverageMetrics.congestion, coverageMetrics.congestion !== null)}
${officialMetricCells(official)}
          <div class="metric"><span>Week-over-week movement</span><strong data-chokepoint-movement>${escapeHtml(coverageMetrics.weekMovement ?? (officialWithheld ? '—' : 'Unavailable'))}</strong></div>
        </div>
${chokepointDescriptionParagraph(pulse.description)}`
    : `        <p class="tool-note" data-live-fallback>Current disruption metrics load after page enhancement. The static waterway and route context below remains the dated crawlable reference.</p>
        <div class="grid" data-live-grid hidden aria-label="Current chokepoint status" aria-busy="true">
          <div class="metric"><span>Disruption score</span><strong><span data-chokepoint-score></span><small data-chokepoint-band></small></strong></div>
${optionalChokepointMetric('Navigational warnings', 'data-chokepoint-warnings', '', false)}
${optionalChokepointMetric('AIS disruptions', 'data-chokepoint-ais-disruptions', '', false)}
${optionalChokepointMetric('AIS congestion', 'data-chokepoint-congestion', '', false)}
          <div class="metric"><span>Latest daily transits (IMF PortWatch)</span><strong><span data-chokepoint-official-transits></span><small data-chokepoint-official-date></small></strong></div>
          <div class="metric"><span>7-day average vs year-earlier</span><strong data-chokepoint-official-average></strong></div>
          <div class="metric"><span>Week-over-week movement</span><strong data-chokepoint-movement></strong></div>
        </div>
        <p data-chokepoint-description hidden></p>`;

  return `${CHOKEPOINT_LIVE_START}
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="${escapeHtml(chokepoint.id)}" data-chokepoint-name="${escapeHtml(chokepoint.displayName)}" data-state="${liveState}"${hasPulse ? ' data-published-pulse' : ''}${live && hasPulse ? ' data-live-at-request' : ''}>
${openStatusSection}
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current status</p>
            <h2>${escapeHtml(chokepoint.displayName)} disruption pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">${escapeHtml(liveStatus)}</span>
        </div>
        <p class="tool-note">Daily transit counts are official IMF PortWatch figures, published about four days after the day they cover. A missing count does not mean zero traffic.</p>
${liveGrid}
        <div class="tool-meta">
          ${liveUpdatedMarkup({
            asOf: pulse?.asOf || null,
            fallbackLabel: 'Live enhancement pending',
            prefix: live ? 'Live reading' : 'Published pulse',
          })}
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to load the live reading. ${hasPulse ? `The ${live ? 'reading' : 'published pulse'} above remains available without JavaScript.` : 'The static waterway and route context remains available below.'}</p></noscript>
      </section>
${CHOKEPOINT_LIVE_END}`;
}

// Replaces the marked live section in a built chokepoint page. Returns null
// when the page carries no single well-formed section, so the caller serves
// the built page unchanged instead of guessing.
export function replaceChokepointLiveSection(html, section) {
  const start = html.indexOf(CHOKEPOINT_LIVE_START);
  if (start === -1 || html.indexOf(CHOKEPOINT_LIVE_START, start + 1) !== -1) return null;
  const end = html.indexOf(CHOKEPOINT_LIVE_END, start);
  if (end === -1) return null;
  return html.slice(0, start) + section + html.slice(end + CHOKEPOINT_LIVE_END.length);
}
