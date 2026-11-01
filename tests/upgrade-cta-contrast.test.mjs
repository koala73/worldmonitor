/**
 * Buttons and chips must stay readable in both themes.
 *
 * The dark theme sets `--accent: #fff` and the light theme `--accent: #111111`,
 * so a rule that pairs an accent background with a fixed or theme-independent
 * text color reads in one theme and vanishes in the other. The route explorer's
 * "Upgrade to PRO" button shipped as a blank white button that way (#9949).
 *
 * This test resolves text and background against each theme's tokens in
 * src/styles/main.css and requires WCAG AA contrast (4.5:1) for:
 *   1. every upgrade CTA, listed by selector below, and
 *   2. every rule in src/styles/ whose background uses var(--accent…) or
 *      var(--green…) and that declares its own text color, and every :hover
 *      rule that changes only the text of such a rule.
 * Rules inside a container that pins its own tokens (the route explorer modal
 * is dark in both themes) resolve with those tokens. A gradient is checked at
 * every color stop. A token that is not defined and has no fallback fails,
 * because the browser then drops the declaration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const stylesDir = new URL('../src/styles/', import.meta.url);
const sheets = Object.fromEntries(
  readdirSync(stylesDir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(new URL(f, stylesDir), 'utf8')]),
);
const mainCss = sheets['main.css'];

/** Upgrade CTAs, with the text color they sit on when the rule inherits it. */
const UPGRADE_CTAS = [
  ['main.css', '.upgrade-pro-cta'],
  ['main.css', '.panel-locked-cta'],
  ['main.css', '.pro-banner-cta'],
  ['main.css', '.pro-banner-cta:hover', { color: '#0a0a0a' }],
  ['route-explorer.css', '.re-content__upgrade'],
];

/** Accent-background rules that inherit their text color, with the declaration they inherit. */
const INHERITED_TEXT = {
  '.re-picker__item--active': 'var(--text-primary, #c9d1d9)', // from .re-modal__surface
};

/** Sheets whose rules all render inside a container that pins theme tokens. */
const SCOPED_TOKENS = {
  'route-explorer.css': '.re-modal',
};

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const parsed = new Map();

/** Every innermost `selector { body }` rule, with its line number. */
function rules(css) {
  if (parsed.has(css)) return parsed.get(css);
  const clean = stripComments(css);
  const list = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].split(';').pop().trim().replace(/\s+/g, ' '),
    body: m[2],
    line: clean.slice(0, m.index + m[1].length).split('\n').length,
  }));
  parsed.set(css, list);
  return list;
}

function rule(file, selector) {
  const found = rules(sheets[file]).find((r) => r.selector === selector);
  assert.ok(found, `${selector} not found in ${file}`);
  return found;
}

