import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './_lib/built-output-guard.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtVerify = resolve(repoRoot, 'dist/verify.html');

guardBuiltOutput(builtVerify);

function headTags(html) {
  return {
    title: html.match(/<title>(.*?)<\/title>/)?.[1],
    description: html.match(/<meta name="description" content="(.*?)" \/>/)?.[1],
    canonical: html.match(/<link rel="canonical" href="(.*?)" \/>/)?.[1],
  };
}

describe('built /verify page head', { skip: shouldSkipBuiltOutput(builtVerify) }, () => {
  it('keeps its own title, description and canonical instead of the dashboard brand meta', () => {
    const source = headTags(readFileSync(resolve(repoRoot, 'verify.html'), 'utf8'));
    assert.equal(source.canonical, 'https://www.worldmonitor.app/verify');
    assert.deepEqual(headTags(readFileSync(builtVerify, 'utf8')), source);
  });
});
