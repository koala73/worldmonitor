import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const panel = readFileSync(resolve(root, 'src/components/CIIPanel.ts'), 'utf8');
const css = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');

describe('CII country rows are not nested interactive', () => {
  it('does not put role=button on .cii-country (hosts Follow + Share)', () => {
    assert.doesNotMatch(
      panel,
      /className:\s*['"]cii-country['"][\s\S]{0,80}role:\s*['"]button['"]/,
    );
  });

  it('puts role=button tabindex=0 on .cii-name and binds keys there', () => {
    assert.match(
      panel,
      /className:\s*['"]cii-name['"],\s*role:\s*['"]button['"],\s*tabindex:\s*['"]0['"]/,
    );
    assert.match(panel, /bindActivationKeys\(\s*this\.content,\s*['"]\.cii-name['"]\s*\)/);
  });

  it('focus-visible outline targets .cii-name, not the wrapping row', () => {
    assert.match(css, /\.cii-name:focus-visible/);
    assert.doesNotMatch(css, /\.cii-country:focus-visible/);
  });
});