function tokens(body) {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function declaration(body, property) {
  const all = [...body.matchAll(new RegExp(`(?:^|[;\\s{])${property}\\s*:\\s*([^;]+);`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : null;
}

/** Expand var(--x, fallback) recursively; an undefined token without fallback throws. */
function expand(value, theme, depth = 0) {
  assert.ok(depth < 8, `token cycle in ${value}`);
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start < 0) { out += value.slice(i); break; }
    out += value.slice(i, start);
    let depthParen = 0;
    let end = start + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depthParen += 1;
      else if (value[end] === ')' && --depthParen === 0) break;
    }
    const inner = value.slice(start + 4, end);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
    const resolved = theme[name] ?? fallback;
    assert.ok(resolved !== undefined, `${name} is not defined and has no fallback`);
    out += expand(resolved, theme, depth + 1);
    i = end + 1;
  }
  return out;
}

function hex6(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  return h.slice(0, 6).toLowerCase();
}

const rgbOf = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex6(hex).slice(i, i + 2), 16));
const hexOf = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Replace `color-mix(in srgb, #a p%, #b)` with the mixed hex. */
function mix(value) {
  return value.replace(
    /color-mix\(\s*in srgb\s*,\s*(#[0-9a-fA-F]{3,8})\s*(\d+(?:\.\d+)?)?%?\s*,\s*(#[0-9a-fA-F]{3,8})\s*(\d+(?:\.\d+)?)?%?\s*\)/g,
    (_, a, pa, b, pb) => {
      const p = pa !== undefined ? Number(pa) / 100 : pb !== undefined ? 1 - Number(pb) / 100 : 0.5;
      const [ra, rb] = [rgbOf(a), rgbOf(b)];
      return hexOf(ra.map((v, k) => v * p + rb[k] * (1 - p)));
    },
  );
}

const NAMED = { white: '#ffffff', black: '#000000' };

const TRANSLUCENT = /color-mix|transparent|rgba?\(/;

/** Every solid color in a resolved value, as hex. */
function colors(value, theme) {
  const resolved = mix(expand(value, theme).replace(/\b(white|black)\b/g, (n) => NAMED[n]));
  assert.doesNotMatch(resolved, TRANSLUCENT, `cannot resolve ${value} -> ${resolved}`);
  const hexes = resolved.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.ok(hexes.length > 0, `no color in ${value} -> ${resolved}`);
  return hexes;
}

function luminance(hex) {
  const channel = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Tokens from every top-level rule with exactly this selector, in source order. */
function themeBlock(selector) {
  const found = rules(mainCss).filter((r) => r.selector === selector);
  assert.ok(found.length > 0, `${selector} not found in main.css`);
  return Object.assign({}, ...found.map((r) => tokens(r.body)));
}

const dark = themeBlock(':root');
const light = { ...dark, ...themeBlock('[data-theme="light"]') };

function themesFor(file) {
  const scope = SCOPED_TOKENS[file];
  const pinned = scope ? tokens(rule(file, scope).body) : {};
  return [['dark', { ...dark, ...pinned }], ['light', { ...light, ...pinned }]];
}

function assertReadable(file, label, background, text) {
  for (const [name, theme] of themesFor(file)) {
    const [fg] = colors(text, theme);
    for (const bg of colors(background, theme)) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${label} (${name}): text ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
}

describe('dark-only containers pin the dark theme values', () => {
  for (const [file, scope] of Object.entries(SCOPED_TOKENS)) {
    it(`${scope} pins every theme-dependent token ${file} reads, at its :root value`, () => {
      const pinned = tokens(rule(file, scope).body);
      const read = new Set([...stripComments(sheets[file]).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
      const flipping = [...read].filter((name) => name in dark && dark[name] !== light[name]);
      assert.ok(flipping.length > 0, `${file} reads no theme-dependent token; the scan is broken`);
      for (const name of flipping) assert.ok(name in pinned, `${scope} does not pin ${name}`);
      for (const [name, value] of Object.entries(pinned)) {
        assert.equal(value, dark[name], `${scope} ${name} drifted from the dark theme`);
      }
    });
  }
});

describe('upgrade CTAs are readable in both themes', () => {
  for (const [file, selector, inherited] of UPGRADE_CTAS) {
    it(selector, () => {
      const { body } = rule(file, selector);
      const background = declaration(body, 'background') ?? declaration(body, 'background-color');
      const text = declaration(body, 'color') ?? inherited?.color;
      assert.ok(background, `${selector} declares no background`);
      assert.ok(text, `${selector} declares no text color`);
      assertReadable(file, selector, background, text);
    });
  }
});

/**
 * Status text drawn in a semantic color (error red, positive green, elevated
 * orange/amber). The light palette's raw values sit at 3.2-3.6:1 on white, so
 * the light theme darkens them in one `[data-theme="light"] :is(...)` rule.
 */
const STATUS_TEXT = [
  ['main.css', '.panel-summary-error'],
  ['main.css', '.gdelt-trend-value.negative'],
  ['main.css', '.gdelt-trend-value.positive'],
  ['main.css', '.telegram-intel-preview-card.is-error'],
  ['main.css', '.insights-convergence .insights-section-title'],
  ['main.css', '.insight-badge.velocity.elevated'],
  ['main.css', '.history-event.cyclical'],
  ['country-deep-dive.css', '.cdp-maritime-anomaly'],
];

/** The light-theme rule that overrides a selector's text color, if any. */
function lightOverride(selector) {
  return rules(mainCss).find((r) => r.selector.startsWith('[data-theme="light"] :is(')
    && r.selector.slice(r.selector.indexOf('(') + 1, -1).split(',').map((s) => s.trim()).includes(selector));
}

describe('semantic status text is readable in both themes', () => {
  for (const [file, selector] of STATUS_TEXT) {
    it(selector, () => {
      const base = rules(sheets[file]).filter((r) => r.selector === selector && declaration(r.body, 'color')).pop();
      assert.ok(base, `${selector} declares no text color in ${file}`);
      const ownBackground = declaration(base.body, 'background');
      // Translucent tints sit on the panel surface; judge them against it.
      const background = ownBackground && !/transparent|rgba\(|hsla\(/.test(ownBackground) ? ownBackground : 'var(--surface)';
      const override = lightOverride(selector);
      for (const [name, theme] of themesFor(file)) {
        const text = name === 'light' && override ? declaration(override.body, 'color') : declaration(base.body, 'color');
        const [fg] = colors(text, theme);
        for (const bg of colors(background, theme)) {
          const ratio = contrast(fg, bg);
          assert.ok(ratio >= 4.5, `${selector} (${name}): text ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
        }
      }
    });
  }
});

describe('accent and green backgrounds keep readable text in both themes', () => {
  const failures = [];
  const judged = [];
  let checked = 0;
  for (const [file, css] of Object.entries(sheets)) {
    // The happy variant defines its own palette; these tokens do not apply.
    if (file === 'happy-theme.css') continue;
    const list = rules(css);
    for (const { selector, body, line } of list) {
      let background = declaration(body, 'background') ?? declaration(body, 'background-color');
      // A :hover rule that only recolors text sits on its base rule's background.
      if (!background && selector.endsWith(':hover') && declaration(body, 'color')) {
        const base = list.find((r) => r.selector === selector.slice(0, -':hover'.length));
        background = base && (declaration(base.body, 'background') ?? declaration(base.body, 'background-color'));
      }
      if (!background || !/var\(\s*--(accent|green)\b/.test(background)) continue;
      // A translucent tint depends on what sits under it; only solid fills are judged.
      if (/transparent|rgba\(|hsla\(/.test(background)) continue;
      const text = declaration(body, 'color') ?? INHERITED_TEXT[selector];
      if (!text) continue;
      checked += 1;
      judged.push(selector);
      try {
        assertReadable(file, selector, background, text);
      } catch (err) {
        failures.push(`${file}:${line} ${err.message}`);
      }
    }
  }

  it('finds the rules it is meant to guard', () => {
    assert.ok(checked >= 20, `only ${checked} rules matched; the scan is broken`);
    for (const selector of ['.wl-pill.active', '.telegram-follow-btn:hover', '.re-route-card__rank', '.re-picker__item--active', '.widget-chat-msg.user']) {
      assert.ok(judged.includes(selector), `${selector} is no longer judged`);
    }
  });

  it('has no unreadable rule', () => {
    assert.deepEqual(failures, []);
  });
});
