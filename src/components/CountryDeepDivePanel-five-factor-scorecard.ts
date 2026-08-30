import type { GetFiveFactorScorecardResponse } from '@/generated/client/worldmonitor/scorecard/v1/service_client';
import { h } from '@/utils/dom-utils';
import {
  buildFiveFactorPillarRows,
  formatScorecardEvidence,
  type FiveFactorPillarId,
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
  const row = h('div', { className: `cdp-scorecard-input${formatted.available ? '' : ' is-unavailable'}` });
  const heading = h('div', { className: 'cdp-scorecard-input-heading' },
    h('span', { className: 'cdp-scorecard-input-label' }, translate(inputLabelKey(formatted.inputId))),
    h('span', { className: 'cdp-scorecard-input-value' }, formatted.valueLabel),
  );
  row.append(heading);
  if (formatted.provenance) {
    row.append(h('div', { className: 'cdp-economic-source' }, formatted.provenance));
  }
  if (formatted.unavailableReason) {
    row.append(h('div', { className: 'cdp-scorecard-unavailable-reason' }, reasonLabel(formatted.unavailableReason, translate)));
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
    container.append(h('div', { className: 'cdp-empty' }, translate('countryBrief.fiveFactorScorecard.unavailable')));
    return container;
  }

  const rows = buildFiveFactorPillarRows(scorecard.pillars, {
    insufficient: translate('countryBrief.fiveFactorScorecard.insufficient'),
    score: (value) => translate('countryBrief.fiveFactorScorecard.score', { score: String(value) }),
    coverage: (value) => translate('countryBrief.fiveFactorScorecard.coverage', { coverage: String(value) }),
  });

  for (const row of rows) {
    const details = h('details', { className: `cdp-scorecard-pillar is-${row.status}` });
    const summary = h('summary', { className: 'cdp-scorecard-summary' },
      h('span', { className: 'cdp-scorecard-pillar-name' }, translate(`countryBrief.fiveFactorScorecard.pillars.${row.pillar as FiveFactorPillarId}`)),
      h('span', { className: 'cdp-scorecard-score' }, row.scoreLabel),
      h('span', { className: 'cdp-scorecard-coverage' }, row.coverageLabel),
    );
    details.append(summary);
    if (row.reasons.length > 0) {
      details.append(h('div', { className: 'cdp-scorecard-reasons' },
        ...row.reasons.map((reason) => h('span', { className: 'cdp-scorecard-reason' }, reasonLabel(reason, translate))),
      ));
    }
    const evidence = h('div', { className: 'cdp-scorecard-inputs' });
    if (row.inputs.length === 0) {
      evidence.append(h('div', { className: 'cdp-scorecard-unavailable-reason' }, translate('countryBrief.fiveFactorScorecard.noEvidence')));
    } else {
      evidence.append(...row.inputs.map((input) => renderEvidence(input, translate)));
    }
    details.append(evidence);
    container.append(details);
  }

  container.append(
    h('div', { className: 'cdp-scorecard-footer' },
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
