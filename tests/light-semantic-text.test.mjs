/**
 * Semantic colors used as text are readable in the light theme.
 *
 * The light palette keeps red, orange, amber and green bright enough for fills,
 * borders and map markers (3.2-3.6:1 on white), which is too faint for text.
 * Text rules read `var(--X-text, var(--X))`: the light theme defines the
 * darker `--X-text` shades, the dark theme leaves them undefined so the
 * fallback (and any scoped override of `--X`) applies. Surfaces that stay dark
 * in the light theme reset the `-text` tokens to `initial`, which restores the
 * fallback there too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const stylesDir = new URL('../src/styles/', import.meta.url);
const read = (url) => readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Sheets that render inside the dashboard, with main.css's tokens. */
const NOT_DASHBOARD = new Set(['plugin-market.css', 'happy-theme.css']);
const sheets = {
  ...Object.fromEntries(readdirSync(stylesDir)
    .filter((f) => f.endsWith('.css') && !NOT_DASHBOARD.has(f))
    .map((f) => [`styles/${f}`, read(new URL(f, stylesDir))])),
  'components/ukmto-incidents.css': read(new URL('../src/components/ukmto-incidents.css', import.meta.url)),
};
const main = sheets['styles/main.css'];
const happy = read(new URL('happy-theme.css', stylesDir));

const SEMANTIC = ['red', 'green', 'yellow', 'semantic-critical', 'semantic-high', 'semantic-elevated',
  'semantic-positive', 'status-live', 'status-cached', 'status-unavailable'];

/** Surfaces with a hard-coded dark background in both themes. */
const ALWAYS_DARK = ['.update-toast', '.passkey-offer-prompt', '.re-modal'];

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].split(';').pop().trim().replace(/\s+/g, ' '),
    body: m[2],
    at: m.index + m[1].length,
  }));
}

function tokens(body) {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function block(css, selector) {
  const found = rules(css).filter((r) => r.selector === selector);
  assert.ok(found.length > 0, `${selector} not found`);
  return Object.assign({}, ...found.map((r) => tokens(r.body)));
}

const dark = block(main, ':root');
const light = { ...dark, ...block(main, '[data-theme="light"]') };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('light-theme semantic text', () => {
  it('every text rule reads the -text token first', () => {
    const bare = new RegExp(`(?<![-\\w])color\\s*:\\s*var\\(\\s*--(${SEMANTIC.join('|')})\\s*\\)`, 'g');
    const failures = [];
    let scanned = 0;
    for (const [file, css] of Object.entries(sheets)) {
      for (const { selector, body, at } of rules(css)) {
        const line = () => css.slice(0, at).split('\n').length;
        scanned += (body.match(/(?<![-\w])color\s*:/g) ?? []).length;
        for (const m of body.matchAll(bare)) failures.push(`${file}:${line()} ${selector} color: var(--${m[1]})`);
      }
    }
    assert.ok(scanned > 1000, `only ${scanned} color declarations scanned; the scan is broken`);
    assert.deepEqual(failures, []);
  });

  for (const name of SEMANTIC) {
    it(`--${name}-text is light-only and meets 4.5:1 on the light surfaces`, () => {
      const value = light[`--${name}-text`];
      assert.match(value ?? '', /^#[0-9a-f]{6}$/i, `--${name}-text is not a hex in the light theme`);
      assert.equal(dark[`--${name}-text`], undefined, `--${name}-text must stay undefined in dark so the fallback applies`);
      for (const surface of ['--bg', '--surface', '--bg-secondary']) {
        const ratio = contrast(value, light[surface]);
        assert.ok(ratio >= 4.5, `--${name}-text ${value} on ${surface} ${light[surface]} is ${ratio.toFixed(2)}:1`);
      }
    });
  }

  it('surfaces that stay dark reset every -text token', () => {
    const resets = rules(main).filter((r) => ALWAYS_DARK.every((s) => r.selector.includes(s)));
    assert.equal(resets.length, 1, `expected one rule naming ${ALWAYS_DARK.join(', ')}`);
    const reset = tokens(resets[0].body);
    for (const name of SEMANTIC) assert.equal(reset[`--${name}-text`], 'initial', `--${name}-text is not reset`);
  });

  it('the happy variant keeps its own palette in light', () => {
    const happyLight = block(happy, ':root[data-variant="happy"], :root[data-variant="happy"][data-theme="light"]');
    for (const name of SEMANTIC) {
      assert.equal(happyLight[`--${name}-text`], 'initial', `happy light does not reset --${name}-text`);
    }
  });
});
