import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isKnownPublicPagePath, suggestNotFoundSection } from '../src/config/agent-not-found.ts';
import { getRootlessDocsDestination } from '../src/config/docs-root-redirects.ts';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';

const SLASH_RUN = 14_000;

describe('request path trailing slashes', () => {
  it('normalizes a 14k slash run in linear time', () => {
    const path = `/x${'/'.repeat(SLASH_RUN)}/y`;
    const started = performance.now();
    assert.equal(isKnownPublicPagePath(path), false);
    assert.equal(suggestNotFoundSection(path), null);
    assert.equal(getRootlessDocsDestination(path), null);
    assert.equal(isPublicSharedRpcRequest(`https://worldmonitor.app${path}?public=1`), false);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 50, `slash-run normalization took ${elapsed.toFixed(1)}ms`);
  });

  it('still treats a trailing slash on a known path as that path', () => {
    assert.equal(isKnownPublicPagePath('/docs/'), true);
    assert.equal(
      isPublicSharedRpcRequest('https://worldmonitor.app/api/forecast/v1/get-forecasts/?public=1'),
      true,
    );
  });
});
