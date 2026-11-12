/**
 * #10342: every desktop exit to /pro must name the account signed in to the
 * app, so /pro can stop a checkout on a different browser session. The
 * desktop opener stamps it, which covers CTAs that build bare /pro URLs
 * (locked panels, Settings, the follow cap) as well as plain links.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

const handoff = await import('../shared/desktop-checkout-handoff.ts');
const { withDesktopCheckoutHandoff } = await import('../src/services/desktop-checkout-handoff.ts');
const { __setClerkInstanceForTests } = await import('../src/services/clerk.ts');

const digestOf = (id: string) => createHash('sha256').update(`wm-desktop-checkout:${id}`).digest('hex').slice(0, 16);

afterEach(() => __setClerkInstanceForTests(null));

function signIn(id: string): void {
  __setClerkInstanceForTests({
    user: { id, fullName: 'A', primaryEmailAddress: { emailAddress: 'a@example.com' }, imageUrl: null, publicMetadata: {} },
  } as never);
}

describe('desktop checkout handoff contract', () => {
  it('names the account by a digest, never the raw Clerk id', async () => {
    const account = await handoff.desktopAccountDigest('user_a');
    assert.equal(account, digestOf('user_a'));
    assert.notEqual(account, await handoff.desktopAccountDigest('user_b'));
  });

  it('parses a valid digest, drops a malformed one, and ignores an account without the handoff', () => {
    const account = digestOf('user_a');
    assert.deepEqual(handoff.parseDesktopCheckoutHandoff(`?wm_checkout_handoff=desktop&wm_checkout_account=${account}`), { account });
    assert.deepEqual(handoff.parseDesktopCheckoutHandoff('?wm_checkout_handoff=desktop&wm_checkout_account=<x>'), {});
    assert.equal(handoff.parseDesktopCheckoutHandoff(`?wm_checkout_account=${account}`), null);
  });

  it('keeps an account the app could not read, so /pro asks instead of assuming', () => {
    assert.deepEqual(
      handoff.parseDesktopCheckoutHandoff('?wm_checkout_handoff=desktop&wm_checkout_account=unknown'),
      { account: handoff.UNKNOWN_DESKTOP_ACCOUNT },
    );
  });
});

describe('withDesktopCheckoutHandoff', () => {
  it('stamps a bare /pro URL with the signed-in desktop account', async () => {
    signIn('user_a');
    const url = new URL(await withDesktopCheckoutHandoff('https://worldmonitor.app/pro'));
    assert.equal(url.searchParams.get('wm_checkout_handoff'), 'desktop');
    assert.equal(url.searchParams.get('wm_checkout_account'), digestOf('user_a'));
    assert.doesNotMatch(url.href, /user_a/);
  });

  it('keeps the pricing anchor, query and www host', async () => {
    signIn('user_a');
    const url = new URL(await withDesktopCheckoutHandoff('https://www.worldmonitor.app/pro?wm_reactivate_plan=pro_annual#pricing'));
    assert.equal(url.hash, '#pricing');
    assert.equal(url.searchParams.get('wm_reactivate_plan'), 'pro_annual');
    assert.equal(url.searchParams.get('wm_checkout_account'), digestOf('user_a'));
  });

  it('marks a signed-out app as a handoff with no account', async () => {
    const url = new URL(await withDesktopCheckoutHandoff('https://worldmonitor.app/pro#pricing'));
    assert.equal(url.searchParams.get('wm_checkout_handoff'), 'desktop');
    assert.equal(url.searchParams.has('wm_checkout_account'), false);
  });

  it('leaves other pages, other hosts and an existing handoff alone', async () => {
    signIn('user_a');
    for (const raw of [
      'https://worldmonitor.app/dashboard',
      'https://worldmonitor.app/pro/terms',
      'https://example.com/pro',
      'https://worldmonitor.app/pro?wm_checkout_handoff=desktop',
    ]) {
      assert.equal(await withDesktopCheckoutHandoff(raw), raw);
    }
  });
});
