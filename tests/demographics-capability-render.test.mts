import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';

import type { GetDemographicsCapabilityResponse } from '../src/generated/client/worldmonitor/resilience/v1/service_client.ts';

describe('demographics capability renderer', () => {
  it('renders independent groups, observation years, sources, and retained state', async () => {
    const window = new Window({ url: 'https://worldmonitor.app/' });
    const previousDocument = globalThis.document;
    const previousNode = globalThis.Node;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document });
    Object.defineProperty(globalThis, 'Node', { configurable: true, value: window.Node });
    try {
      const { renderDemographicsCapabilitySection } = await import(
        '../src/components/CountryDeepDivePanel-demographics-capability.ts'
      );
      const unavailable = { available: false, value: 0, year: 0, source: '', unit: '' };
      const response: GetDemographicsCapabilityResponse = {
        countryCode: 'DE',
        available: true,
        fetchedAt: '2026-08-18T00:00:00.000Z',
        stages: [
          { name: 'wpp', status: 'fresh', fetchedAt: '2026-08-18T00:00:00.000Z', recordCount: 200, newestObservationYear: 2026 },
          { name: 'education', status: 'retained', fetchedAt: '2026-07-18T00:00:00.000Z', recordCount: 180, newestObservationYear: 2024 },
          { name: 'ilostat', status: 'unavailable', fetchedAt: '', recordCount: 0, newestObservationYear: 0 },
        ],
        ageStructure: {
          available: true,
          medianAgeYears: { available: true, value: 45.7, year: 2026, source: 'UN WPP 2024', unit: 'years' },
          oldAgeDependencyRatioPercent: unavailable,
          totalDependencyRatioPercent: unavailable,
          workingAgePopulationPeople: unavailable,
          workingAgePopulationProjected10yPeople: unavailable,
        },
        education: {
          available: true,
          tertiaryEnrollmentGrossPercent: { available: true, value: 77.2, year: 2024, source: 'UNESCO UIS via World Bank WDI', unit: 'percent' },
          stemGraduatesSharePercent: unavailable,
          researchersPerMillion: unavailable,
        },
        industrialWorkforce: {
          available: false,
          craftTradesEmploymentPeople: unavailable,
          plantMachineOperatorsEmploymentPeople: unavailable,
          trainedIndustrialWorkforcePeople: unavailable,
          manufacturingEmploymentSharePercent: unavailable,
        },
      };
      const labels = new Map([
        ['countryBrief.demographicsCapability.ageStructure', 'Age structure'],
        ['countryBrief.demographicsCapability.education', 'Education pipeline'],
        ['countryBrief.demographicsCapability.industrialWorkforce', 'Industrial workforce'],
        ['countryBrief.demographicsCapability.medianAge', 'Median age'],
        ['countryBrief.demographicsCapability.tertiaryEnrollment', 'Tertiary enrollment'],
        ['countryBrief.demographicsCapability.notAvailable', 'Not available'],
      ]);
      const element = renderDemographicsCapabilitySection(
        response,
        (label, value, chipClass) => {
          const row = window.document.createElement('div');
          row.className = chipClass;
          row.textContent = `${label}: ${value}`;
          return row;
        },
        (key, params) => {
          if (key.endsWith('.source')) return `Sources: ${params?.sources}.`;
          if (key.endsWith('.retained')) return `${params?.stage} data retained from the last successful refresh.`;
          return labels.get(key) ?? key.split('.').at(-1) ?? key;
        },
      );
      const text = element.textContent;
      assert.match(text, /Median age: 45\.7 years · 2026/);
      assert.match(text, /Tertiary enrollment: 77\.2% · 2024/);
      assert.match(text, /Sources: UNESCO UIS via World Bank WDI\./);
      assert.match(text, /Education pipeline data retained from the last successful refresh\./);
      assert.match(text, /Industrial workforce/);
      assert.match(text, /Not available/);
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, 'Node', { configurable: true, value: previousNode });
      window.close();
    }
  });
});
