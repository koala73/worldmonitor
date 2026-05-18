import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { getCorsHeaders } from '../server/cors.ts';

// Regression coverage for issue #3705: CORS-header generation errors must
// fail closed rather than fall back to `Access-Control-Allow-Origin: *`.

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
  it('does not contain a wildcard ACAO fallback in source', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // No literal that pairs Access-Control-Allow-Origin with `*` should
    // appear in gateway.ts. The pre-#3705 fallback was:
    //   corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    const widening = /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/i;
    assert.ok(
      !widening.test(source),
      'gateway.ts must not emit wildcard ACAO — see issue #3705',
    );
  });

  it('routes CORS exceptions through captureSilentError + 500 (no wildcard)', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // The fail-closed branch must log the original error to Sentry AND
    // return a 5xx instead of a permissive CORS response.
    assert.ok(
      /catch \(err\)[\s\S]{0,200}captureSilentError\(err/.test(source),
      'gateway.ts cors catch must pass the original error to captureSilentError',
    );
    assert.ok(
      /step:\s*['"]cors_headers['"]/.test(source),
      'gateway.ts cors catch must tag Sentry events with step="cors_headers"',
    );
  });
});
