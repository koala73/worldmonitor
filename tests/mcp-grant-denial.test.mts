/**
 * #5622 — how the apex `/mcp-grant` consent page reacts to a handshake denial.
 *
 * The bug this pins: `api/internal/mcp-grant-{context,mint}` now answer an
 * unverifiable entitlement with a retryable 503 `TIER_VERIFICATION_UNAVAILABLE`,
 * but the page's error mapping was a `switch` with a terminal `default`. An
 * unknown code therefore rendered "could not be completed. Start over from your
 * MCP client." and destroyed the consent card — turning the one denial the user
 * could have simply clicked through into a dead end.
 *
 * The module under test is a zero-import leaf so it stays importable under
 * `tsx --test`: `src/mcp-grant-main.ts` boots Clerk and touches
 * window/localStorage at import time, which is why the decision was unreachable
 * from a test before it was extracted (same constraint as
 * tests/premium-denial.test.mts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyGrantDenial,
  describeGrantDelay,
  grantErrorMessage,
  grantErrorTitle,
  MAX_INLINE_GRANT_WAIT_MS,
  retryableGrantDelayMs,
  routeGrantContextDenial,
  shouldWaitInline,
} from '../src/services/mcp-grant-denial.ts';

describe('grantErrorMessage', () => {
  it('gives the retryable code copy that invites another attempt', () => {
    const msg = grantErrorMessage('TIER_VERIFICATION_UNAVAILABLE');
    assert.match(msg, /temporary/i);
    assert.match(msg, /try again/i);
    assert.doesNotMatch(
      msg,
      /Start over from your MCP client/,
      'the nonce is still valid — sending the user back to their client wastes it',
    );
  });

  it('keeps the terminal codes terminal', () => {
    assert.match(grantErrorMessage('INVALID_NONCE'), /expired or is invalid/);
    assert.match(grantErrorMessage('INSUFFICIENT_TIER'), /Pro subscription is required/);
    assert.match(grantErrorMessage('UNKNOWN_CLIENT'), /no longer registered/);
    assert.match(grantErrorMessage('INVALID_REDIRECT_URI'), /not allowed/);
  });

  it('covers NONCE_CLAIMED_BY_OTHER_USER rather than falling through to the generic copy', () => {
    // The anti-hijack 403 (F2) existed before this module and was NOT in the
    // page's switch, so a victim saw generic copy for a security-relevant state.
    const msg = grantErrorMessage('NONCE_CLAIMED_BY_OTHER_USER');
    assert.match(msg, /another account/i);
    assert.notEqual(msg, grantErrorMessage('SOMETHING_ELSE'));
  });

  it('falls back for an unknown or absent code', () => {
    const fallback = grantErrorMessage(undefined);
    assert.match(fallback, /could not be completed/);
    assert.equal(grantErrorMessage('WHATEVER_NEW_CODE'), fallback);
    assert.equal(grantErrorMessage(''), fallback);
  });

  it('does not resolve inherited object properties as messages', () => {
    // `code` comes from a server JSON body, so a plain index lookup would return
    // Object.prototype members — a `code` of "toString" yielded a Function, which
    // renders as source text in the error view.
    for (const code of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const msg = grantErrorMessage(code);
      assert.equal(typeof msg, 'string', `${code} must not resolve to a non-string`);
      assert.equal(msg, grantErrorMessage(undefined), `${code} must take the fallback`);
    }
  });
});

describe('grantErrorTitle', () => {
  /**
   * The page rendered ONE heading — "Authorization request expired" — above every
   * terminal body. Only `INVALID_NONCE` is actually an expiry, so the other six
   * disagreed with the text underneath them. The worst pair shipped on the flow
   * this change exists to improve.
   */
  it('does not call a Pro-subscription denial an expiry', () => {
    const title = grantErrorTitle('INSUFFICIENT_TIER');
    assert.equal(title, 'Pro subscription required');
    assert.doesNotMatch(
      title,
      /expired/i,
      'a caller without Pro was told their request expired, which points at the '
      + 'wrong remedy — restarting from the client cannot fix a missing subscription',
    );
  });

  it('does not disguise the anti-phishing and hijack refusals as an expiry', () => {
    // These two are security-relevant states; labelling them "expired" hides the
    // signal that something was actively refused.
    assert.doesNotMatch(grantErrorTitle('INVALID_REDIRECT_URI'), /expired/i);
    assert.doesNotMatch(grantErrorTitle('NONCE_CLAIMED_BY_OTHER_USER'), /expired/i);
  });

  it('reserves the expiry heading for the one code that is an expiry', () => {
    assert.equal(grantErrorTitle('INVALID_NONCE'), 'Authorization request expired');
    const expiryTitled = Object.keys({
      INVALID_NONCE: 0,
      UNKNOWN_CLIENT: 0,
      INVALID_REDIRECT_URI: 0,
      INSUFFICIENT_TIER: 0,
      NONCE_CLAIMED_BY_OTHER_USER: 0,
      CONFIGURATION_ERROR: 0,
      SERVICE_UNAVAILABLE: 0,
      TIER_VERIFICATION_UNAVAILABLE: 0,
    }).filter((code) => /expired/i.test(grantErrorTitle(code)));
    assert.deepEqual(expiryTitled, ['INVALID_NONCE']);
  });

  it('falls back without resolving inherited object properties', () => {
    const fallback = grantErrorTitle(undefined);
    assert.equal(fallback, 'Authorization failed');
    for (const code of ['constructor', 'toString', '__proto__', 'WHATEVER_NEW_CODE']) {
      assert.equal(typeof grantErrorTitle(code), 'string');
      assert.equal(grantErrorTitle(code), fallback);
    }
  });

  it('travels on the verdict so the heading and body cannot be sourced separately', () => {
    // Deriving both from the same code in one place is what stops them drifting.
    for (const code of ['INSUFFICIENT_TIER', 'INVALID_NONCE', 'TIER_VERIFICATION_UNAVAILABLE']) {
      const verdict = classifyGrantDenial(403, code);
      assert.equal(verdict.title, grantErrorTitle(code));
      assert.equal(verdict.message, grantErrorMessage(code));
    }
    assert.equal(classifyGrantDenial(401, 'UNAUTHENTICATED').title, grantErrorTitle('UNAUTHENTICATED'));
  });
});

