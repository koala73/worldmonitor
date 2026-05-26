import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
const csp = indexHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
const inlineScripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const variantBootstrapScript = inlineScripts.find(
  (script) => script.includes('worldmonitor-variant') && script.includes('document.documentElement.dataset.variant'),
);

describe('variant inline bootstrap', () => {
  it('detects every public variant host before the app bundle loads', () => {
    for (const variant of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.ok(
        indexHtml.includes(`h.startsWith('${variant}.'))v='${variant}'`),
        `index.html inline bootstrap must set data-variant for ${variant}.worldmonitor.app`,
      );
    }
  });

  it('allows the inline variant bootstrap through the CSP', () => {
    assert.ok(variantBootstrapScript, 'index.html must include the inline variant bootstrap script');

    const hash = createHash('sha256').update(variantBootstrapScript).digest('base64');
    assert.ok(
      csp.includes(`'sha256-${hash}'`),
      `Content-Security-Policy must include sha256-${hash} for the inline variant bootstrap script`,
    );
  });
});
