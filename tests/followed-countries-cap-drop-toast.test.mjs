import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const appSrc = readFileSync(resolve(ROOT, 'src/App.ts'), 'utf8');

describe('followed countries cap-drop toast wiring', () => {
  it('App listens for the cap-drop event exactly once at the app level', () => {
    assert.match(
      appSrc,
      /WM_FOLLOWED_COUNTRIES_CAP_DROP/,
      'App must import/listen for the cap-drop event emitted by followed-countries handoff',
    );
    assert.match(
      appSrc,
      /window\.addEventListener\(WM_FOLLOWED_COUNTRIES_CAP_DROP, this\.handleFollowedCountriesCapDrop\)/,
      'App init must install one cap-drop listener',
    );
    assert.match(
      appSrc,
      /window\.removeEventListener\(WM_FOLLOWED_COUNTRIES_CAP_DROP, this\.handleFollowedCountriesCapDrop\)/,
      'App destroy must remove the cap-drop listener',
    );
  });

  it('cap-drop listener renders an actionable upgrade toast', () => {
    assert.match(
      appSrc,
      /private showFollowedCountriesCapDropToast\(kept: number, dropped: number\): void/,
      'App must have a dedicated cap-drop toast renderer',
    );
    assert.match(
      appSrc,
      /wm-followed-cap-drop-toast update-toast/,
      'cap-drop toast should use the existing update-toast surface',
    );
    assert.match(
      appSrc,
      /Follow limit reached/,
      'toast title must explain why follows were dropped',
    );
    assert.match(
      appSrc,
      /free plan supports \$\{FREE_TIER_FOLLOW_LIMIT\} followed countries/,
      'toast detail must explain the free-tier cap',
    );
    // #5911 moved this from a bare `window.open('/pro#pricing', '_blank',
    // 'noopener,noreferrer')` to the shared router. The invariant is
    // unchanged and still enforced, just one level down: openExternalUrl's
    // web branch passes 'noopener,noreferrer' (asserted behaviourally in
    // tests/desktop-external-handoff.test.mts), and its desktop branch hands
    // the URL to the OS browser, which has no opener to expose at all. The
    // URL must be ABSOLUTE — the relative form resolved against
    // tauri://localhost in the desktop WebView, where no such route exists.
    assert.match(
      appSrc,
      /openExternalUrl\(`\$\{WEB_APP_ORIGIN\}\/pro#pricing`\)/,
      'toast upgrade action must route through openExternalUrl on an absolute origin',
    );
    // Quote-agnostic, and covers any relative form: the single-quote-only
    // version stayed green when the exact regression was restored with double
    // quotes (proven by mutation).
    assert.doesNotMatch(
      appSrc,
      /window\.open\(\s*['"`]\.?\/(?:pro|dashboard)/,
      'no relative window.open may come back — it dead-ends in the desktop WebView',
    );
    assert.match(
      appSrc,
      /toast\.setAttribute\('role', 'status'\)/,
      'toast must announce the cap drop to assistive technology',
    );
    assert.match(
      appSrc,
      /toast\.setAttribute\('aria-live', 'polite'\)/,
      'toast announcement should be polite, not interruptive',
    );
    assert.match(
      appSrc,
      /followedCountriesCapDropToastTimer/,
      'App must track the toast auto-dismiss timer for destroy-time cleanup',
    );
    assert.match(
      appSrc,
      /window\.clearTimeout\(this\.followedCountriesCapDropToastTimer\)/,
      'App destroy and manual dismiss must clear the toast auto-dismiss timer',
    );
  });
});
