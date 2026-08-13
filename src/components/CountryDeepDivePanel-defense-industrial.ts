import type { GetDefenseIndustrialBaseResponse } from '@/generated/client/worldmonitor/military/v1/service_client';
import { t } from '@/services/i18n';
import { toFlagEmoji } from '@/utils/country-flag';
import {
  defenseIndustrialSourceKey,
  formatDefenseIndustrialMetric,
} from './defense-industrial-view-model';

type MetricFactory = (label: string, value: string, chipClass: string) => HTMLElement;

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderDefenseIndustrialSection(
  data: GetDefenseIndustrialBaseResponse,
  makeMetric: MetricFactory,
): HTMLElement {
  const section = el('div', 'cdp-defense-industrial');
  section.append(el('div', 'cdp-subtitle', t('countryBrief.defenseIndustrial.title')));

  const metrics = el('div', 'cdp-military-grid');
  const unavailable = t('countryBrief.defenseIndustrial.unavailable');
  const expenditure = formatDefenseIndustrialMetric(data.expenditurePctGdp, '%', false, unavailable);
  const personnel = formatDefenseIndustrialMetric(data.personnel, '', true, unavailable);
  const imports = formatDefenseIndustrialMetric(data.armsImportsTiv, ' TIV', false, unavailable);
  const concentration = data.suppliers.length > 0
    ? data.supplierHhi.toFixed(2)
    : t('countryBrief.defenseIndustrial.unavailable');
  const coverage = data.suppliers.length > 0
    ? `${(data.supplierMappingCoverage * 100).toFixed(1)}%`
    : t('countryBrief.defenseIndustrial.unavailable');
  metrics.append(
    makeMetric(t('countryBrief.defenseIndustrial.expenditure'), expenditure, 'cdp-chip-neutral'),
    makeMetric(t('countryBrief.defenseIndustrial.personnel'), personnel, 'cdp-chip-neutral'),
    makeMetric(t('countryBrief.defenseIndustrial.armsImports'), imports, 'cdp-chip-neutral'),
    makeMetric(
      t('countryBrief.defenseIndustrial.concentration'),
      concentration,
      data.supplierHhi >= 0.5 ? 'cdp-chip-danger' : 'cdp-chip-neutral',
    ),
    makeMetric(t('countryBrief.defenseIndustrial.coverage'), coverage, 'cdp-chip-neutral'),
  );
  section.append(metrics);

  if (data.suppliers.length > 0) {
    section.append(el('div', 'cdp-subtitle', t('countryBrief.defenseIndustrial.suppliers', {
      start: String(data.windowStartYear),
      end: String(data.windowEndYear),
    })));
    const list = el('ul', 'cdp-base-list');
    for (const supplier of data.suppliers.slice(0, 5)) {
      const row = el('li', 'cdp-base-item');
      row.append(
        el('span', 'cdp-base-name', `${toFlagEmoji(supplier.supplierIso2)} ${supplier.supplierIso2}`),
        el('span', 'cdp-base-distance', `${(supplier.tivShare * 100).toFixed(1)}%`),
      );
      list.append(row);
    }
    section.append(list);
    if (data.supplierRetained) {
      section.append(el('div', 'cdp-economic-source', t('countryBrief.defenseIndustrial.supplierRetained')));
    }
  }

  section.append(el('div', 'cdp-economic-source', t(defenseIndustrialSourceKey(data))));
  return section;
}
