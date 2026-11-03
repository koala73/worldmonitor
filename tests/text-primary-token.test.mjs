/**
 * `--text-primary` follows the theme.
 *
 * About 40 rules (settings groups, Forecast, Threat Timeline, Route Explorer,
 * chokepoint and aircraft-emergency panels, transit charts) read
 * `var(--text-primary, <light grey>)`. The token was never defined, so every
 * one of them rendered light grey on white in the light theme. It now aliases
 * `--text`; the always-dark Route Explorer modal pins its own bright value.
 *
 * `--border-color` had the same gap (dark-grey fallbacks drawn on white) and
 * now aliases `--border`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selectorPattern) {
  const m = main.match(new RegExp(`(?:^|[;}])\\s*${selectorPattern}\\s*\\{([^{}]*)\\}`));
  assert.ok(m, `rule ${selectorPattern} not found`);
  return m[1];
}

describe('--text-primary token', () => {
  it(':root defines --text-primary as an alias of --text', () => {
    assert.match(ruleBody(':root'), /--text-primary:\s*var\(--text\)\s*;/);
  });

  it(':root defines --border-color as an alias of --border', () => {
    assert.match(ruleBody(':root'), /--border-color:\s*var\(--border\)\s*;/);
  });

  it('Route Explorer pins a bright --text-primary on its always-dark modal', () => {
    const re = readFileSync(new URL('../src/styles/route-explorer.css', import.meta.url), 'utf8');
    const body = re.replace(/\/\*[\s\S]*?\*\//g, '').match(/(?:^|\})\s*\.re-modal\s*\{([^{}]*)\}/)?.[1] ?? '';
    assert.match(body, /--text:\s*#e8e8e8\s*;/);
    assert.match(body, /--text-primary:\s*var\(--text\)\s*;/);
  });
});

describe('settings groups follow the theme', () => {
  for (const sel of ['\\.wm-pref-group', '\\.wm-pref-group > summary', '\\.wm-pref-group > summary:hover']) {
    it(`${sel.replace(/\\/g, '')} has no hard-coded white overlay`, () => {
      assert.doesNotMatch(ruleBody(sel), /rgba\(\s*255\s*,\s*255\s*,\s*255/);
    });
  }
  for (const sel of ['\\.ai-flow-section-label', '\\.ai-flow-cta', '\\.ai-flow-popup-footer']) {
    it(`${sel.replace(/\\/g, '')} divider uses the theme border`, () => {
      assert.match(ruleBody(sel), /border-top:\s*1px solid var\(--border\)\s*;/);
    });
  }
});

describe('transit chart tooltip follows the theme', () => {
  it('pairs its --text-primary text with a themed background', () => {
    const src = readFileSync(new URL('../src/utils/transit-chart.ts', import.meta.url), 'utf8');
    const style = src.match(/this\.tooltip\.style,\s*\{([\s\S]*?)\}\);/)?.[1] ?? '';
    assert.match(style, /color: 'var\(--text-primary/);
    // --bg-elevated is not defined anywhere, so it always fell back to dark navy.
    assert.match(style, /background: 'var\(--surface[,)]/);
  });
});
