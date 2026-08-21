import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MARKETING_IGNORE_ERRORS,
  marketingBeforeSend,
  sanitizeMarketingRequestUrl,
  type PolicyEvent,
} from '../pro-test/src/sentry-filter-policy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * The marketing surface (`/` and `/pro`) runs its own `@sentry/react` client,
 * so none of `src/bootstrap/sentry-init.ts` applies to it. Every event below is
 * a real production event pulled from the 2026-08-19 triage; each `sdk` was
 * `sentry.javascript.react` with a null release, which is what distinguishes a
 * marketing-bundle event from a dashboard one.
 *
 * Both halves matter. The suppression cases prove the policy fires; the KEEP
 * cases are positive controls that prove each gate is load-bearing — delete the
 * length bound or the `!hasFirstParty` gate and a KEEP case goes red instead of
 * the suite staying green on absence alone.
 */

/**
 * Sentry's InboundFilters tests a pattern against the exception value AND the
 * combined `"<type>: <value>"` form — which is why entries like
 * `/^TypeError: Load failed/` can anchor on the type prefix.
 */
function isIgnored(type: string, value: string): boolean {
  return MARKETING_IGNORE_ERRORS.some((p) => p.test(value) || p.test(`${type}: ${value}`));
}

function event(value: string, filenames: string[] = []): PolicyEvent {
  return {
    exception: {
      values: [{
        value,
        stacktrace: { frames: filenames.map((filename) => ({ filename })) },
      }],
    },
  };
}

describe('marketing ignoreErrors', () => {
  it('drops the WKWebView host-bridge timeout (WORLDMONITOR-ZY)', () => {
    assert.equal(
      isIgnored('Error', 'WKWebView API client did not respond to this postMessage'),
      true,
    );
  });

  it('drops the extension runtime.sendMessage rejection (WORLDMONITOR-ZX)', () => {
    assert.equal(isIgnored('Error', 'Invalid call to runtime.sendMessage(). Tab not found.'), true);
  });

  it('drops the Zalo in-app-browser bridge global (WORLDMONITOR-102)', () => {
    // Verbatim production value; Safari phrases a missing global this way.
    assert.equal(isIgnored('ReferenceError', "Can't find variable: zaloJSV2"), true);
    // Chrome/Edge phrasing for the same missing global.
    assert.equal(isIgnored('ReferenceError', 'zaloJSV2 is not defined'), true);
  });

  // Positive control for the `\b` bounds on the Zalo entry: the pattern must
  // key on the identifier, not on a substring that a longer word contains.
  it('keeps an error that merely mentions a similar word', () => {
    assert.equal(isIgnored('ReferenceError', "Can't find variable: zaloJSV2Extended"), false);
  });

  // Positive control: the array must not have grown a pattern broad enough to
  // swallow an ordinary marketing-bundle bug.
  it('keeps a genuine first-party error message', () => {
    assert.equal(
      isIgnored('TypeError', "Cannot read properties of undefined (reading 'entitlement')"),
      false,
    );
    assert.equal(isIgnored('Error', 'Dodo checkout session could not be created'), false);
  });
});

describe('marketing Sentry request URL privacy', () => {
  it('removes query strings and unsafe auth fragments from production event URLs', () => {
    assert.equal(
      sanitizeMarketingRequestUrl(
        'https://www.worldmonitor.app/pro?wm_referral=private#access_token=private',
      ),
      'https://www.worldmonitor.app/pro',
    );
  });

  it('retains only approved public marketing routes and section hashes', () => {
    assert.equal(
      sanitizeMarketingRequestUrl(
        'https://www.worldmonitor.app/pro/?checkout_session=private#pricing',
      ),
      'https://www.worldmonitor.app/pro#pricing',
    );
    assert.equal(
      sanitizeMarketingRequestUrl('https://www.worldmonitor.app/?ref=private#enterprise-contact'),
      'https://www.worldmonitor.app/#enterprise-contact',
    );
    assert.equal(
      sanitizeMarketingRequestUrl('https://www.worldmonitor.app/dashboard?token=private'),
      undefined,
    );
    assert.equal(sanitizeMarketingRequestUrl('not a URL?token=private'), undefined);
  });
});

