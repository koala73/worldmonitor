import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
const lintMdScript = packageJson.scripts?.['lint:md'] ?? '';

describe('markdown lint script scope', () => {
  it('excludes non-product markdown trees from lint target', () => {
    assert.match(lintMdScript, /markdownlint-cli2/);
    assert.match(lintMdScript, /'!\.agent\/\*\*'/);
    assert.match(lintMdScript, /'!\.agents\/\*\*'/);
    assert.match(lintMdScript, /'!\.claude\/\*\*'/);
    assert.match(lintMdScript, /'!\.factory\/\*\*'/);
    assert.match(lintMdScript, /'!\.windsurf\/\*\*'/);
    assert.match(lintMdScript, /'!skills\/\*\*'/);
    assert.match(lintMdScript, /'!docs\/internal\/\*\*'/);
    assert.match(lintMdScript, /'!docs\/Docs_To_Review\/\*\*'/);
  });
});
