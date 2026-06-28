/**
 * Regression guard for the accessibility fixes in issue #4373:
 *   - aria-required-children: the "+" add button must NOT be a child of the
 *     role="tablist" element (PanelTabBar).
 *   - color-contrast: footer copyright, DEFCON badge, and live/webcam "active"
 *     pills must clear WCAG AA 4.5:1.
 *   - select-name: #regionSelect and .cascade-select must carry aria-labels.
 *   - bypass: a <main> landmark and a skip link must exist.
 *   - target-size: map time-range buttons and the layer-help "?" button must
 *     present a >=48x48 hit area.
 *
 * These are source-invariant assertions (the components render via
 * createElement / inline HTML strings with no DOM in the Node test runner,
 * the same shape as notifications-settings-ui-invariants.test.mjs) plus real
 * WCAG contrast math computed from the actual source values, so the contrast
 * guards fail if someone regresses a color rather than just a string.
 *
 * Run: node --test tests/a11y-issue-4373-invariants.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

const css = read('src', 'styles', 'main.css');
const tabBar = read('src', 'components', 'PanelTabBar.ts');
const pizzint = read('src', 'components', 'PizzIntIndicator.ts');
const panelLayout = read('src', 'app', 'panel-layout.ts');
const cascadePanel = read('src', 'components', 'CascadePanel.ts');
const deckglMap = read('src', 'components', 'DeckGLMap.ts');

// --- WCAG contrast helpers -------------------------------------------------

function hexToRgb(hex) {
  const m = hex.replace('#', '').trim();
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Extract a `--token: #value;` from the :root block of main.css.
function cssToken(name) {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(m, `--${name} token must be defined in main.css`);
  return m[1];
}

// Self-check the contrast math against the issue's reported figures.
describe('WCAG contrast helper sanity', () => {
  it('reproduces the issue figures (within rounding)', () => {
    assert.ok(Math.abs(contrastRatio('#5a5a5a', '#141414') - 2.67) < 0.1);
    assert.ok(Math.abs(contrastRatio('#ffffff', '#2d8a6e') - 4.22) < 0.1);
    assert.ok(Math.abs(contrastRatio('#ffffff', '#ff4444') - 3.41) < 0.1);
  });
});

// --- 1. tablist child role (aria-required-children) ------------------------

describe('PanelTabBar — add button is not a tablist child', () => {
  it('role="tablist" lives on the inner tablist element, not the bar', () => {
    assert.match(tabBar, /tablistEl\.setAttribute\('role',\s*'tablist'\)/);
    assert.doesNotMatch(
      tabBar,
      /this\.element\.setAttribute\('role',\s*'tablist'\)/,
      'the bar (this.element) must not be the tablist — the add button is its child',
    );
  });

  it('the add button is a sibling of the tablist in the bar', () => {
    // render() appends tabs to the tablist and re-parents [tablist, addBtn]
    // onto the bar, so the tablist owns only role="tab" children.
    assert.match(tabBar, /this\.tablistEl\.appendChild\(this\.renderTab\(/);
    assert.match(tabBar, /this\.element\.replaceChildren\(this\.tablistEl,\s*addBtn\)/);
  });
});

// --- 2. select-name --------------------------------------------------------

describe('select-name — #regionSelect is labelled', () => {
  it('regionSelect carries an aria-label', () => {
    const line = panelLayout
      .split('\n')
      .find((l) => l.includes('id="regionSelect"'));
    assert.ok(line, '#regionSelect must exist');
    assert.match(line, /aria-label=/, '#regionSelect must have an aria-label');
  });

  it('cascade-select carries an aria-label', () => {
    const line = cascadePanel
      .split('\n')
      .find((l) => l.includes('class="cascade-select"'));
    assert.ok(line, '.cascade-select must exist');
    assert.match(line, /aria-label=/, '.cascade-select must have an aria-label');
  });
});

// --- 3. bypass: <main> landmark + skip link --------------------------------

describe('bypass — landmark and skip link', () => {
  it('renders a <main id="main"> landmark wrapping the dashboard content', () => {
    assert.match(panelLayout, /<main id="main"[^>]*class="main-content/);
    assert.match(panelLayout, /<\/main>/);
  });

  it('renders a skip link targeting #main as the first focusable element', () => {
    assert.match(panelLayout, /<a href="#main" class="skip-link">/);
    const skipIdx = panelLayout.indexOf('class="skip-link"');
    const headerIdx = panelLayout.indexOf('class="header"');
    assert.ok(skipIdx > 0 && headerIdx > 0 && skipIdx < headerIdx,
      'skip link must appear before the header in source order');
  });

  it('defines visually-hidden-until-focus skip-link CSS', () => {
    assert.match(css, /\.skip-link\s*\{[^}]*position:\s*fixed/);
    assert.match(css, /\.skip-link:focus[^{]*\{[^}]*transform:\s*translateY\(0\)/);
  });

  it('wires a skip-link click handler that focuses <main> (native fragment focus is unreliable)', () => {
    const handlerIdx = panelLayout.indexOf("querySelector('.skip-link')?.addEventListener('click'");
    assert.ok(handlerIdx > 0, 'skip-link click handler must be wired in renderLayout');
    // The handler must move focus to #main.
    const after = panelLayout.slice(handlerIdx, handlerIdx + 320);
    assert.match(after, /getElementById\('main'\)/);
    assert.match(after, /\.focus\(\)/);
  });
});

// --- 4. footer copyright contrast ------------------------------------------

describe('color-contrast — footer copyright', () => {
  it('.site-footer-copy no longer fades --text-dim below AA', () => {
    const block = css.match(/\.site-footer-copy\s*\{([^}]*)\}/);
    assert.ok(block, '.site-footer-copy rule must exist');
    const body = block[1].replace(/\/\*[\s\S]*?\*\//g, ''); // drop comments
    assert.doesNotMatch(body, /opacity:/,
      'the opacity fade dropped contrast to 2.67:1 — it must be gone');
    const fg = cssToken('text-dim');
    const bg = cssToken('surface');
    assert.ok(contrastRatio(fg, bg) >= 4.5,
      `footer copy ${fg} on ${bg} must clear 4.5:1`);
  });

  it('.site-footer-copy also clears AA in light theme', () => {
    // cssToken() returns the first (dark/:root) value, so the light theme is
    // unguarded otherwise — and #6b6b6b on #fff is only ~4.84:1, close enough
    // that a token tweak could silently regress it.
    const lightBlock = [...css.matchAll(/\[data-theme="light"\][^{]*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .find((b) => /--text-dim:/.test(b) && /--surface:/.test(b));
    assert.ok(lightBlock, 'light theme token block must define --text-dim and --surface');
    const lightToken = (name) => {
      const m = lightBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
      assert.ok(m, `light theme --${name} must be a hex value`);
      return m[1];
    };
    const fg = lightToken('text-dim');
    const bg = lightToken('surface');
    assert.ok(contrastRatio(fg, bg) >= 4.5,
      `light-theme footer copy ${fg} on ${bg} must clear 4.5:1`);
  });
});

// --- 5. DEFCON badge contrast ----------------------------------------------

describe('color-contrast — DEFCON badge', () => {
  it('badge text is black, which clears AA on every DEFCON hue', () => {
    assert.match(pizzint, /defconEl\.style\.color\s*=\s*'#000'/);
    assert.doesNotMatch(pizzint, /defconEl\.style\.color\s*=\s*[^\n]*'#fff'/,
      'white text failed on DEFCON 4 (blue) and 5 (green)');
    const colors = pizzint.match(/DEFCON_COLORS[^}]*}/)[0];
    for (const hex of colors.match(/#[0-9a-fA-F]{6}/g)) {
      assert.ok(contrastRatio('#000000', hex) >= 4.5,
        `black on DEFCON color ${hex} must clear 4.5:1`);
    }
  });
});

// --- 6. live / webcam "active" pill contrast -------------------------------

describe('color-contrast — live/webcam active pills', () => {
  it('--red-strong clears AA with white text', () => {
    const red = cssToken('red-strong');
    assert.ok(contrastRatio('#ffffff', red) >= 4.5,
      `white on ${red} must clear 4.5:1`);
  });

  it('the known active/critical pills use --red-strong, not the failing --red', () => {
    for (const sel of [
      '.live-channel-btn.active',
      '.webcam-region-btn.active',
      '.webcam-view-btn.active',
      '.webcam-feed-btn.active',
      '.focal-point-urgency.critical',
      // hover state: the base rule sets white text, this swaps to a red bg
      '.webcam-preview-play:hover',
    ]) {
      const block = css.match(
        new RegExp(`${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`),
      );
      assert.ok(block, `${sel} rule must exist`);
      assert.match(block[1], /background:\s*var\(--red-strong\)/,
        `${sel} must use --red-strong`);
    }
  });

  it('NO rule pairs white text with the failing 3.4:1 var(--red) background', () => {
    // Comprehensive sweep: any rule whose own body sets both a white-ish
    // foreground and `background: var(--red)` is a 3.41:1 color-contrast fail.
    // Every such pill must move to --red-strong (≈5:1).
    const offenders = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2].replace(/\/\*[\s\S]*?\*\//g, '');
      const whiteText =
        /color:\s*(white|#fff(f{0,3})?)\b/i.test(body) ||
        /color:\s*rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)/i.test(body);
      const redBg = /background(-color)?:\s*var\(--red\)\s*;/.test(body);
      if (whiteText && redBg) offenders.push(m[1].trim().slice(0, 60));
    }
    assert.deepEqual(offenders, [],
      `white-on-var(--red) (3.41:1) rules must use --red-strong: ${offenders.join(' | ')}`);
  });
});

// --- 7. tap target sizes ----------------------------------------------------

describe('target-size — small map controls', () => {
  it('time-range buttons present a >=48px hit area', () => {
    const block = css.match(/\.deckgl-time-slider \.time-btn\s*\{([^}]*)\}/);
    assert.ok(block, '.deckgl-time-slider .time-btn rule must exist');
    assert.match(block[1], /min-height:\s*48px/);
    assert.match(block[1], /min-width:\s*48px/);
  });

  it('layer-help "?" button is 48x48', () => {
    const block = css.match(/\.layer-help-btn\s*\{([^}]*)\}/);
    assert.ok(block, '.layer-help-btn rule must exist');
    assert.match(block[1], /width:\s*48px/);
    assert.match(block[1], /height:\s*48px/);
    const line = deckglMap
      .split('\n')
      .find((l) => l.includes('class="layer-help-btn"'));
    assert.ok(line, 'DeckGL layer help button must exist');
    assert.ok(line.includes('aria-label='),
      'DeckGL layer help button must expose an accessible name');
  });
});
