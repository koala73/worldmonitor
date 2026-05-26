import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { getCorsHeaders } from '../server/cors.ts';

// Regression coverage for issue #3705: CORS-header generation errors must
// fail closed rather than fall back to a wildcard ACAO.

// Named for self-documenting failure messages and so a future companion
// guard elsewhere can re-use the same shape.
const WILDCARD_ACAO_LITERAL = /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/i;

// Strip JS line and block comments so the wildcard-literal guard only
// fires on real code, not on a comment that documents the anti-pattern
// (e.g. a future PR description quoted in JSDoc above the fail-closed
// branch). This keeps the test honest if someone documents the original
// bug verbatim while keeping the fix intact.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('cors helper', () => {
  it('returns headers for a well-formed request', () => {
    const req = new Request('https://worldmonitor.app/x', {
      headers: { Origin: 'https://worldmonitor.app' },
    });
    const headers = getCorsHeaders(req);
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://worldmonitor.app');
  });

  it('propagates exceptions (caller must wrap in fail-closed try/catch)', () => {
    const throwingReq = {
      headers: {
        get(): string {
          throw new Error('simulated header failure');
        },
      },
    } as unknown as Request;
    assert.throws(() => getCorsHeaders(throwingReq), /simulated header failure/);
  });
});

describe('gateway CORS error path (issue #3705)', () => {
  it('does not contain a wildcard ACAO fallback in source (comments stripped)', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // The pre-#3705 fallback was:
    //   corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    // After stripping comments, no such literal should remain — that
    // would mean the wildcard widening regressed back into real code.
    assert.ok(
      !WILDCARD_ACAO_LITERAL.test(stripComments(source)),
      'gateway.ts must not emit wildcard ACAO in code — see issue #3705',
    );
  });

  it('routes CORS exceptions through captureSilentError + 500 (no wildcard)', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // The fail-closed branch must log the original error to Sentry AND
    // return a 5xx instead of a permissive CORS response. The gap is
    // bounded so we can tolerate minor refactoring inside the catch
    // (additional tags, intermediate variable names) without losing
    // the structural assertion.
    assert.ok(
      /catch \(err\)[\s\S]{0,500}captureSilentError\(err/.test(source),
      'gateway.ts cors catch must pass the original error to captureSilentError',
    );
    assert.ok(
      /step:\s*['"]cors_headers['"]/.test(source),
      'gateway.ts cors catch must tag Sentry events with step="cors_headers"',
    );
  });

  it('returns a non-cacheable 500 on CORS error so CDNs cannot pin it', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // Find the catch block for cors_headers and assert Cache-Control:
    // no-store appears inside the response headers within it.
    const catchBlock = source.match(/catch \(err\)[\s\S]{0,1500}?\n\s{4}\}/);
    assert.ok(catchBlock, 'expected to find the cors catch block in gateway.ts');
    assert.ok(
      /['"]Cache-Control['"]:\s*['"]no-store['"]/.test(catchBlock![0]),
      'cors fail-closed 500 must set Cache-Control: no-store',
    );
  });
});
