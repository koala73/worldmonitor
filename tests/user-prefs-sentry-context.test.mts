import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSentryContext } from '../api/user-prefs.ts';

// ---------------------------------------------------------------------------
// buildSentryContext — Sentry tag/extra/fingerprint shape for /api/user-prefs
//
// Rationale: PR 1 promotes `userId` from `extra` to a Sentry tag (so we can
// group CONFLICT volume by user) and adds two new params:
//   - errorShapeOverride: lets the CONFLICT branch route through this same
//     builder while bypassing the message-pattern classification (which
//     would otherwise mis-classify the structured ConvexError as 'unknown').
//   - extraTags: surfaces e.g. actual_sync_version as a queryable tag.
// ---------------------------------------------------------------------------

const baseOpts = {
  method: 'POST' as const,
  convexFn: 'userPreferences:setPreferences',
  userId: 'user_2x8K3StringFormFromClerk',
  variant: 'full',
};

describe('buildSentryContext — userId promotion', () => {
  it('puts userId on tags as a non-empty string (not in extra)', () => {
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    // Clerk userIds are opaque strings (e.g. user_2x8K3...), not numbers.
    // Asserting "string and present" is the right shape; numeric assertion
    // would have been wrong (regression bait — earlier plan revision had it).
    assert.equal(typeof ctx.tags.user_id, 'string');
    assert.ok((ctx.tags.user_id as string).length > 0);
    assert.equal(ctx.tags.user_id, baseOpts.userId);
    // userId removed from extra — would otherwise duplicate signal across
    // tags+extra and confuse Sentry filters.
    assert.equal(ctx.extra.userId, undefined);
  });
});

describe('buildSentryContext — errorShapeOverride', () => {
  it('uses the override verbatim, bypassing message-pattern classification', () => {
    // Without override, this generic Server Error message would classify as
    // 'convex_server_error'. The CONFLICT branch needs its own bucket.
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, {
      ...baseOpts,
      errorShapeOverride: 'setPreferences_conflict',
    });
    assert.equal(ctx.tags.error_shape, 'setPreferences_conflict');
    // Fingerprint reflects the override too — otherwise issue grouping
    // would still bucket CONFLICTs with generic 5xx.
    assert.deepEqual(ctx.fingerprint, ['api/user-prefs', 'POST', 'setPreferences_conflict']);
  });

  it('falls back to message-pattern classification when override is omitted', () => {
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_server_error');
    assert.deepEqual(ctx.fingerprint, ['api/user-prefs', 'POST', 'convex_server_error']);
  });
});

describe('buildSentryContext — extraTags', () => {
  it('merges extraTags into the tags object alongside built-in tags', () => {
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, {
      ...baseOpts,
      errorShapeOverride: 'setPreferences_conflict',
      extraTags: { actual_sync_version: 72 },
    });
    assert.equal(ctx.tags.actual_sync_version, 72);
    // Built-in tags still present — extraTags merge, not override.
    assert.equal(ctx.tags.error_shape, 'setPreferences_conflict');
    assert.equal(ctx.tags.user_id, baseOpts.userId);
    assert.equal(ctx.tags.route, 'api/user-prefs');
  });

  it('omits extraTags when not provided (no undefined keys leak)', () => {
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal('actual_sync_version' in ctx.tags, false);
  });

  it('extraTags can supply numeric values (Sentry accepts string|number tags)', () => {
    const err = new Error('msg');
    const ctx = buildSentryContext(err, err.message, {
      ...baseOpts,
      extraTags: { actual_sync_version: 0 }, // zero is a valid version
    });
    assert.equal(ctx.tags.actual_sync_version, 0);
  });
});

describe('buildSentryContext — level downgrade for expected-but-trackable conditions', () => {
  it('omits level field by default (envelope falls back to error)', () => {
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal('level' in ctx, false);
  });

  it('passes through level: warning when caller specifies it', () => {
    // CONFLICT capture (handleConflictResponse) uses this so the high-volume
    // optimistic-concurrency events stay queryable without polluting error
    // totals or alerting (WORLDMONITOR-PX 2026-04-30: 316 events / 59 users).
    const err = new Error('[Request ID: abc] Server Error');
    const ctx = buildSentryContext(err, err.message, {
      ...baseOpts,
      errorShapeOverride: 'setPreferences_conflict',
      level: 'warning',
    });
    assert.equal(ctx.level, 'warning');
  });

  it('passes through level: info', () => {
    const err = new Error('msg');
    const ctx = buildSentryContext(err, err.message, { ...baseOpts, level: 'info' });
    assert.equal(ctx.level, 'info');
  });
});

