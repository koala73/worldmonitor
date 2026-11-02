/**
 * `--text-primary` follows the theme.
 *
 * About 40 rules (settings groups, Forecast, Threat Timeline, Route Explorer,
 * chokepoint and aircraft-emergency panels, transit charts) read
 * `var(--text-primary, <light grey>)`. The token was never defined, so every
 * one of them rendered light grey on white in the light theme. It now aliases
 * `--text`; surfaces that stay dark in both themes reset it to `initial` so
 * their bright fallbacks still apply.
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

  it('always-dark surfaces reset --text-primary so their bright fallbacks apply', () => {
    const body = ruleBody(':is\\(\\.update-toast, \\.passkey-offer-prompt, \\.re-modal\\)');
    assert.match(body, /--text-primary:\s*initial\s*;/);
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
