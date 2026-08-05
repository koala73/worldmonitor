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
  it('reads both URL params and only proceeds when both are present', async () => {
    const src = await read('src/App.ts');
    assert.match(src, /new URLSearchParams\(window\.location\.search\)\.get\('accept-business-invite'\)/);
    assert.match(src, /new URLSearchParams\(window\.location\.search\)\.get\('token'\)/);
    assert.match(src, /if \(businessInviteGrantId && businessInviteToken\) \{/);
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
      /await settleAccountOperation\(\s*userId,\s*'accepting the Business Pro seat invite',\s*\(\) => client\.mutation\(/,
    );
    assert.match(
      src,
      /assertAccountStillCurrent\(userId, 'accepting the Business Pro seat invite'\);\s*\n\s*showToast\('Pro seat activated'\)/,
      'a late A mutation must not show its success toast after Clerk selects B',
    );
    assert.match(
      src,
      /\} catch \(err\) \{\s*\n\s*if \(!isAccountStillCurrent\(userId\)\) return;/,
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
    ];
    for (const [kind, toastMessage] of expectedBranches) {
      assert.match(
        src,
        new RegExp(`msg\\.includes\\('${kind}'\\)`),
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
    // Success toast on the happy path.
    assert.match(src, /showToast\('Pro seat activated'\)/);
  });

  it('always clears the invite URL params in a finally block once the try/catch runs, so a page refresh does not retry', async () => {
    const src = await read('src/App.ts');
    assert.match(
      src,
      /\} finally \{\s*\n\s*\/\/ Clear the invite params from the URL so a refresh does not retry\.\s*\n\s*const url = new URL\(window\.location\.href\);\s*\n\s*url\.searchParams\.delete\('accept-business-invite'\);\s*\n\s*url\.searchParams\.delete\('token'\);\s*\n\s*window\.history\.replaceState\(\{\}, '', url\.toString\(\)\);\s*\n\s*\}/,
      'URL param cleanup must run in a finally block around the accept mutation, covering both success and failure',
    );
  });

  it('grantId is typed at the Convex-client boundary rather than cast through `api as any`', async () => {
    const src = await read('src/App.ts');
    assert.match(src, /grantId: businessInviteGrantId as Id<'businessProGrants'>/);
    assert.doesNotMatch(
      src,
      /\(api as any\)\.payments\.businessSeats/,
      'businessSeats calls must use the typed api object, not an any-cast escape hatch',
    );
  });
});
