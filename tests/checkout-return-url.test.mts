import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDashboardCheckoutReturnUrl,
  DESKTOP_CHECKOUT_SOURCE,
  resolveCheckoutReturnOrigin,
} from '../src/services/checkout-return-url.ts';

describe('buildDashboardCheckoutReturnUrl', () => {
  it('routes Dodo full-page returns to the dashboard instead of the root welcome page', () => {
    assert.equal(
      buildDashboardCheckoutReturnUrl('https://worldmonitor.app'),
      'https://worldmonitor.app/dashboard?wm_checkout=return',
    );
  });

  it('preserves the active origin so preview and variant hosts return to their own dashboard', () => {
    assert.equal(
      buildDashboardCheckoutReturnUrl('https://tech.worldmonitor.app'),
      'https://tech.worldmonitor.app/dashboard?wm_checkout=return',
    );
  });
});

describe('resolveCheckoutReturnOrigin (#5911)', () => {
  it('keeps the active origin on web, so variant and preview hosts still self-return', () => {
    assert.equal(
      resolveCheckoutReturnOrigin('https://tech.worldmonitor.app', false),
      'https://tech.worldmonitor.app',
    );
    assert.equal(
      resolveCheckoutReturnOrigin('https://worldmonitor-git-x.vercel.app', false),
      'https://worldmonitor-git-x.vercel.app',
    );
  });

  for (const webviewOrigin of [
    'tauri://localhost',
    'https://tauri.localhost',
    'https://localhost:1420',
  ]) {
    it(`replaces the desktop WebView origin ${webviewOrigin}, which serves no dashboard`, () => {
      assert.equal(
        resolveCheckoutReturnOrigin(webviewOrigin, true),
        'https://worldmonitor.app',
      );
    });
  }

  it('produces a return URL the OS browser can actually land on', () => {
    // The composed value is what ships in the create-checkout payload. A
    // desktop origin here means the buyer pays and then dead-ends on a page
    // no browser can open.
    assert.equal(
      buildDashboardCheckoutReturnUrl(
        resolveCheckoutReturnOrigin('tauri://localhost', true),
        DESKTOP_CHECKOUT_SOURCE,
      ),
      'https://worldmonitor.app/dashboard?wm_checkout=return&wm_src=desktop',
    );
  });

  it('does not add the desktop source marker to ordinary web returns', () => {
    assert.equal(
      buildDashboardCheckoutReturnUrl('https://worldmonitor.app'),
      'https://worldmonitor.app/dashboard?wm_checkout=return',
    );
  });
});
