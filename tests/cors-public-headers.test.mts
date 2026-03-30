import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corsSrc = readFileSync(resolve(__dirname, '..', 'server', 'cors.ts'), 'utf-8');

describe('getPublicCorsHeaders', () => {
  it('returns ACAO: * without Vary header', () => {
    // Verify the function body contains ACAO: * and does NOT include Vary
    const fnMatch = corsSrc.match(/export function getPublicCorsHeaders[\s\S]*?^}/m);
    assert.ok(fnMatch, 'getPublicCorsHeaders function not found in server/cors.ts');
    const fnBody = fnMatch![0];
    assert.match(fnBody, /'Access-Control-Allow-Origin':\s*'\*'/, 'Should set ACAO: *');
    assert.doesNotMatch(fnBody, /Vary/, 'Should NOT include Vary header');
  });

  it('includes same Allow-Methods as getCorsHeaders', () => {
    const pubMethods = corsSrc.match(/getPublicCorsHeaders[\s\S]*?Allow-Methods':\s*'([^']+)'/);
    const perOriginMethods = corsSrc.match(/getCorsHeaders[\s\S]*?Allow-Methods':\s*'([^']+)'/);
    assert.ok(pubMethods && perOriginMethods, 'Could not extract Allow-Methods from both functions');
    assert.equal(pubMethods![1], perOriginMethods![1], 'Allow-Methods should match between public and per-origin');
  });

  it('includes same Allow-Headers as getCorsHeaders', () => {
    const pubHeaders = corsSrc.match(/getPublicCorsHeaders[\s\S]*?Allow-Headers':\s*'([^']+)'/);
    const perOriginHeaders = corsSrc.match(/getCorsHeaders[\s\S]*?Allow-Headers':\s*'([^']+)'/);
    assert.ok(pubHeaders && perOriginHeaders, 'Could not extract Allow-Headers from both functions');
    assert.equal(pubHeaders![1], perOriginHeaders![1], 'Allow-Headers should match between public and per-origin');
  });
});
