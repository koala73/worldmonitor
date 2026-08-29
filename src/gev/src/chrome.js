/**
 * God's Eye View chrome — the HUD markup that upstream keeps in index.html.
 *
 * Upstream is a standalone page: its <body> IS the app, and every module
 * reaches for elements with `document.getElementById(...)`. Embedded in World
 * Monitor that will not do — the dashboard owns <body>, and GEV's stylesheet
 * is namespaced under `.gev-root` (see scripts/vendor-gev-css.mjs), so the
 * markup has to live inside that container or none of its rules match.
 *
 * The markup itself stays in `chrome.html`, imported raw, rather than being
 * inlined here as a template literal. That is deliberate: it keeps the file
 * diffable against upstream's index.html, so re-vendoring a newer God's Eye
 * View stays a copy-and-re-extract rather than a manual merge of 880 lines.
 */

// The namespaced stylesheet, generated from ../style.css by
// scripts/vendor-gev-css.mjs. Imported here rather than by the caller so
// that mounting the chrome can never produce an unstyled GEV — this module
// owns "put GEV's DOM on the page", and its styles are part of that.
import '../../styles/gev.css';
// Loaded AFTER gev.css so its containment rules win on equal specificity.
// This is where the embedded-vs-standalone differences live; see the file
// header for why `contain: layout paint` is what stops upstream's 29
// `position: fixed` chrome elements escaping the map panel.
import '../../styles/gev-embed.css';
import chromeHtml from './chrome.html?raw';

/** Google Fonts upstream loads from its <head>. Injected once, process-wide. */
const FONT_HREFS = [
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0',
  'https://fonts.googleapis.com/icon?family=Material+Icons+Round',
];

let fontsInjected = false;

/**
 * Add the font <link>s to <head> if they are not already there.
 *
 * These have to be in the document head — a stylesheet link inside the body
 * works in practice but is not guaranteed, and GEV's whole visual identity
 * (JetBrains Mono readouts, Material Symbols glyph buttons) falls back to
 * system fonts without them. Idempotent, and safe to call on every mount.
 */
function ensureFonts() {
  if (fontsInjected) return;
  fontsInjected = true;

  for (const rel of ['preconnect']) {
    for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
      if (document.head.querySelector(`link[rel="${rel}"][href="${href}"]`)) continue;
      const link = document.createElement('link');
      link.rel = rel;
      link.href = href;
      if (href.includes('gstatic')) link.crossOrigin = '';
      document.head.appendChild(link);
    }
  }

  for (const href of FONT_HREFS) {
    if (document.head.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}

/**
 * Mount GEV's chrome into `container`.
 *
 * The container gets the `gev-root` class, which is what every rule in
 * src/styles/gev.css is scoped to — without it the markup renders unstyled.
 *
 * @param {HTMLElement} container
 * @returns {{ container: HTMLElement, destroy: () => void }}
 */
export function renderGevChrome(container) {
  if (!container) throw new Error('renderGevChrome: container is required');

  ensureFonts();
  container.classList.add('gev-root');
  container.innerHTML = chromeHtml;

  return {
    container,
    destroy() {
      container.innerHTML = '';
      container.classList.remove('gev-root');
    },
  };
}

/**
 * Look up one of GEV's chrome elements within a mounted container.
 *
 * Upstream calls `document.getElementById(id)` throughout. Embedded, that is
 * wrong in two ways: it escapes the container, and it breaks outright if the
 * dashboard ever mounts a second GEV instance. Modules that have a container
 * reference should prefer this.
 *
 * @param {HTMLElement} container
 * @param {string} id
 */
export function gevEl(container, id) {
  return container.querySelector(`#${CSS.escape(id)}`);
}
