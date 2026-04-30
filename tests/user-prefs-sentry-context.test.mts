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

  it('messageHead still in extra (non-indexed payload, not promoted)', () => {
    const err = new Error('quite a long error message that should land in extra');
    const ctx = buildSentryContext(err, err.message, baseOpts);
    assert.equal(typeof ctx.extra.messageHead, 'string');
    assert.match(ctx.extra.messageHead as string, /^quite a long/);
  });
});
