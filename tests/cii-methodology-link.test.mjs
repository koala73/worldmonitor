import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function read(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('CIIPanel visible methodology link', () => {
  it('renders the CII methodology URL in panel content outside the tooltip', () => {
    const src = read('src/components/CIIPanel.ts');
    assert.match(src, /export const CII_METHODOLOGY_HREF = '\/docs\/methodology\/cii-risk-scores';/);
    assert.match(src, /private buildMethodologyFooter\(\): HTMLElement/);
    assert.match(src, /className: 'cii-methodology-footer'/);
    assert.match(src, /href: CII_METHODOLOGY_HREF/);
    assert.match(src, /replaceChildren\(this\.content, this\.buildList\(withData\), this\.buildMethodologyFooter\(\)\)/);
    assert.match(src, /replaceChildren\(this\.content, this\.buildList\(scores\), this\.buildMethodologyFooter\(\)\)/);
  });

  it('styles the visible footer as an in-panel link', () => {
    const css = read('src/styles/main.css');
    assert.match(css, /\.cii-methodology-footer\s*\{/);
    assert.match(css, /\.cii-methodology-footer a\s*\{/);
  });
});
