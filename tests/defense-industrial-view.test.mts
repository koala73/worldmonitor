import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GetDefenseIndustrialBaseResponse } from '../src/generated/client/worldmonitor/military/v1/service_client.ts';
import {
  defenseIndustrialSourceKey,
  formatDefenseIndustrialMetric,
} from '../src/components/defense-industrial-view-model.ts';

function response(overrides: Partial<GetDefenseIndustrialBaseResponse> = {}): GetDefenseIndustrialBaseResponse {
  const unavailable = { available: false, value: 0, year: 0, previousValue: 0, previousYear: 0, source: '' };
  return {
    countryCode: 'UA',
    available: true,
    expenditurePctGdp: unavailable,
    expenditureUsd: unavailable,
    personnel: unavailable,
    armsExportsTiv: unavailable,
    armsImportsTiv: unavailable,
    suppliers: [],
    supplierHhi: 0,
    windowStartYear: 0,
    windowEndYear: 0,
    supplierSource: '',
    fetchedAt: '',
    industrialFetchedAt: '',
    supplierFetchedAt: '',
    supplierRetained: false,
    supplierMappingCoverage: 0,
    ...overrides,
  };
}

describe('defense-industrial country view', () => {
  it('attributes a World-Bank-only response only to World Bank', () => {
    assert.equal(defenseIndustrialSourceKey(response()), 'countryBrief.defenseIndustrial.sourceWorldBank');
  });

  it('uses combined attribution only when supplier data is present', () => {
    assert.equal(defenseIndustrialSourceKey(response({
      suppliers: [{ supplierIso2: 'US', tivShare: 1 }],
      supplierSource: 'SIPRI Arms Transfers Database',
    })), 'countryBrief.defenseIndustrial.source');
  });

  it('formats the observation year and trend from metric content time', () => {
    assert.match(formatDefenseIndustrialMetric({
      available: true,
      value: 34.5,
      year: 2024,
      previousValue: 30,
      previousYear: 2023,
      source: 'World Bank',
    }, '%'), /34\.5% · 2024 ↑/);
  });
});
