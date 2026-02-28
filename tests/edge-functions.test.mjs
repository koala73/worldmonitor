import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const apiDir = join(root, 'api');

// All .js files in api/ except underscore-prefixed helpers (_cors.js, _api-key.js)
const edgeFunctions = readdirSync(apiDir)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .map((f) => ({ name: f, path: join(apiDir, f) }));

describe('Edge Function module isolation', () => {
  for (const { name, path } of edgeFunctions) {
    it(`${name} does not import from ../server/ (Edge Functions cannot resolve cross-directory TS)`, () => {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !src.includes("from '../server/"),
        `${name}: imports from ../server/ — Vercel Edge Functions cannot resolve cross-directory TS imports. Inline the code or move to a same-directory .js helper.`,
      );
    });

    it(`${name} does not import from ../src/ (Edge Functions cannot resolve TS aliases)`, () => {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !src.includes("from '../src/"),
        `${name}: imports from ../src/ — Vercel Edge Functions cannot resolve @/ aliases or cross-directory TS. Inline the code instead.`,
      );
    });
  }
});
