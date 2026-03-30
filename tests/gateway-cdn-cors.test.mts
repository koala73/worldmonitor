import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'server', 'gateway.ts'), 'utf-8');

// Extract the GET 200 cache block (between "response.status === 200 && request.method === 'GET'" and the next closing brace at indentation 4)
const cacheBlock = (() => {
  const start = src.indexOf("response.status === 200 && request.method === 'GET' && response.body");
  if (start === -1) return '';
  return src.slice(start, start + 3000);
})();

describe('gateway CDN CORS policy', () => {
  it('sets ACAO: * when CDN-Cache-Control is present and route is not premium', () => {
    assert.match(
      cacheBlock,
      /getPublicCorsHeaders/,
      'Cache block should call getPublicCorsHeaders for CDN-cached routes',
    );
    assert.match(
      cacheBlock,
      /!PREMIUM_RPC_PATHS\.has\(pathname\)/,
      'Should guard public CORS behind premium path check',
    );
  });

  it('deletes Vary header when CDN-Cache-Control is present and route is not premium', () => {
    assert.match(
      cacheBlock,
      /mergedHeaders\.delete\('Vary'\)/,
      'Should delete Vary header for non-premium CDN-cached routes',
    );
  });

  it('preserves per-origin ACAO for premium routes even with CDN-Cache-Control', () => {
    // The ACAO: * block is guarded by !PREMIUM_RPC_PATHS.has(pathname),
    // so premium routes skip it and keep per-origin CORS from corsHeaders
    assert.match(
      cacheBlock,
      /if\s*\(!PREMIUM_RPC_PATHS\.has\(pathname\)\)/,
      'Public CORS should only apply when NOT a premium path',
    );
  });

  it('preserves per-origin ACAO for no-store tier', () => {
    // no-store tier has cdnCache = null, so the ACAO: * block never runs
    const tierMap = src.match(/'no-store':\s*null/);
    assert.ok(tierMap, 'no-store CDN tier should be null (no CDN-Cache-Control)');
  });

  it('preserves per-origin ACAO for POST requests', () => {
    // The entire GET 200 block is guarded by request.method === 'GET'
    assert.match(
      cacheBlock,
      /request\.method\s*===\s*'GET'/,
      'CDN cache block only applies to GET requests',
    );
  });

  it('imports getPublicCorsHeaders from cors module', () => {
    assert.match(
      src,
      /import\s*\{[^}]*getPublicCorsHeaders[^}]*\}\s*from\s*'\.\/cors'/,
      'gateway.ts should import getPublicCorsHeaders',
    );
  });
});