describe('marketingBeforeSend — bare minified symbol', () => {
  it('drops a whole-message minified symbol (WORLDMONITOR-ZZ "ga", -ZW "Ba")', () => {
    // Real frames: the prerendered welcome document itself, from an iOS
    // Google-app in-app browser injecting its own script.
    assert.equal(marketingBeforeSend(event('ga', ['https://www.worldmonitor.app/'])), null);
    assert.equal(marketingBeforeSend(event('Ba', ['https://www.worldmonitor.app/'])), null);
  });

  // Positive control for the length bound. `plan` is 4 characters, so the gate
  // must let it through; without this, widening `<= 3` to `<= 8` would go
  // unnoticed and start hiding real errors.
  it('keeps a 4-character message', () => {
    const kept = event('plan');
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control for the "identifier only" shape.
  it('keeps a short message that is not a bare identifier', () => {
    for (const value of ['404', 'a b', '']) {
      const kept = event(value);
      assert.equal(marketingBeforeSend(kept), kept, `expected ${JSON.stringify(value)} kept`);
    }
  });
});

describe('marketingBeforeSend — stale chunk after deploy', () => {
  it('drops the zero-frame Safari phrasing (WORLDMONITOR-15)', () => {
    // The real event carried no stacktrace at all.
    assert.equal(marketingBeforeSend(event('Importing a module script failed.')), null);
  });

  it('drops the Chrome and Firefox phrasings and the link-time counterpart', () => {
    for (const value of [
      'Failed to fetch dynamically imported module: https://www.worldmonitor.app/pro/assets/index-a1b2c3.js',
      'error loading dynamically imported module',
      "Importing binding name 'WelcomeApp' is not found.",
    ]) {
      assert.equal(marketingBeforeSend(event(value)), null, `expected ${value} dropped`);
    }
  });

  it('ignores the Sentry SDK chunk when deciding first-partyness', () => {
    // Only frame is Sentry's own hashed chunk → still no first-party evidence.
    assert.equal(
      marketingBeforeSend(event('Importing a module script failed.', [
        '/pro/assets/sentry-DMxp_zBn.js',
      ])),
      null,
    );
  });

  // Positive control for the `!hasFirstParty` gate. A module-load failure that
  // DOES ride one of our own chunks is a real `import()` regression and must
  // survive; drop the gate and this goes red.
  it('keeps a module-load failure that carries a marketing-bundle frame', () => {
    const kept = event('Failed to fetch dynamically imported module', [
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  it('keeps a module-load failure that carries a source-mapped frame', () => {
    const kept = event('Importing a module script failed.', ['pro-test/src/WelcomeApp.tsx']);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control: an ordinary crash must pass straight through.
  it('keeps an ordinary first-party crash', () => {
    const kept = event("Cannot read properties of undefined (reading 'plan')", [
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });
});

describe('marketingBeforeSend — injected-script recursion', () => {
  it('drops the document-framed stack overflow (WORLDMONITOR-103)', () => {
    // Verbatim production event: Chrome Mobile iOS, every frame on the
    // prerendered document, whose reported lines sit inside inert JSON-LD.
    assert.equal(
      marketingBeforeSend(event('Maximum call stack size exceeded.', [
        'https://www.worldmonitor.app/',
        'https://www.worldmonitor.app/',
      ])),
      null,
    );
  });

  it('drops the Chrome and Firefox phrasings', () => {
    for (const value of ['Maximum call stack size exceeded', 'too much recursion']) {
      assert.equal(
        marketingBeforeSend(event(value, ['https://www.worldmonitor.app/'])),
        null,
        `expected ${value} dropped`,
      );
    }
  });

  // Positive control for the `!hasFirstParty` gate. A render loop inside our
  // own bundle is the realistic first-party cause of this exact message and
  // must still page; delete the gate and this goes red.
  it('keeps a stack overflow that carries a marketing-bundle frame', () => {
    const kept = event('Maximum call stack size exceeded.', [
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  it('keeps a stack overflow that carries a source-mapped frame', () => {
    const kept = event('too much recursion', ['pro-test/src/WelcomeApp.tsx']);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control that the recursion pattern is not broad enough to swallow
  // an ordinary frameless crash from this bundle.
  it('keeps an unrelated frameless error', () => {
    const kept = event('Dodo checkout session could not be created');
    assert.equal(marketingBeforeSend(kept), kept);
  });
});

describe('policy wiring', () => {
  // A perfect policy that nothing calls filters nothing. The values themselves
  // are exercised above; this only proves `Sentry.init` actually receives them.
  it('initSentry passes both halves of the policy to Sentry.init', () => {
    const source = readFileSync(resolve(root, 'pro-test/src/sentry.ts'), 'utf8');
    assert.match(source, /from '\.\/sentry-filter-policy'/);
    assert.match(source, /ignoreErrors:\s*MARKETING_IGNORE_ERRORS/);
    assert.match(
      source,
      /beforeSend:\s*\(event\)\s*=>\s*\{\s*const filteredEvent = marketingBeforeSend\(event\);/,
    );
    assert.match(source, /sanitizeMarketingRequestUrl\(filteredEvent\.request\.url\)/);
  });

  it('does not copy the dashboard array wholesale', () => {
    // The dashboard list is vetted against a different bundle (deck.gl /
    // MapLibre / Convex). If someone bulk-copies it here, the marketing surface
    // silently inherits suppressors for messages this bundle can emit.
    const dashboard = readFileSync(resolve(root, 'src/bootstrap/sentry-init.ts'), 'utf8');
    const dashboardCount = (dashboard.match(/^\s{6}\/.*\/,\s*(\/\/.*)?$/gm) ?? []).length;
    assert.ok(dashboardCount > 100, `sanity: expected a large dashboard array, got ${dashboardCount}`);
    assert.ok(
      MARKETING_IGNORE_ERRORS.length < 20,
      `marketing array must stay a vetted subset, got ${MARKETING_IGNORE_ERRORS.length}`,
    );
  });
});
