import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DATA_LOADER_TS = readFileSync(resolve(REPO_ROOT, 'src/app/data-loader.ts'), 'utf8');

function extractMethodBody(src: string, signature: string): string {
  const signatureStart = src.indexOf(signature);
  assert.ok(signatureStart >= 0, `could not find ${signature}`);

  const bodyStart = src.indexOf('{', signatureStart);
  assert.ok(bodyStart > signatureStart, `could not find body for ${signature}`);

  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return src.slice(bodyStart + 1, i);
  }

  assert.fail(`could not find end of body for ${signature}`);
}

describe('loadAllData scheduler', () => {
  const loadAllDataBody = extractMethodBody(DATA_LOADER_TS, 'async loadAllData(');

  it('does not add a blanket inter-batch startup delay', () => {
    assert.doesNotMatch(
      loadAllDataBody,
      /\bBATCH_DELAY_MS\b|\bBATCH_SIZE\b|setTimeout\s*\(/,
      'loadAllData must not reintroduce a fixed startup batch sleep; throttle constrained sources in their loader/service instead',
    );
  });

  it('awaits the scheduled guarded load promises together', () => {
    assert.match(
      loadAllDataBody,
      /await\s+Promise\.allSettled\s*\(\s*tasks\.map\s*\(\s*t\s*=>\s*t\.task\s*\)\s*\)/,
      'loadAllData should settle the task promises without artificial inter-batch waits',
    );
  });
});
