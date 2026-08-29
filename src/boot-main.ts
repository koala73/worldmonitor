/**
 * OpenEye's front door.
 *
 * This is the module `index.html` loads, and it is deliberately tiny: the CRT
 * ceremony, two stylesheets and two fonts. The dashboard — App, 260 panels,
 * deck.gl, maplibre, and eventually Cesium — is behind a dynamic import that
 * starts on the same tick but does not block the first frame of the intro.
 *
 * ## Why the dashboard is imported immediately rather than at the reveal
 *
 * The plan called for holding the dashboard chunk back until the ceremony's
 * reveal beat. That is the wrong way round. The ceremony's whole value is
 * that it covers a load the user would otherwise sit through staring at a
 * skeleton — starting the download at the reveal means the intro plays over
 * an idle network and THEN the user waits. Kicking it off here spends the
 * ceremony's ~12 seconds (full) or ~1.2 (short) on work that has to happen
 * anyway.
 *
 * Cesium is a separate matter and stays deferred: `CesiumGlobeMap` imports it
 * dynamically, and only when the globe is actually the chosen renderer.
 *
 * ## Why #app is hidden by the document rather than by this module
 *
 * `html.openeye-booting #app { opacity: 0 }` is declared in index.html's head
 * <style>, and the class is added by the inline script there. Both happen
 * before first paint, so the pre-render skeleton never flashes behind the
 * terminal. That inline script also arms a failsafe timer that removes the
 * class — if this module fails to load at all, the dashboard still appears.
 *
 * `opacity`, not `display: none`: the dashboard has to lay out at its real
 * size while it is hidden, or every panel that measures itself on mount
 * comes back at zero width when the veil lifts.
 */

import './boot/crt.css';
import './boot/title.css';
import { runBoot } from './boot/director';
import { chooseBootMode, markBootSeen } from './boot/boot-mode';
import { MOTION } from './boot/theme';

const root = document.documentElement;

// Tell index.html's failsafe that the ceremony is in hand. It removes the
// `openeye-booting` class unconditionally if this marker has not appeared
// within 8s, which is how a boot module that fails to load is prevented from
// stranding the dashboard behind an invisible veil. Set FIRST, before any
// work that could throw.
root.classList.add('openeye-boot-armed');

/** Hand the screen to the dashboard. Idempotent; safe to call twice. */
function reveal(): void {
  root.classList.add('openeye-revealed');
}

/**
 * Take the boot layer out of the document.
 *
 * `openeye-booted` is the completion signal — the ceremony has played all
 * the way through its handoff beats, not merely reached the reveal. Tests
 * and anything else waiting on the front door should wait for this rather
 * than for the absence of `openeye-booting`.
 */
function finish(): void {
  reveal();
  root.classList.remove('openeye-booting');
  root.classList.add('openeye-booted');
}

// Start the dashboard now — see the note above. Its failure has to surface
// even if the ceremony is still playing, otherwise a broken build looks like
// a hung intro.
const dashboard = import('./main').catch((err) => {
  console.error('[OpenEye] dashboard failed to load:', err);
  finish();
});

const bootHost = document.getElementById('boot');
const titleHost = document.getElementById('title');
const overlay = document.querySelector<HTMLElement>('.crt-overlay');

if (!bootHost || !titleHost) {
  // No ceremony hosts (a stripped index.html, an embed) — the dashboard is
  // the whole product.
  finish();
} else {
  const mode = chooseBootMode({
    storage: globalThis.localStorage,
    search: location.search,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });

  void runBoot(bootHost, titleHost, reveal, { mode, overlay })
    .catch((err) => { console.error('[OpenEye] boot ceremony failed:', err); })
    .finally(() => {
      markBootSeen(globalThis.localStorage);
      finish();
      // The wordmark has just begun compressing into the top-left corner —
      // which is where World Monitor's header already carries the same name.
      // Let the dock land, then cross-fade the ceremony's copy out so the
      // app's own chrome owns the corner. See #title.handed-over.
      window.setTimeout(
        () => titleHost.classList.add('handed-over'),
        MOTION.titleDockMs + 250,
      );
      void dashboard;
    });
}
