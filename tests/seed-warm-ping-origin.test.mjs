import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readScript(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf-8');
}

describe('warm-ping seed scripts', () => {
  it('sends the app Origin header for infrastructure warm-pings', () => {
    const src = readScript('scripts/seed-infra.mjs');
    assert.match(src, /Origin:\s*'https:\/\/worldmonitor\.app'/);
    assert.match(src, /method:\s*'POST'/);
  });

  it('sends the app Origin header for military/maritime warm-pings', () => {
    const src = readScript('scripts/seed-military-maritime-news.mjs');
    assert.match(src, /Origin:\s*'https:\/\/worldmonitor\.app'/);
    assert.match(src, /method:\s*'POST'/);
  });
});
