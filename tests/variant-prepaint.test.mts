import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { applyBuildVariantToPrepaint } from '../src/config/variant-prepaint.ts';

const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const prepaintScript = (html: string): string => {
  const match = html.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html must contain the marked pre-paint bootstrap script');
  return match[1];
};

describe('dedicated variant pre-paint transform', () => {
  it('keeps the public full build on the runtime hostname branch', () => {
    assert.equal(applyBuildVariantToPrepaint(indexHtml, 'full'), indexHtml);
  });

  it('does not require dashboard bootstrap markup on other HTML routes', () => {
    const harnessHtml = '<!doctype html><title>Map test harness</title>';
    assert.equal(applyBuildVariantToPrepaint(harnessHtml, 'finance'), harnessHtml);
  });

  for (const variant of ['tech', 'finance', 'commodity', 'energy', 'happy']) {
    it(`emits a syntactically valid ${variant} pre-paint bootstrap`, () => {
      const script = prepaintScript(applyBuildVariantToPrepaint(indexHtml, variant));
      assert.match(script, new RegExp(`v=${JSON.stringify(variant)};document\\.documentElement\\.dataset\\.variant=v;`));
      assert.doesNotMatch(script, /else document\.documentElement\.removeAttribute\('data-variant'\)/);
      assert.doesNotThrow(() => new Script(script), `${variant} dedicated bootstrap must parse`);
      assert.equal(
        applyBuildVariantToPrepaint(applyBuildVariantToPrepaint(indexHtml, variant), variant),
        applyBuildVariantToPrepaint(indexHtml, variant),
        `${variant} transform must remain valid when Vite invokes it more than once`,
      );
    });
  }
});
