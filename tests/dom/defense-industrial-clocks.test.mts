import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefenseIndustrialResponse } from '../../shared/defense-industrial-response';
import { renderDefenseIndustrialSection } from '@/components/CountryDeepDivePanel-defense-industrial';
import { freezeBriefContent } from '@/components/CountryBriefOutput';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

const industrialAt = '2026-10-06T06:00:00.000Z';
const retainedImporterAt = '2026-09-29T05:00:00.000Z';
const latestSweepAt = '2026-10-06T07:00:00.000Z';

function response() {
  return buildDefenseIndustrialResponse('CA', {
    fetchedAt: industrialAt,
    countries: { CA: { expenditurePctGdp: { value: 1.3, year: 2024, source: 'World Bank' } } },
  }, {
    fetchedAt: latestSweepAt,
    importers: { CA: { fetchedAt: retainedImporterAt, retained: true,
      suppliers: [{ supplierIso2: 'US', tivShare: 1 }], mappingCoverage: 0.8,
      window: { startYear: 2021, endYear: 2025 }, source: 'SIPRI Arms Transfers Database' } },
  });
}

function render(data = response()) {
  return renderDefenseIndustrialSection(data, (label, value) => {
    const metric = document.createElement('div');
    metric.textContent = `${label} ${value}`;
    return metric;
  });
}

describe('defense source clocks in the country view and report', () => {
  it('shows independent producer assembly clocks and keeps retained importer time', () => {
    const data = response();
    expect(data.fetchedAt).toBe(retainedImporterAt);
    const text = render(data).textContent;
    expect(text).toContain(`World Bank snapshot assembled ${industrialAt}`);
    expect(text).toContain(`SIPRI (CA) snapshot assembled ${retainedImporterAt}`);
    expect(text).not.toContain(latestSweepAt);
    expect(text).toContain('1.3% · 2024');
    expect(text).toContain('Mapped coverage 80.0%');
    expect(text).toContain('Supplier data retained from the last successful importer refresh.');
  });

  it('preserves both original clocks and retention in the actual report freeze path', () => {
    const frozen = freezeBriefContent(render());
    expect(frozen.textContent).toContain(`World Bank snapshot assembled ${industrialAt}`);
    expect(frozen.textContent).toContain(`SIPRI (CA) snapshot assembled ${retainedImporterAt}`);
    expect(frozen.textContent).toContain('Supplier data retained');
    expect(frozen.textContent).not.toContain(latestSweepAt);
  });

  it('does not borrow the aggregate timestamp for missing source clocks', () => {
    const data = response();
    data.industrialFetchedAt = '';
    data.supplierFetchedAt = '';
    expect(render(data).textContent).not.toContain('snapshot assembled');
    expect(render(data).textContent).not.toContain(retainedImporterAt);
  });
});