describe('buildSentryContext — backwards-compat for non-CONFLICT callers', () => {
  it('UNAUTHENTICATED still classifies via message-pattern when override omitted', () => {
    const err = new Error('UNAUTHENTICATED auth drift');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_auth_drift');
  });

  it('SERVICE_UNAVAILABLE still classifies via message-pattern when override omitted', () => {
    const err = new Error('{"code":"ServiceUnavailable","message":"x"}');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_service_unavailable');
  });

  it('JSON-shape "code":"InternalServerError" classifies as convex_internal_error', () => {
    // WORLDMONITOR-PG/PH: Convex runtime 500 was previously bucketed as
    // 'unknown' in the dashboard, conflating a transient platform failure
    // with genuinely-novel error shapes. Its own bucket + the
    // SERVICE_UNAVAILABLE mapping in `_convex-error.js` mean on-call sees
    // these tagged distinctly without a 500 → 503 user-impact regression.
    const err = new Error('{"code":"InternalServerError","message":"Your request couldn\'t be completed. Try again later."}');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_internal_error');
  });

  it('JSON-shape "code":"WorkerOverloaded" classifies as convex_worker_overloaded', () => {
    // WORLDMONITOR-PG: Convex runtime worker saturation
    //   `{"code":"WorkerOverloaded","message":"There are no available workers
    //     to process the request"}`
    // was previously bucketed as 'unknown' at error level (11 events / 9 users),
    // conflating a transient platform-capacity event with genuinely-novel error
    // shapes. Its own bucket + the SERVICE_UNAVAILABLE mapping in
    // `_convex-error.js` mean on-call sees it tagged distinctly without a
    // 500 → 503 user-impact regression.
    const err = new Error('{"code":"WorkerOverloaded","message":"There are no available workers to process the request"}');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_worker_overloaded');
  });

  it('tolerates optional whitespace after the colon ("code": "WorkerOverloaded")', () => {
    // Mirrors `hasConvexCode` in _convex-error.js so the Sentry bucket and the
    // kind→503 mapping stay in lockstep: a with-whitespace body must classify
    // identically on both sides, never splitting into a 503-but-'unknown'-tag
    // state.
    const err = new Error('{"code": "WorkerOverloaded", "message": "There are no available workers to process the request"}');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_worker_overloaded');
  });

  it('JSON-shape "code":"Unauthenticated" classifies as convex_auth_drift (mixed-case OIDC failure)', () => {
    // WORLDMONITOR-PG: Convex platform-level 401 ships a JSON body
    //   `{"code":"Unauthenticated","message":"Could not verify OIDC token claim..."}`
    // The mixed-case `"Unauthenticated"` doesn't match the uppercase
    // `/UNAUTHENTICATED/` regex, so prior to the fix this fell through
    // to `error_shape: 'unknown'` and the response went 500 instead of
    // 401. Now both shapes route to the same auth-drift bucket.
    const err = new Error('{"code":"Unauthenticated","message":"Could not verify OIDC token claim. Check that the token signature is valid and the token hasn\'t expired."}');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'convex_auth_drift');
  });

  it('Cloudflare edge body "error code: 52x" classifies as transport_cloudflare', () => {
    // WORLDMONITOR-PG: a Cloudflare 520-527 fronting the Convex deployment
    // produced a body `error code: 520`. No classifier matched it, so it fell
    // to `error_shape: 'unknown'` at error level (10 events / 8 users). Now
    // _convex-error.js maps it to SERVICE_UNAVAILABLE (503 + Retry-After,
    // warning) and this bucket keeps it queryable apart from genuine Convex
    // platform 5xx.
    for (const code of [520, 522, 524, 527]) {
      const err = new Error(`error code: ${code}`);
      const ctx = buildSentryContext(err, err.message, baseOpts);
      assert.equal(ctx.tags.error_shape, 'transport_cloudflare', `code ${code}`);
    }
  });

  it('non-Cloudflare 5xx (error code: 500/503) does NOT classify as transport_cloudflare', () => {
    // Defensive: only the real Cloudflare 520-527 range is the CDN-transport
    // bucket. A bare "error code: 500" with no other signal stays 'unknown'.
    const err = new Error('error code: 500');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'unknown');
  });

  it('Cloudflare 524 wins transport_cloudflare even when body contains "A timeout occurred"', () => {
    // greptile review on #3854: Cloudflare 524's error page body is literally
    // "A timeout occurred". If the Convex client carries that body text in the
    // error message, the /timeout/ branch would fire first and mis-bucket the
    // 524 as transport_timeout. The `error code: 52x` branch is ordered BEFORE
    // /timeout/ specifically to prevent this.
    const err = new Error('<html><title>524: A timeout occurred</title><body>A timeout occurred. error code: 524</body></html>');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'transport_cloudflare');
  });

  it('a genuine client AbortSignal timeout (no CF code) still classifies as transport_timeout', () => {
    // Ordering guard the other way: moving error-code-52x above /timeout/ must
    // NOT steal real client-timeout events — they carry no `error code: 52x`.
    const err = new Error('The operation was aborted due to timeout');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(ctx.tags.error_shape, 'transport_timeout');
  });

  it('messageHead still in extra (non-indexed payload, not promoted)', () => {
    const err = new Error('quite a long error message that should land in extra');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(typeof ctx.extra.messageHead, 'string');
    assert.match(ctx.extra.messageHead as string, /^quite a long/);
  });
});
