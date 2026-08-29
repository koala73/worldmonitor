import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readableTextColor, contrastRatio, relativeLuminance } from '../src/utils/contrast.ts';

const readFile = (rel: string): string =>
  readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * Brace-match the rule that starts at `blockStart`. Markers must include the
 * opening `{` so a comment such as `overridden by [data-theme="light"] below`
 * cannot steal the light-theme lookup, and so a prefix such as
 * `:root[data-variant="happy"]` cannot leak into the happy-dark block.
 */
function extractBlock(css: string, blockStart: string): string {
  const start = css.indexOf(blockStart);
  assert.ok(start >= 0, `theme block not found: ${blockStart}`);
  const open = css.indexOf('{', start);
  assert.ok(open >= 0, `opening brace for ${blockStart} not found`);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open, i + 1);
    }
  }
  assert.fail(`unclosed theme block: ${blockStart}`);
}

/** Extract the first `--name: #hex` inside the brace-bounded `blockStart` rule. */
function token(css: string, blockStart: string, name: string): string {
  const slice = extractBlock(css, blockStart);
  const m = slice.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(m, `${name} not found in block ${blockStart}`);
  return m![1]!;
}

describe('contrast util', () => {
  it('computes WCAG contrast ratio at the extremes', () => {
    assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
    assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  });

  it('parses 3-digit and #-less hex', () => {
    assert.equal(relativeLuminance('#fff'), relativeLuminance('#ffffff'));
    assert.equal(relativeLuminance('000'), relativeLuminance('#000000'));
  });

  it('picks white text only when it clears AA, else dark — for every correlation score color', () => {
    // The CorrelationPanel score-badge backgrounds (#4421 / #4418).
    const cases: Array<[string, '#ffffff' | '#1a1a1a']> = [
      ['#6f6f6f', '#ffffff'], // low (dark bg → white)
      ['#ff4444', '#1a1a1a'], // critical (white was 3.41 → dark)
      ['#ff8800', '#1a1a1a'], // high (white was 2.39 → dark)
      ['#ffcc00', '#1a1a1a'], // medium (white was 1.51 → dark)
    ];
    for (const [bg, expected] of cases) {
      const text = readableTextColor(bg);
      assert.equal(text, expected, `${bg} should use ${expected}`);
      // The chosen text color must actually clear WCAG AA (4.5:1) on that bg.
      assert.ok(
        contrastRatio(text, bg) >= 4.5,
        `${text} on ${bg} must be >= 4.5:1 (got ${contrastRatio(text, bg).toFixed(2)})`,
      );
    }
  });

  it('always returns the higher-contrast of white/dark', () => {
    for (const bg of ['#000000', '#ffffff', '#808080', '#123456', '#abcdef']) {
      const text = readableTextColor(bg);
      const other = text === '#ffffff' ? '#1a1a1a' : '#ffffff';
      assert.ok(contrastRatio(text, bg) >= contrastRatio(other, bg));
    }
  });
});

/**
 * Guard the theme text-token table itself (#6573). Each theme block must keep
 * --text-dim / --text-muted / --text-faint at WCAG AA (4.5:1) against both the
 * theme's --bg and --surface (panels render on --surface, the stricter of the
 * two on dark themes). --text-ghost is decorative-only and must clear the 3:1
 * non-text / large-text floor.
 */
describe('theme text-token contrast', () => {
  const mainCss = readFile('src/styles/main.css');
  const happyCss = readFile('src/styles/happy-theme.css');

  const themes: Array<{ name: string; css: string; block: string }> = [
    { name: 'dark', css: mainCss, block: ':root {' },
    { name: 'light', css: mainCss, block: '[data-theme="light"] {' },
    { name: 'happy light', css: happyCss, block: ':root[data-variant="happy"][data-theme="light"] {' },
    { name: 'happy dark', css: happyCss, block: ':root[data-variant="happy"][data-theme="dark"] {' },
  ];

  it('extracts a distinct --bg from each theme block', () => {
    const backgrounds = themes.map((theme) => token(theme.css, theme.block, '--bg').toLowerCase());
    assert.equal(
      new Set(backgrounds).size,
      themes.length,
      `theme --bg values must not collide (got ${backgrounds.join(', ')}) — a shared value usually means the extractor landed in the wrong block`,
    );
  });

  for (const theme of themes) {
    it(`${theme.name}: text tokens clear their contrast floors on --bg and --surface`, () => {
      const bg = token(theme.css, theme.block, '--bg');
      const surface = token(theme.css, theme.block, '--surface');
      for (const [name, floor] of [
        ['--text-dim', 4.5],
        ['--text-muted', 4.5],
        ['--text-faint', 4.5],
        ['--text-ghost', 3.0],
      ] as const) {
        const color = token(theme.css, theme.block, name);
        for (const base of [bg, surface]) {
          const ratio = contrastRatio(color, base);
          assert.ok(
            ratio >= floor,
            `${theme.name} ${name} (${color}) on ${base} is ${ratio.toFixed(2)}:1, needs >= ${floor}:1`,
          );
        }
      }
    });
  }
});

