/**
 * Wiring lock for the Business Pro seat-invite accept flow (#4634/#4635) in
 * src/App.ts. App.ts is a DOM/bootstrap module that can't be imported under
 * `tsx --test` (no jsdom, real Convex client/auth side effects), so — per the
 * repo's established pattern (see tests/billing-state-wiring.test.mts) — this
 * locks the integration with source-text assertions instead of executing it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('App.ts accept-business-invite URL flow wiring', () => {
  it('captures the invite at the start of init(), before the auth subscription and the map URL sync', async () => {
    // The map URL sync rewrites the query string from map state shortly after
    // boot. Reading the params at sign-in time lost every invite whose
    // recipient signed up after landing (no new account had ever accepted one).
    const src = await read('src/App.ts');
    const initAt = src.indexOf('public async init(');
    const captureAt = src.indexOf('captureBusinessInviteFromUrl();', initAt);
    const subscribeAt = src.indexOf('this.unsubFreeTier = subscribeAuthState(', initAt);
    const urlSyncAt = src.indexOf('this.eventHandlers.setupUrlStateSync();', initAt);
    assert.ok(initAt >= 0 && captureAt > initAt, 'init() must capture the invite');
    assert.ok(subscribeAt > captureAt, 'capture must run before the auth subscription can fire');
    assert.ok(urlSyncAt > captureAt, 'capture must run before the map URL sync rewrites the query string');
    const beforeCapture = src.slice(initAt, captureAt).replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(beforeCapture, /\bawait\b/, 'no await may run between init() start and the capture');
  });

  it('accepts the captured invite rather than re-reading the URL at sign-in', async () => {
    const src = await read('src/App.ts');
    assert.doesNotMatch(src, /\.get\('accept-business-invite'\)/, 'App.ts must not read the invite params from the live URL');
    assert.match(src, /const pendingBusinessInvite = loadPendingBusinessInvite\(\);\s*\n\s*if \(pendingBusinessInvite\) \{/);
  });

  it('waits for Convex auth before calling acceptBusinessInvite, and bails without side effects if it times out', async () => {
    const src = await read('src/App.ts');
    assert.match(src, /const ready = await waitForConvexAuthForUser\(userId, 10_000\);/);
    assert.match(
      src,
      /if \(!ready\) \{\s*\n\s*console\.warn\('\[business-seats\] acceptBusinessInvite skipped — Convex auth not ready'\);\s*\n\s*return;\s*\n\s*\}/,
      'a timed-out auth wait must return before calling the mutation, not attempt it anonymously',
    );
  });

  it('binds the mutation settlement and success toast to the initiating account', async () => {
    const src = await read('src/App.ts');
    assert.match(
      src,
      /await settleAccountOperation\(\s*userId,\s*operation,\s*\(\) => \(isEnterpriseInvite\s*\?\s*client\.mutation\(api\.enterpriseSeats\.acceptInvite,[\s\S]{0,300}?: client\.mutation\(api\.payments\.businessSeats\.acceptBusinessInvite,/,
    );
    assert.match(
      src,
      /assertAccountStillCurrent\(userId, operation\);\s*\n\s*showToast\(isEnterpriseInvite \? 'You have joined the Enterprise account' : 'Pro seat activated'\)/,
      'a late A mutation must not show its success toast after Clerk selects B',
    );
    assert.match(
      src,
      /\} catch \(err\) \{\s*\n\s*const kind = businessInviteErrorKind\(err\);\s*\n\s*failureKind = kind;\s*\n\s*if \(!isAccountStillCurrent\(userId\)\) return;/,
      'errors from a departed account must stay silent in the new account UI',
    );
  });

  it('bails silently when the Convex client/api failed to load', async () => {
    const src = await read('src/App.ts');
    assert.match(src, /const \[client, api\] = await Promise\.all\(\[getConvexClient\(\), getConvexApi\(\)\]\);/);
    assert.match(src, /if \(!client \|\| !api\) return;/);
  });

  it('maps every known acceptBusinessInvite rejection kind to a distinct user-facing toast', async () => {
    const src = await read('src/App.ts');
    // One assertion per ConvexError kind the backend mutation can throw
    // (convex/payments/businessSeats.ts:acceptBusinessInvite) — a missing
    // branch here means that failure mode surfaces as the generic fallback
    // toast, silently losing the specific reason the user could act on.
    const expectedBranches: Array<[string, string]> = [
      ['INVITE_EMAIL_MISMATCH', 'This invite is for a different email address'],
      ['INVITE_EXPIRED', 'This invite has expired'],
      ['BUSINESS_NOT_ACTIVE', 'The Business plan that sent this invite is no longer active'],
      ['INVITE_ALREADY_USED', 'This invite has already been used'],
      // convex/enterpriseSeats.ts:acceptInvite
      ['CONTRACT_ENDED', 'The Enterprise contract that sent this invite has ended'],
      ['ALREADY_MEMBER_OF_ANOTHER_ACCOUNT', 'This account already belongs to another Enterprise account'],
    ];
    for (const [kind, toastMessage] of expectedBranches) {
      assert.match(
        src,
        new RegExp(`kind === '${kind}'`),
        `missing error-kind branch for ${kind}`,
      );
      assert.match(
        src,
        new RegExp(`showToast\\('${toastMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`),
        `missing toast copy for ${kind}`,
      );
    }
    // Generic fallback for any unrecognized error kind.
    assert.match(src, /showToast\('Could not accept invite'\)/);
    // Success toast on the happy path, per invite kind.
    assert.match(src, /'You have joined the Enterprise account' : 'Pro seat activated'/);
  });

  it('settles the invite in a finally block through keepInviteAfterAttempt', async () => {
    const src = await read('src/App.ts');
    assert.match(
      src,
      /\} finally \{[\s\S]{0,400}?const keep = keepInviteAfterAttempt\(\{\s*\n\s*accepted: acceptedByServer,\s*\n\s*accountChanged: !isAccountStillCurrent\(userId\),\s*\n\s*errorKind: failureKind,\s*\n\s*\}\);\s*\n\s*if \(!keep\) clearPendingBusinessInvite\(pendingBusinessInvite\);/,
      'cleanup must run in a finally block and defer the keep/clear decision to keepInviteAfterAttempt',
    );
    assert.match(
      src,
      /\.then\(\(result\) => \{\s*\n\s*acceptedByServer = true;/,
      'acceptance must be recorded inside the operation, before settleAccountOperation can throw on an account switch',
    );
    assert.match(
      src,
      /failureKind = kind;\s*\n\s*if \(!isAccountStillCurrent\(userId\)\) return;/,
      'the failure must be recorded before the departed-account early return',
    );
  });

  it('grantId is typed at the Convex-client boundary rather than cast through `api as any`', async () => {
    const src = await read('src/App.ts');
    assert.match(src, /grantId: pendingBusinessInvite\.grantId as Id<'businessProGrants'>/);
    assert.doesNotMatch(
      src,
      /\(api as any\)\.payments\.businessSeats/,
      'businessSeats calls must use the typed api object, not an any-cast escape hatch',
    );
  });
});

describe('Business seats surface defers to the server verdict', () => {
  // The server scans EVERY subscription row for a covering api_business one
  // (getCoveringBusinessSubscription, convex/payments/businessSeats.ts) and
  // reports the outcome as listSeats' `businessSubscriptionId`. The client
  // cannot reproduce that from getSubscription(), which exposes a single
  // display row chosen by a sort ranking active < on_hold < ended — so an
  // owner whose Business row is outranked by another subscription would be
  // told they own no seats while the server still authorizes them.
  //
  // Source-text locks because both files are DOM modules that cannot be
  // imported under `tsx --test`; the rendered behaviour is covered by
  // tests/dom/business-seats-coverage-gate.test.mts.
  const SEAT_GATE_FILES = [
    'src/components/UnifiedSettings.ts',
    'src/components/BusinessSeatsSection.ts',
  ];

  for (const file of SEAT_GATE_FILES) {
    it(`${file} never re-derives seat ownership from the display row`, async () => {
      const src = await read(file);
      assert.doesNotMatch(
        src,
        /planKey === 'api_business'/,
        `${file} must not decide seat ownership from the display subscription's plan; `
          + 'the server reports it via listSeats.businessSubscriptionId',
      );
    });
  }

  it('BusinessSeatsSection renders only on the server-reported subscription id', async () => {
    const src = await read('src/components/BusinessSeatsSection.ts');
    assert.match(
      src,
      /this\.businessSubscriptionId = result\.businessSubscriptionId;/,
      'the server verdict must be captured from the listSeats result',
    );
    assert.match(
      src,
      /if \(typeof this\.businessSubscriptionId !== 'string'\) return '';/,
      'rendering must gate on the captured server verdict',
    );
  });

  it('BusinessSeatsSection keeps a confirmed owner visible across a failed refresh', async () => {
    const src = await read('src/components/BusinessSeatsSection.ts');
    const loadBody = src.slice(src.indexOf('async load('), src.indexOf('renderInPlace()'));
    assert.doesNotMatch(
      loadBody,
      /catch[\s\S]*this\.businessSubscriptionId = (undefined|null)/,
      'a transient listSeats failure must not clear a previously confirmed owner verdict',
    );
  });

  it('UnifiedSettings asks for seats whenever the account has any subscription', async () => {
    const src = await read('src/components/UnifiedSettings.ts');
    assert.match(
      src,
      /if \(getSubscription\(\) !== null\) \{\s*\n\s*void this\.businessSeatsSection\.load\(\);/,
      'the load pre-filter must be subscription presence, not the display row plan/status',
    );
  });
});
