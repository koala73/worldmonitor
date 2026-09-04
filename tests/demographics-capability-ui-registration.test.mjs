import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for demographics panel work');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function supportedLocaleFiles() {
  const source = read('src/services/i18n.ts');
  const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
  assert.ok(declaration, 'SUPPORTED_LANGUAGES declaration must be extractable');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => `${match[1]}.json`).sort();
}

describe('demographics capability country UI registration (#6437)', () => {
  it('mounts an abort-aware premium card through the canonical RPC service', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', {
        score: 42,
        trend: 'stable',
        lastUpdated: '2026-08-18T00:00:00.000Z',
        components: { unrest: 10, conflict: 20, security: 30, information: 40 },
      }, {});

      await waitFor(() => harness.getDemographicsCalls().length === 1);
      assert.deepEqual(harness.getDemographicsCalls(), [{ countryCode: 'DE', hasSignal: true }]);
      assert.match(
        harness.getPanelRoot().textContent,
        /countryBrief\.demographicsCapability\.(title|unavailable)/,
      );
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('does not start a stale country request after the service chunk resolves', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      const score = {
        score: 42,
        trend: 'stable',
        lastUpdated: '2026-08-18T00:00:00.000Z',
        components: { unrest: 10, conflict: 20, security: 30, information: 40 },
      };
      panel.show('Germany', 'DE', score, {});
      panel.show('France', 'FR', score, {});

      await waitFor(() => harness.getDemographicsCalls().length === 1);
      assert.deepEqual(harness.getDemographicsCalls(), [{ countryCode: 'FR', hasSignal: true }]);
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('ships every demographics label in every supported locale', () => {
    const required = [
      'title', 'help', 'loading', 'unavailable', 'proLocked', 'notAvailable',
      'ageStructure', 'education', 'industrialWorkforce', 'medianAge',
      'oldAgeDependency', 'totalDependency', 'workingAgePopulation',
      'workingAgeProjection', 'tertiaryEnrollment', 'stemGraduates', 'researchers',
      'craftTrades', 'plantOperators', 'trainedIndustrialWorkforce',
      'manufacturingShare', 'source', 'retained',
    ];
    const locales = readdirSync(new URL('../src/locales/', import.meta.url))
      .filter((file) => file.endsWith('.json') && !file.endsWith('.shell.json'));
    assert.deepEqual(locales.sort(), supportedLocaleFiles());
    for (const file of locales) {
      const group = JSON.parse(read(`src/locales/${file}`)).countryBrief?.demographicsCapability;
      for (const key of required) {
        assert.equal(typeof group?.[key], 'string', `${file} is missing countryBrief.demographicsCapability.${key}`);
      }
    }
  });
});
