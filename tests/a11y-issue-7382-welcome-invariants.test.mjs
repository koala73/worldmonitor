import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const footer = readFileSync(resolve(root, 'pro-test/src/components/Footer.tsx'), 'utf8');
const logo = readFileSync(resolve(root, 'pro-test/src/components/Logo.tsx'), 'utf8');
const nav = readFileSync(resolve(root, 'pro-test/src/welcome/Nav.tsx'), 'utf8');

describe('welcome a11y invariants (#7382)', () => {
  it('keeps footer copyright and byline at solid muted contrast (no opacity fade)', () => {
    assert.doesNotMatch(footer, /opacity-40/);
    assert.doesNotMatch(footer, /opacity-60/);
    assert.match(footer, /text-wm-muted/);
    assert.match(footer, /text-\[10px\] text-wm-muted/);
  });

  it('names the home control from visible WORLD MONITOR text (no mismatched aria-label)', () => {
    assert.doesNotMatch(logo, /aria-label=/);
    assert.match(logo, /WORLD MONITOR/);
    assert.match(logo, /aria-hidden="true"/);
  });

  it('keeps Launch CTA aria-label matching visible copy (critical CSS + a11y)', () => {
    // Matching aria-label is intentional: prerender critical CSS keys off
    // nav[data-wm-nav] a[aria-label*="Launch"], and the label equals visible text.
    assert.match(nav, /aria-label=\{t\('welcome\.nav\.launch'\)\}/);
    assert.match(nav, /\{t\('welcome\.nav\.launch'\)\}/);
  });
});

