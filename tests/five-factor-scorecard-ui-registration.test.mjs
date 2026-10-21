import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';
import { combineAbortSignals } from '../src/services/timeout-signal.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for scorecard panel work');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function supportedLocaleFiles() {
  const source = read('src/services/i18n.ts');
  const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
  assert.ok(declaration, 'SUPPORTED_LANGUAGES declaration must be extractable');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => `${match[1]}.json`).sort();
}

describe('five-factor scorecard country UI registration (#6441)', () => {
  it('mounts an abort-aware premium card through the canonical RPC service', async () => {
    const harness = await createCountryDeepDivePanelHarness({
      premiumAccess: true,
      scorecardResponse: {
        unavailable: false,
        unavailableReason: '',
        scorecard: {
          countryCode: 'DE', methodologyVersion: '1.0.0', computedAt: '2026-08-29T00:00:00.000Z',
          pillars: [{
            pillar: 'food', hasScore: false, score: 0, subScore: 0, band: '', inputCoverage: 0.55,
            aggregationMethod: 'country-weighted-components', inputs: [{
              inputId: 'food.productionBalance', available: true, value: 0.8, hasValue: true,
              year: 2024, unit: 'ratio', source: 'USDA PSD', sourceKey: 'resilience:food-stocks:v1',
              unavailableReason: '', quality: 'derived', observations: [],
            }, {
              inputId: 'food.importDiversity', available: false, value: 0, hasValue: false,
              year: 0, unit: '', source: 'UN Comtrade', sourceKey: 'comtrade:imports:v1',
              unavailableReason: 'source-unavailable', quality: 'unavailable', observations: [],
            }],
            insufficientReasons: ['coverage-below-floor'],
          }],
        },
      },
    });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      await waitFor(() => harness.getScorecardCalls().length === 1);
      assert.deepEqual(harness.getScorecardCalls(), [{ countryCode: 'DE', hasSignal: true }]);
      const text = harness.getPanelRoot().textContent;
      assert.match(text, /countryBrief\.fiveFactorScorecard\.pillars\.food/);
      assert.match(text, /countryBrief\.fiveFactorScorecard\.insufficient/);
      assert.match(text, /USDA PSD/);
      assert.match(text, /countryBrief\.fiveFactorScorecard\.reasons\.source-unavailable/);
      assert.doesNotMatch(text, /0\/5/);
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('does not call the premium RPC for a free user', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: false });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(harness.getScorecardCalls().length, 0);
      assert.match(harness.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.proLocked/);
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('reacts to auth and entitlement changes while the scorecard is mounted', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: false, scorecardMode: 'deferred-ignore-abort' });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      assert.match(harness.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.proLocked/);

      harness.setPremiumAccess(true, 'auth');
      await waitFor(() => harness.getPendingScorecards().length === 1);
      assert.match(harness.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.loading/);

      harness.setPremiumAccess(false, 'entitlement');
      assert.match(harness.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.proLocked/);
      harness.resolveScorecard(0, {
        unavailable: false,
        unavailableReason: '',
        scorecard: { countryCode: 'DE', methodologyVersion: '1.0.0', computedAt: '2026-08-29T00:00:00.000Z', pillars: [] },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(harness.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.proLocked/);
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('does not render a stale scorecard response after the selected country changes', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true, scorecardMode: 'deferred-ignore-abort' });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      await waitFor(() => harness.getPendingScorecards().length === 1);
      panel.show('France', 'FR', null, {});
      await waitFor(() => harness.getPendingScorecards().length === 2);
      const response = (countryCode, source) => ({
        unavailable: false,
        unavailableReason: '',
        scorecard: {
          countryCode,
          methodologyVersion: '1.0.0',
          computedAt: '2026-08-29T00:00:00.000Z',
          pillars: [{
            pillar: 'energy', hasScore: true, score: 4, subScore: 70, band: 'strong-capability', inputCoverage: 1,
            aggregationMethod: 'country-weighted-components', insufficientReasons: [],
            inputs: [{ inputId: 'energy.productionBalance', available: true, value: 1, hasValue: true, year: 2024, unit: 'ratio', source, sourceKey: 'energy:mix:v1:_all', unavailableReason: '', quality: 'derived', observations: [] }],
          }],
        },
      });
      harness.resolveScorecard(0, response('DE', 'STALE-DE-SOURCE'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.doesNotMatch(harness.getPanelRoot().textContent, /STALE-DE-SOURCE/);
      harness.resolveScorecard(1, response('FR', 'CURRENT-FR-SOURCE'));
      await waitFor(() => harness.getPanelRoot().textContent.includes('CURRENT-FR-SOURCE'));
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('suppresses expected abort errors and reports ordinary scorecard failures', async () => {
    const aborted = await createCountryDeepDivePanelHarness({ premiumAccess: true, scorecardMode: 'deferred' });
    try {
      const panel = aborted.createPanel();
      panel.show('Germany', 'DE', null, {});
      await waitFor(() => aborted.getPendingScorecards().length === 1);
      panel.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(aborted.getSentryExceptions().length, 0);
    } finally {
      aborted.cleanup();
    }

    const failed = await createCountryDeepDivePanelHarness({ premiumAccess: true, scorecardMode: 'reject' });
    try {
      const panel = failed.createPanel();
      panel.show('France', 'FR', null, {});
      await waitFor(() => failed.getSentryExceptions().length === 1);
      assert.match(failed.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.unavailable/);
      panel.close();
    } finally {
      failed.cleanup();
    }
  });

  it('turns a scorecard deadline into an unavailable state and observable failure', async () => {
    const service = read('src/services/scorecard.ts');
    assert.match(service, /SCORECARD_REQUEST_TIMEOUT_MS = 12_000/);
    assert.match(service, /createTimeoutSignal\(timeoutMs\)/);
    assert.match(service, /combineAbortSignals\(\[signal, timeoutSignal\]\)/);
    assert.match(service, /return withScorecardDeadline\(/);

    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true, scorecardMode: 'timeout' });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      await waitFor(() => harness.getSentryExceptions().length === 1);
      assert.match(harness.getPanelRoot().textContent, /countryBrief\.fiveFactorScorecard\.unavailable/);
      // A real deadline rejects with a zero-frame `signal timed out` reason,
      // which the dashboard's beforeSend drops as extension noise unless a
      // first-party report claims it with a `kind` tag. Without the tag this
      // capture was discarded on every engine.
      assert.deepEqual(harness.getSentryExceptions()[0].context.tags, {
        kind: 'country_deep_dive_load_failed',
        surface: 'country-deep-dive',
        widget: 'five-factor-scorecard',
      });
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('records which premium-access arm granted a denied scorecard fetch', async () => {
    // WORLDMONITOR-147: the widget fetches only when hasPremiumAccess() is
    // true, so a 401 means the client's belief and the credential the premium
    // injector attached disagreed. `api_key` (not the harness default) is the
    // arm that proves the point — it unlocks the panel from browser-local
    // state while asserting nothing about the signed-in account — and using a
    // non-default value here is what stops a hardcoded tag from passing.
    const harness = await createCountryDeepDivePanelHarness({
      premiumAccess: true,
      premiumGrant: 'api_key',
      entitlementBelief: { entitlementTier: null, authRole: null },
      scorecardMode: 'denied',
    });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      await waitFor(() => harness.getSentryExceptions().length === 1);
      const captured = harness.getSentryExceptions()[0];
      assert.deepEqual(captured.context.tags, {
        kind: 'country_deep_dive_load_failed',
        surface: 'country-deep-dive',
        widget: 'five-factor-scorecard',
        status: '401',
        premium_grant: 'api_key',
      });
      assert.deepEqual(captured.context.extra, {
        countryCode: 'DE',
        entitlementBelief: { entitlementTier: null, authRole: null },
      });
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('leaves a non-denial scorecard failure carrying no account state', async () => {
    // Preservation control for the rule above. A synthetic failure with no
    // `statusCode` says nothing about the plan, so the diagnostic must not
    // attach — otherwise every deadline and network blip ships the account's
    // entitlement belief to Sentry. Mutating the denial test alone cannot
    // catch that; this is the arm that goes red if the gate is widened.
    const harness = await createCountryDeepDivePanelHarness({
      premiumAccess: true,
      premiumGrant: 'api_key',
      scorecardMode: 'reject',
    });
    try {
      const panel = harness.createPanel();
      panel.show('Germany', 'DE', null, {});
      await waitFor(() => harness.getSentryExceptions().length === 1);
      const captured = harness.getSentryExceptions()[0];
      assert.deepEqual(captured.context.tags, {
        kind: 'country_deep_dive_load_failed',
        surface: 'country-deep-dive',
        widget: 'five-factor-scorecard',
      });
      assert.deepEqual(captured.context.extra, { countryCode: 'DE' });
      panel.close();
    } finally {
      harness.cleanup();
    }
  });

  it('composes cancellation when the native AbortSignal.any helper is absent', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    try {
      const lifecycle = new AbortController();
      const entitlement = new AbortController();
      const combined = combineAbortSignals([lifecycle.signal, entitlement.signal]);
      entitlement.abort();
      assert.equal(combined.aborted, true);
      assert.doesNotMatch(read('src/components/CountryDeepDivePanel.ts'), /AbortSignal\.any\(\[signal, accessSignal\]\)/);
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
      else delete AbortSignal.any;
    }
  });

  it('ships every scorecard label in every supported locale', () => {
    const locales = readdirSync(new URL('../src/locales/', import.meta.url))
      .filter((file) => file.endsWith('.json') && !file.endsWith('.shell.json'));
    assert.deepEqual(locales.sort(), supportedLocaleFiles());
    for (const file of locales) {
      const group = JSON.parse(read(`src/locales/${file}`)).countryBrief?.fiveFactorScorecard;
      assert.equal(typeof group?.title, 'string', `${file} is missing the scorecard title`);
      assert.equal(Object.keys(group?.pillars ?? {}).length, 5, `${file} is missing pillar labels`);
      assert.equal(Object.keys(group?.inputs ?? {}).length, 28, `${file} is missing input labels`);
      assert.equal(Object.keys(group?.reasons ?? {}).length, 9, `${file} is missing reason labels`);
    }
  });
});
