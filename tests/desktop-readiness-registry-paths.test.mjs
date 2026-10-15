import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'src/services/desktop-readiness.ts'), 'utf-8');

/**
 * #5910: DESKTOP_PARITY_FEATURES is a hand-maintained registry of which
 * service files, RPC routes and handler files back each desktop panel. Its
 * strings surface in the Service Status UI, and nothing checked them against
 * the tree — the strategic-risk entry cited `/api/risk-scores` and
 * `api/risk-scores.js` long after the gateway split deleted both. Parsed from
 * source (the module imports runtime-config, which reads Tauri globals) so
 * this stays a plain node:test file.
 */
function stringsIn(field) {
  return [...src.matchAll(new RegExp(`${field}: \\[([^\\]]*)\\]`, 'g'))]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

const serviceFiles = stringsIn('serviceFiles');
const apiHandlers = stringsIn('apiHandlers');
const apiRoutes = stringsIn('apiRoutes');

describe('desktop readiness registry cites real files (#5910)', () => {
  it('parses the registry', () => {
    assert.ok(serviceFiles.length >= 10, `serviceFiles: ${serviceFiles.length}`);
    assert.ok(apiHandlers.length >= 8, `apiHandlers: ${apiHandlers.length}`);
    assert.ok(apiRoutes.length >= 8, `apiRoutes: ${apiRoutes.length}`);
  });

  it('every serviceFiles entry exists', () => {
    const missing = serviceFiles.filter((p) => !existsSync(resolve(root, p)));
    assert.deepEqual(missing, [], 'service files cited by the registry that are not in the tree');
  });

  it('every apiHandlers entry exists', () => {
    const missing = apiHandlers.filter((p) => !existsSync(resolve(root, p)));
    assert.deepEqual(missing, [], 'handler files cited by the registry that are not in the tree');
  });

  it('every sebuf apiRoutes entry names an RPC that has a handler file', () => {
    // /api/{domain}/v1/{rpc} → server/worldmonitor/{domain}/v1/{rpc}.ts. Legacy
    // non-sebuf routes (/api/youtube/live) are covered by the apiHandlers check.
    const sebuf = apiRoutes.filter((r) => /^\/api\/[a-z-]+\/v1\/[a-z-]+$/.test(r));
    assert.ok(sebuf.length > 0);
    const orphaned = sebuf.filter((route) => {
      const [, , domain, , rpc] = route.split('/');
      return !existsSync(resolve(root, 'server/worldmonitor', domain.replace(/-/g, '_'), 'v1', `${rpc}.ts`))
        && !existsSync(resolve(root, 'server/worldmonitor', domain, 'v1', `${rpc}.ts`));
    });
    assert.deepEqual(orphaned, [], 'routes cited by the registry with no matching server/worldmonitor handler');
  });

  it('the strategic-risk entry points at the intelligence RPC, not the deleted edge function', () => {
    assert.doesNotMatch(src, /\/api\/risk-scores'|api\/risk-scores\.js/);
    assert.match(src, /apiRoutes: \['\/api\/intelligence\/v1\/get-risk-scores'\]/);
  });
});