describe('retryableGrantDelayMs', () => {
  it('honors the advertised delay', () => {
    assert.equal(retryableGrantDelayMs('5'), 5_000);
    assert.equal(retryableGrantDelayMs('1'), 1_000);
    assert.equal(retryableGrantDelayMs('22'), 22_000);
  });

  it('falls back to the server default for a missing or unusable header', () => {
    // RFC 9110 also permits an HTTP-date, which Number() makes NaN — the default
    // is the right answer there rather than re-enabling instantly.
    for (const header of [null, '', 'soon', '0', '-3', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      assert.equal(
        retryableGrantDelayMs(header),
        5_000,
        `Retry-After ${JSON.stringify(header)} must fall back to the 5s default`,
      );
    }
  });

  it('clamps to the server ceiling rather than disabling the button indefinitely', () => {
    assert.equal(retryableGrantDelayMs('60'), 60_000);
    assert.equal(retryableGrantDelayMs('3600'), 60_000);
  });

  it('never returns 0 — re-enabling instantly walks into the negative cache', () => {
    for (const header of [null, '0', '-1', '0.1', 'nonsense']) {
      assert.ok(
        retryableGrantDelayMs(header) > 0,
        `Retry-After ${JSON.stringify(header)} must still impose a wait`,
      );
    }
  });
});

describe('classifyGrantDenial', () => {
  it('#5622: the retryable entitlement code keeps the consent card', () => {
    assert.deepEqual(
      classifyGrantDenial(503, 'TIER_VERIFICATION_UNAVAILABLE').action,
      'retryable',
    );
  });

  it('a Redis transport 503 is retryable too — it always read that way, it just could not say so', () => {
    assert.equal(classifyGrantDenial(503, 'SERVICE_UNAVAILABLE').action, 'retryable');
  });

  it('a 401 is sign-in regardless of body, matching the page it replaced', () => {
    for (const code of [undefined, 'UNAUTHENTICATED', 'TIER_VERIFICATION_UNAVAILABLE']) {
      assert.equal(classifyGrantDenial(401, code).action, 'sign_in');
    }
  });

  it('every terminal code stays terminal', () => {
    for (const code of [
      'INVALID_NONCE',
      'UNKNOWN_CLIENT',
      'INVALID_REDIRECT_URI',
      'INSUFFICIENT_TIER',
      'NONCE_CLAIMED_BY_OTHER_USER',
      'CONFIGURATION_ERROR',
    ]) {
      assert.equal(
        classifyGrantDenial(403, code).action,
        'terminal',
        `${code} must not become a retry loop`,
      );
    }
  });

  it('a bare 503 with no readable code is terminal — an intermediary is not the handshake', () => {
    // Retrying on status alone would loop against a CDN/WAF page forever. The
    // retryable set is an explicit allowlist for exactly this reason.
    assert.equal(classifyGrantDenial(503, undefined).action, 'terminal');
    assert.equal(classifyGrantDenial(503, 'Bad Gateway').action, 'terminal');
  });

  it('a confirmed lapse is terminal even though it arrives on the same gate', () => {
    // The server keeps INSUFFICIENT_TIER for a provider-confirmed lapse; the page
    // must not retry it just because a X-Billing-Verification header is present.
    assert.equal(classifyGrantDenial(403, 'INSUFFICIENT_TIER').action, 'terminal');
  });

  it('the verdict always carries the message for the same code', () => {
    for (const [status, code] of [[503, 'TIER_VERIFICATION_UNAVAILABLE'], [403, 'INVALID_NONCE'], [401, undefined]] as const) {
      assert.equal(classifyGrantDenial(status, code).message, grantErrorMessage(code));
    }
  });
});

describe('routeGrantContextDenial', () => {
  it('spends exactly one automatic retry before exposing the manual retry action', () => {
    assert.equal(routeGrantContextDenial('retryable', 'idle', 1), 'retry');
    assert.equal(routeGrantContextDenial('retryable', 'idle', 0), 'show_retry');
  });

  it('preserves consent for a retryable Clerk context reload throughout the mint lifecycle', () => {
    assert.equal(
      routeGrantContextDenial('retryable', 'in_flight', 1),
      'preserve_consent',
    );
    assert.equal(
      routeGrantContextDenial('retryable', 'retry_cooldown', 0),
      'preserve_consent',
    );
  });

  it('keeps terminal and sign-in denials out of every retry path', () => {
    for (const phase of ['idle', 'in_flight', 'retry_cooldown'] as const) {
      assert.equal(routeGrantContextDenial('terminal', phase, 1), 'terminal');
      assert.equal(routeGrantContextDenial('sign_in', phase, 1), 'sign_in');
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring: call-site COUNT pins only
// ---------------------------------------------------------------------------

/**
 * The page builds its DOM against real elements, so there is no jsdom here to
 * drive it end-to-end. Deliberately NOT a proximity regex on the retry branch —
 * that shape has been demonstrated to pass with the bug restored verbatim
 * (memory: source-regex wiring guards false-pass). What is pinned instead is
 * structural and countable: the page routes both fetches through the classifier
 * and no longer holds its own copy of the mapping.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(resolve(root, 'src/mcp-grant-main.ts'), 'utf8');

describe('mcp-grant page routes denials through the shared classifier', () => {
  it('classifies both the context load and the mint click', () => {
    const calls = [...pageSource.matchAll(/classifyGrantDenial\(/g)];
    assert.equal(
      calls.length,
      2,
      'expected exactly two call sites — loadContext and onAuthorizeClick. '
      + 'A third means a new fetch, a missing one means a path went unclassified.',
    );
  });

  it('no longer carries its own error-code switch', () => {
    assert.doesNotMatch(
      pageSource,
      /function errorCodeToMessage/,
      'a second copy of the mapping is how the two drift',
    );
  });

  it('re-enables the Authorize button through one shared helper', () => {
    // A retryable denial is worthless if the button stays disabled.
    assert.equal(
      [...pageSource.matchAll(/btn\.disabled = false/g)].length,
      1,
      'button re-enabling must stay in the single `reenable` helper',
    );
    // Four immediate call sites (network-error catch, sign_in, unparseable mint
    // response, and the too-long-to-wait retryable branch which hands the button
    // straight back rather than parking it for up to 60s) plus one DEFERRED
    // hand-back for the short retryable branch, which waits out Retry-After
    // first. Counting both forms keeps a future branch that forgets either one
    // from passing.
    const immediate = [...pageSource.matchAll(/reenable\(\)/g)].length;
    const deferred = [...pageSource.matchAll(/setTimeout\(reenable\b/g)].length;
    assert.equal(immediate, 4, 'the four immediate exits must hand the button back');
    assert.equal(deferred, 1, 'the retryable exit must hand it back after the advertised delay');
  });

  it('tracks the mint cooldown phase and timeout so Clerk reloads cannot strand consent', () => {
    assert.match(pageSource, /let mintPhase: GrantMintPhase = 'idle'/);
    assert.match(pageSource, /mintPhase = 'retry_cooldown'/);
    assert.match(pageSource, /let mintRetryTimeout: number \| null = null/);
    assert.match(pageSource, /mintRetryTimeout = window\.setTimeout\(reenable, waitMs\)/);
    assert.match(pageSource, /window\.clearTimeout\(mintRetryTimeout\)/);
    assert.doesNotMatch(pageSource, /mintInFlight/);
  });

  it('uses one Retry-After delay before rendering a non-expired manual retry view', () => {
    assert.match(pageSource, /const CONTEXT_AUTO_RETRY_BUDGET = 1/);
    assert.equal(
      [...pageSource.matchAll(/retryableGrantDelayMs\(resp\.headers\.get\('Retry-After'\)\)/g)]
        .length,
      2,
      'both the context auto-retry and mint cooldown must honor Retry-After',
    );
    assert.match(pageSource, /showRetryableContextView\(verdict\.message\)/);
    assert.match(pageSource, /'retryContextBtn'\)\.addEventListener\('click'/);

    const html = readFileSync(resolve(root, 'mcp-grant.html'), 'utf8');
    assert.match(html, /id="errorTitle"/);
    assert.match(html, /id="retryContextBtn" hidden>Try again<\/button>/);
    assert.doesNotMatch(
      pageSource.match(/function showRetryableContextView[\s\S]*?\n}/)?.[0] ?? '',
      /expired/i,
      'a transient context failure must not be labelled as an expired request',
    );
  });

  /**
   * WHAT THESE PINS DO NOT COVER — stated so nobody mistakes green for covered.
   *
   * They assert occurrence counts, not the verdict -> DOM mapping. Swapping the
   * bodies of the `retryable` and `terminal` branches in onAuthorizeClick would
   * leave every count identical and every pin green, while the user got a torn-down
   * page for a transient blip and a stuck consent card for a dead nonce.
   *
   * That mapping is genuinely uncovered: the page manipulates real elements, this
   * repo has no jsdom, and there is no e2e spec for /mcp-grant. The decision it
   * routes on IS unit-tested (classifyGrantDenial above), so what is missing is
   * only the wiring — which is exactly the class a regex cannot honestly pin
   * (memory: source-regex wiring guards false-pass). Tracked in #5654.
   */
  it('never renders an error view without saying what the error is', () => {
    // The heading is required, so a new error path cannot inherit a stale
    // default. Assert no call site relies on one-argument form.
    const singleArg = [...pageSource.matchAll(/showErrorView\((?:[^(),]|\([^)]*\))*\)/g)]
      .map((m) => m[0])
      .filter((call) => !call.includes(','));
    assert.deepEqual(
      singleArg,
      [],
      'every showErrorView call must pass an explicit title — the removed default '
      + 'said "Authorization request expired" above bodies that were not expiries',
    );
  });

  it('wires the recovery controls before the first load can reject', () => {
    // `void bootstrap()` swallows a rejection, so listeners attached after the
    // first await can be skipped entirely — leaving a visible "Try again" button
    // that does nothing.
    const retryWiring = pageSource.indexOf("$('retryContextBtn').addEventListener");
    const authorizeWiring = pageSource.indexOf("$('authorizeBtn').addEventListener");
    const firstLoad = pageSource.indexOf('await reactToAuth()');
    assert.ok(retryWiring > 0 && authorizeWiring > 0 && firstLoad > 0, 'anchors must exist');
    assert.ok(retryWiring < firstLoad, 'retry button must be wired before the first load');
    assert.ok(authorizeWiring < firstLoad, 'authorize button must be wired before the first load');
  });

  it('documents the uncovered verdict-to-DOM wiring rather than implying it is pinned', () => {
    // A canary, not a guard: if the page stops routing through the classifier at
    // all, the count pin above already fails. This exists so the limitation is
    // visible in the suite output rather than only in a comment.
    assert.match(pageSource, /verdict\.action === 'retryable'/);
    assert.match(pageSource, /showErrorView\(verdict\.message, verdict\.title\)/);
  });
});

/**
 * #5622 review — the inline-wait budget.
 *
 * The server may legitimately ask for a full minute: `renewal_verification_failed`
 * carries the per-subscription provider cooldown (`ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS`
 * = 60s). Honoring that inline parks the consent page on a spinner, or leaves
 * Authorize dead on "Retry shortly…", for that whole minute. The sibling client
 * (src/services/notification-channels.ts) already declined to auto-wait past 10s
 * for the identical state; these pin the same judgment here.
 */
describe('inline-wait budget (#5622 review)', () => {
  it('waits out the short delays the retryable states actually ask for', () => {
    // entitlement_verification_unavailable: fixed 5s.
    assert.equal(shouldWaitInline(retryableGrantDelayMs('5')), true);
    // renewal_verification_pending: 1-3s from the Dodo re-check window.
    assert.equal(shouldWaitInline(retryableGrantDelayMs('1')), true);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('3')), true);
    // The server's own default when the header is absent.
    assert.equal(shouldWaitInline(retryableGrantDelayMs(null)), true);
  });

  it('declines to block the page on the 60s renewal cooldown', () => {
    assert.equal(shouldWaitInline(retryableGrantDelayMs('60')), false);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('30')), false);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('11')), false);
  });

  it('accepts the boundary exactly, so the threshold is not off by one', () => {
    assert.equal(shouldWaitInline(MAX_INLINE_GRANT_WAIT_MS), true);
    assert.equal(shouldWaitInline(MAX_INLINE_GRANT_WAIT_MS + 1), false);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('10')), true);
  });

  it('matches the sibling client budget, so the two cannot silently diverge', () => {
    // src/services/notification-channels.ts::BILLING_RETRY_MAX_DELAY_MS.
    assert.equal(MAX_INLINE_GRANT_WAIT_MS, 10_000);
  });

  it('names the wait in copy the user can act on', () => {
    assert.equal(describeGrantDelay(60_000), 'about 60 seconds');
    assert.equal(describeGrantDelay(5_000), 'about 5 seconds');
    assert.equal(describeGrantDelay(1_000), 'about 1 second');
    // Sub-second never rounds to "about 0 seconds".
    assert.equal(describeGrantDelay(200), 'about 1 second');
  });

  it('the page routes the too-long case to the manual retry instead of sleeping', () => {
    assert.match(pageSource, /if \(!shouldWaitInline\(waitMs\)\)/);
  });
});