/**
 * Guard the plan-card billing tones (#7315 / #7340). The 13px-bold plan name
 * reads `--billing-tone-*` as its foreground; every theme that defines those
 * tokens must keep them at WCAG AA (4.5:1) on both --bg and --surface.
 * Light values are the ones that used to fail (3.49:1 / 2.41:1 for ending /
 * unknown) when the card inlined dark-theme hex.
 */
describe('billing tone contrast', () => {
  const mainCss = readFile('src/styles/main.css');
  const happyCss = readFile('src/styles/happy-theme.css');
  const settingsSource = readFile('src/components/UnifiedSettings.ts');
  const tones = [
    '--billing-tone-active',
    '--billing-tone-attention',
    '--billing-tone-ending',
    '--billing-tone-ended',
    '--billing-tone-unknown',
  ] as const;

  /** Dark tokens live in the second `:root` (semantic/threat), not the first. */
  const tokenInAnyRoot = (css: string, name: string): string => {
    let searchFrom = 0;
    while (searchFrom < css.length) {
      const idx = css.indexOf(':root {', searchFrom);
      if (idx < 0) break;
      const slice = extractBlock(css.slice(idx), ':root {');
      const m = slice.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
      if (m) return m[1]!;
      searchFrom = idx + 7;
    }
    assert.fail(`${name} not found in any :root block`);
  };

  it('paints the plan name from data-billing-tone, not an inlined hex', () => {
    assert.match(
      settingsSource,
      /data-billing-tone="\$\{tone\}"/,
      'the entitled plan card must stamp data-billing-tone so light overrides apply',
    );
    assert.match(
      settingsSource,
      /class="upgrade-pro-plan-name"/,
      'the 13px plan name must use the theme-aware class, not an inline color',
    );
    assert.doesNotMatch(
      settingsSource,
      /BILLING_TONE_COLORS/,
      'inlined hex map would bypass [data-theme="light"] billing-tone overrides',
    );
  });

  it('dark: every billing tone clears 4.5:1 on --bg and --surface', () => {
    const bg = token(mainCss, ':root {', '--bg');
    const surface = token(mainCss, ':root {', '--surface');
    for (const tone of tones) {
      const color = tokenInAnyRoot(mainCss, tone);
      for (const base of [bg, surface]) {
        const ratio = contrastRatio(color, base);
        assert.ok(
          ratio >= 4.5,
          `dark ${tone} (${color}) on ${base} is ${ratio.toFixed(2)}:1, needs >= 4.5:1`,
        );
      }
    }
  });

  it('light: every billing tone clears 4.5:1 on --bg and --surface', () => {
    const block = '[data-theme="light"] {';
    const bg = token(mainCss, block, '--bg');
    const surface = token(mainCss, block, '--surface');
    for (const tone of tones) {
      const color = token(mainCss, block, tone);
      for (const base of [bg, surface]) {
        const ratio = contrastRatio(color, base);
        assert.ok(
          ratio >= 4.5,
          `light ${tone} (${color}) on ${base} is ${ratio.toFixed(2)}:1, needs >= 4.5:1`,
        );
      }
    }
  });

  for (const theme of [
    {
      name: 'happy light',
      block: ':root[data-variant="happy"][data-theme="light"] {',
    },
    {
      name: 'happy dark',
      block: ':root[data-variant="happy"][data-theme="dark"] {',
    },
  ]) {
    it(`${theme.name}: every billing tone clears 4.5:1 on --bg and --surface`, () => {
      const bg = token(happyCss, theme.block, '--bg');
      const surface = token(happyCss, theme.block, '--surface');
      for (const tone of tones) {
        const color = token(happyCss, theme.block, tone);
        for (const base of [bg, surface]) {
          const ratio = contrastRatio(color, base);
          assert.ok(
            ratio >= 4.5,
            `${theme.name} ${tone} (${color}) on ${base} is ${ratio.toFixed(2)}:1, needs >= 4.5:1`,
          );
        }
      }
    });
  }
});
