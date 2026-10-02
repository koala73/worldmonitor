import type { GetFiveFactorScorecardResponse } from '@/generated/client/worldmonitor/scorecard/v1/service_client';
import { h } from '@/utils/dom-utils';
import {
  buildFiveFactorPillarRows,
  formatScorecardEvidence,
} from './five-factor-scorecard-view-model';

type Translator = (key: string, params?: Record<string, string>) => string;

function inputLabelKey(inputId: string): string {
  return `countryBrief.fiveFactorScorecard.inputs.${inputId.split('.').join('_')}`;
}

function reasonLabel(reason: string, translate: Translator): string {
  return translate(`countryBrief.fiveFactorScorecard.reasons.${reason}`);
}

function renderEvidence(
  input: NonNullable<GetFiveFactorScorecardResponse['scorecard']>['pillars'][number]['inputs'][number],
  translate: Translator,
): HTMLElement {
  const formatted = formatScorecardEvidence(input, translate('countryBrief.fiveFactorScorecard.notAvailable'));
  const row = h('tr', { className: `cdp-scorecard-input${formatted.available ? '' : ' is-unavailable'}` });
  const source = h('td', { className: 'cdp-scorecard-input-source' });
  row.append(h('th', { scope: 'row', className: 'cdp-scorecard-input-label' }, translate(inputLabelKey(formatted.inputId))),
    h('td', { className: 'cdp-scorecard-input-value' }, formatted.valueLabel), source);
  if (formatted.provenance) {
    source.append(h('div', { className: 'cdp-economic-source' }, formatted.provenance));
  }
  if (formatted.unavailableReason) {
    source.append(h('div', { className: 'cdp-scorecard-unavailable-reason' }, reasonLabel(formatted.unavailableReason, translate)));
  }
  return row;
}

export function renderFiveFactorScorecardSection(
  response: GetFiveFactorScorecardResponse,
  translate: Translator,
): HTMLElement {
  const container = h('div', { className: 'cdp-five-factor-scorecard' });
  const scorecard = response.scorecard;
  if (response.unavailable || !scorecard) {
    container.dataset.briefState = 'unavailable';
    container.append(h('div', { className: 'cdp-empty' }, translate('countryBrief.fiveFactorScorecard.unavailable')));
    return container;
  }

  const rows = buildFiveFactorPillarRows(scorecard.pillars, {
    insufficient: translate('countryBrief.fiveFactorScorecard.insufficient'),
    score: (value) => translate('countryBrief.fiveFactorScorecard.score', { score: String(value) }),
    coverage: (value) => translate('countryBrief.fiveFactorScorecard.coverage', { coverage: String(value) }),
  });

  const tabs = h('div', { className: 'cdp-scorecard-tabs', role: 'tablist', 'aria-label': 'Resilience factors' });
  const panels = h('div', { className: 'cdp-scorecard-evidence' });
  container.append(h('p', { className: 'cdp-section-description' }, 'Five distinct scores. Select a factor to inspect its evidence.'), tabs, panels);
  const select = (index: number, focus = false): void => {
    container.dataset.evidenceExpanded = 'true';
    Array.from(tabs.children).forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      (tab as HTMLElement).tabIndex = i === index ? 0 : -1;
      (panels.children[i] as HTMLElement).hidden = i !== index;
    });
    if (focus) (tabs.children[index] as HTMLElement).focus();
  };
  for (const [index, row] of rows.entries()) {
    const label = translate(`countryBrief.fiveFactorScorecard.pillars.${row.pillar}`);
    const tabId = `cdp-factor-${row.pillar}`;
    const panelId = `${tabId}-evidence`;
    const marks = h('span', { className: 'cdp-scorecard-marks', 'aria-hidden': 'true' });
    for (let i = 1; i <= 5; i++) marks.append(h('i', { className: row.score !== null && i <= row.score ? 'is-filled' : '' }));
    const tab = h('button', { type: 'button', id: tabId, role: 'tab', className: `cdp-scorecard-pillar is-${row.status}`, 'aria-controls': panelId },
      h('span', { className: 'cdp-scorecard-pillar-name' }, label),
      h('span', { className: 'cdp-scorecard-score' }, row.scoreLabel), marks,
      h('span', { className: `cdp-scorecard-coverage${row.coverage < 80 ? ' is-partial' : ''}` }, row.coverageLabel));
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      const next = key === 'Home' ? 0 : key === 'End' ? 4 : key === 'ArrowRight' ? (index + 1) % 5 : key === 'ArrowLeft' ? (index + 4) % 5 : null;
      if (next === null) return;
      event.preventDefault();
      select(next, true);
    });
    tabs.append(tab);
    const details = h('div', { id: panelId, role: 'tabpanel', 'aria-labelledby': tabId, className: 'cdp-scorecard-factor-evidence', tabIndex: 0 },
      h('div', { className: 'cdp-scorecard-evidence-heading' }, h('h4', {}, `${label} · supporting evidence`),
        h('span', {}, `${row.inputs.length} inputs · ${row.coverageLabel}`)));
    if (row.reasons.length > 0) {
      details.append(h('div', { className: 'cdp-scorecard-reasons' },
        ...row.reasons.map((reason) => h('span', { className: 'cdp-scorecard-reason' }, reasonLabel(reason, translate))),
      ));
    }
    const evidence = h('tbody');
    if (row.inputs.length === 0) {
      evidence.append(h('tr', {}, h('td', { colSpan: 3, className: 'cdp-scorecard-unavailable-reason' }, translate('countryBrief.fiveFactorScorecard.noEvidence'))));
    } else {
      evidence.append(...row.inputs.map((input) => renderEvidence(input, translate)));
    }
    details.append(h('div', { className: 'cdp-table-scroll' }, h('table', { className: 'cdp-scorecard-inputs' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Input'), h('th', { scope: 'col' }, 'Value · observation year'), h('th', { scope: 'col' }, 'Source & provenance'))), evidence)));
    panels.append(details);
  }
  select(0);
  container.dataset.evidenceExpanded = 'false';

  container.append(
    h('div', { className: 'cdp-scorecard-footer' },
      'Higher scores indicate stronger capacity. Coverage measures available evidence, independently of the score. ',
      translate('countryBrief.fiveFactorScorecard.methodologyVersion', { version: scorecard.methodologyVersion }),
      ' · ',
      h('a', {
        href: '/docs/methodology/five-factor-scorecard',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, translate('countryBrief.fiveFactorScorecard.methodologyLink')),
    ),
  );
  return container;
}
