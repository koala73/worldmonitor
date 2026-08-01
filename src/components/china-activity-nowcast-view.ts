import type {
  ChinaActivityComparisonState,
  ChinaActivityContribution,
  ChinaActivityDirection,
  ChinaActivityNowcastResponse,
  ChinaActivityProxyFamily,
} from '../../shared/china-activity-nowcast';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const STATE_LABELS: Record<ChinaActivityComparisonState, string> = {
  agreement: 'Official and proxies agree',
  proxy_leading_divergence: 'Proxy-leading divergence',
  official_leading_divergence: 'Official-leading divergence',
  mixed_signals: 'Mixed proxy signals',
  insufficient_data: 'Insufficient comparable data',
};

const DIRECTION_LABELS: Record<ChinaActivityDirection, string> = {
  strengthening: 'Strengthening',
  weakening: 'Weakening',
  unchanged: 'Unchanged',
};

const FAMILY_LABELS: Record<ChinaActivityProxyFamily, string> = {
  freight: 'Freight',
  maritime: 'Maritime',
  aviation: 'Aviation',
  energy: 'Energy',
  commodity: 'Commodity',
  corridor: 'Corridor',
  market: 'Market',
};

const UTC_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatInstant(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'time unavailable';
  return UTC_DATE_FORMATTER.format(new Date(parsed));
}

function contributionValue(contribution: ChinaActivityContribution): string {
  if (
    !contribution.included
    || contribution.transformedValue === null
    || contribution.direction === null
  ) {
    return `Excluded · ${humanize(contribution.exclusionReason ?? 'unavailable')}`;
  }
  const sign = contribution.transformedValue > 0 ? '+' : '';
  return `${DIRECTION_LABELS[contribution.direction]} · ${sign}${contribution.transformedValue.toFixed(2)} ${contribution.registry.unit}`;
}

function contributionHtml(contribution: ChinaActivityContribution): string {
  const status = contribution.included && contribution.direction !== null
    ? contribution.direction
    : 'excluded';
  return `
    <article class="china-nowcast-contribution china-nowcast-contribution--${status}" data-family="${escapeHtml(contribution.family)}">
      <div class="china-nowcast-contribution__heading">
        <div>
          <span class="china-nowcast-family">${escapeHtml(FAMILY_LABELS[contribution.family])}</span>
          <h4>${escapeHtml(contribution.registry.label)}</h4>
        </div>
        <span class="china-nowcast-contribution__state">${escapeHtml(contributionValue(contribution))}</span>
      </div>
      <p>${escapeHtml(contribution.registry.decisionRationale)}</p>
      <dl>
        <div><dt>Observed</dt><dd>${escapeHtml(contribution.observedAt ? formatInstant(contribution.observedAt) : 'Missing')}</dd></div>
        <div><dt>Frequency</dt><dd>${escapeHtml(contribution.registry.frequency)}</dd></div>
        <div><dt>Lag</dt><dd>${escapeHtml(contribution.registry.lagRule.description)}</dd></div>
        <div><dt>Transformation</dt><dd>${escapeHtml(contribution.registry.transformation.description)}</dd></div>
        <div><dt>Freshness budget</dt><dd>${escapeHtml(`${contribution.registry.freshnessBudgetMinutes} minutes`)}</dd></div>
        <div><dt>Source</dt><dd><a href="${sanitizeUrl(contribution.registry.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contribution.registry.source.publisherName)}</a></dd></div>
      </dl>
    </article>`;
}

export function renderChinaActivityNowcastView(
  response: ChinaActivityNowcastResponse,
): string {
  const official = response.official;
  const sensitivity = response.sensitivity.map((item) => `
    <li data-sensitivity-family="${escapeHtml(item.family)}">
      <strong>${escapeHtml(FAMILY_LABELS[item.family])}</strong>
      <span>${escapeHtml(item.changesConclusion
        ? `Changes conclusion → ${humanize(item.stateWithoutFamily)}`
        : `Stable → ${humanize(item.stateWithoutFamily)}`)}</span>
    </li>`).join('');
  const limitations = response.limitations.map((limitation) =>
    `<li>${escapeHtml(limitation)}</li>`).join('');

  return `
    <div class="china-nowcast-view">
      <section class="china-nowcast-summary china-nowcast-summary--${escapeHtml(response.state)}" aria-labelledby="china-nowcast-state">
        <div>
          <span class="china-nowcast-eyebrow">${escapeHtml(response.methodVersion)}</span>
          <h3 id="china-nowcast-state">${escapeHtml(STATE_LABELS[response.state])}</h3>
          <p>${escapeHtml(`${response.comparisonWindow.days}-day comparison window`)} · No forward-fill · no interpolation</p>
        </div>
        <div class="china-nowcast-confidence">
          <span>${escapeHtml(response.confidence.level)}</span>
          <strong>${escapeHtml(`${response.confidence.eligibleFamilies}/${response.confidence.totalFamilies} proxy families eligible`)}</strong>
          <small>${escapeHtml(response.confidence.reason)}</small>
        </div>
      </section>

      <section class="china-nowcast-official" aria-label="Official comparison series">
        <span class="china-nowcast-eyebrow">Official release</span>
        ${official
          ? `<h4>${escapeHtml(official.label)}</h4>
             <p><strong>${escapeHtml(DIRECTION_LABELS[official.direction])}</strong> · ${escapeHtml(String(official.value))}${escapeHtml(official.unit)} · period ${escapeHtml(official.observationPeriod)}</p>
             <dl>
               <div><dt>Vintage</dt><dd>${escapeHtml(official.vintageId)}</dd></div>
               <div><dt>Released</dt><dd>${escapeHtml(formatInstant(official.releaseTime))}</dd></div>
               <div><dt>Retrieved</dt><dd>${escapeHtml(formatInstant(official.retrievalTime))}</dd></div>
             </dl>`
          : '<h4>No eligible official vintage</h4><p>Official data is missing, stale, unavailable, or was not yet released at the evaluation time.</p>'}
      </section>

      <section class="china-nowcast-contributions" aria-label="Proxy contributions">
        ${response.contributions.map(contributionHtml).join('')}
      </section>

      <details class="china-nowcast-method">
        <summary>Methodology, sensitivity, and historical evaluation</summary>
        <div class="china-nowcast-method__grid">
          <section>
            <h4>Leave-one-family-out sensitivity</h4>
            <ul>${sensitivity}</ul>
          </section>
          <section>
            <h4>Historical evaluation unavailable</h4>
            <p>${escapeHtml(response.historicalEvaluation.reason)}</p>
            <p>Coverage: ${escapeHtml(`${response.historicalEvaluation.evaluated}/${response.historicalEvaluation.attempted}`)} · no-lookahead: yes</p>
          </section>
          <section>
            <h4>Limitations</h4>
            <ul>${limitations}</ul>
          </section>
        </div>
      </details>
    </div>`;
}
