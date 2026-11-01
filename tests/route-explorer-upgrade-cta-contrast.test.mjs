/**
 * The route explorer's "Upgrade to PRO" button must be readable in both
 * themes. It used `background: var(--accent)` with `color: #fff`, and the dark
 * theme sets `--accent: #fff`, so signed-out visitors saw a blank white button.
 *
 * Resolves the button's text and background against each theme's tokens in
 * src/styles/main.css and requires WCAG AA contrast (4.5:1). A gradient
 * background is checked at every color stop.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainCss = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const explorerCss = readFileSync(new URL('../src/styles/route-explorer.css', import.meta.url), 'utf8');

function block(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} not found`);
  return match[1];
}

function tokens(body) {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`));
  assert.ok(match, `${property} not declared`);
  return match[1].trim();
}

/** Expand var(--x, fallback) against a token map, then list every hex color. */
function colors(value, theme) {
  const resolved = value.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (_, name, fallback) => theme[name] ?? fallback ?? '');
  const hexes = resolved.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.ok(hexes.length > 0, `no color in ${value} -> ${resolved}`);
  return hexes;
}

function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const channel = (i) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('route explorer upgrade CTA contrast', () => {
  const dark = tokens(block(mainCss, ':root'));
  const light = { ...dark, ...tokens(block(mainCss, '[data-theme="light"]')) };
  const button = block(explorerCss, '.re-content__upgrade');
  const background = declaration(button, 'background');
  const text = declaration(button, 'color');

  for (const [name, theme] of [['dark', dark], ['light', light]]) {
    it(`is readable in the ${name} theme`, () => {
      const [fg] = colors(text, theme);
      for (const bg of colors(background, theme)) {
        const ratio = contrast(fg, bg);
        assert.ok(ratio >= 4.5, `${name}: text ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    });
  }
});
