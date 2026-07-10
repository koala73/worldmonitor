import { escapeHtml } from '../utils/sanitize';

type Translate = (key: string) => string;

export interface MilitaryVesselTooltipInput {
  name?: unknown;
  operatorCountry?: unknown;
  usniSource?: unknown;
}

export function renderMilitaryVesselTooltipHtml(
  vessel: MilitaryVesselTooltipInput,
  translate: Translate,
): string {
  const text = (value: unknown): string => escapeHtml(String(value ?? ''));
  const sourceLabel = vessel.usniSource
    ? `<br/><span style="color:#ffaa44;font-weight:600">${text(translate('popups.militaryVessel.estPosition'))}</span><br/><span style="opacity:.7">${text(translate('popups.militaryVessel.approximatePosition'))}</span>`
    : '';

  return `<div class="deckgl-tooltip"><strong>${text(vessel.name)}</strong><br/>${text(vessel.operatorCountry)}${sourceLabel}</div>`;
}
