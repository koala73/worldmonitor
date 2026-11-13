import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The fast bootstrap tier is a credential-less public read. The wm-session
// fetch interceptor passes it straight through (isCredentiallessPublicDataRequest),
// and every session-bound call awaits the mint on its own. Boot used to await
// the anonymous session mint before requesting the fast tier, which put a full
// /api/wm-session round trip in front of the first dashboard data: measured on
// a production build against live data, the mint took 272 ms and the fast tier
// only started after it finished. Session-bound calls still wait for the mint
// inside the interceptor, so boot does not need to.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const APP_TS = readFileSync(resolve(REPO_ROOT, 'src/App.ts'), 'utf8');
const WM_SESSION_TS = readFileSync(resolve(REPO_ROOT, 'src/services/wm-session.ts'), 'utf8');
const BOOTSTRAP_TS = readFileSync(resolve(REPO_ROOT, 'src/services/bootstrap.ts'), 'utf8');

describe('boot overlaps the session mint with the fast bootstrap tier', () => {
  const start = APP_TS.indexOf('installWmSessionFetchInterceptor();');
  const end = APP_TS.indexOf("markLcpDebug('wm:boot:fast-bootstrap-ready');", start);
  const boot = APP_TS.slice(start, end);

  it('starts the mint without awaiting it before the fast tier', () => {
    assert.ok(start >= 0 && end > start, 'could not locate the boot session/bootstrap block');
    const mint = boot.indexOf('ensureWmSession()');
    const fastTier = boot.indexOf('await fetchBootstrapData(');
    assert.ok(mint >= 0 && fastTier > mint, 'the mint must start before the fast tier request');
    assert.doesNotMatch(boot.slice(0, fastTier), /await ensureWmSession\(\)/, 'awaiting the mint first serializes two round trips');
  });

  it('never lets a rejected mint escape into boot', () => {
    assert.match(boot, /void ensureWmSession\(\)\s*\.catch\(\(\) => false\)/, 'old WebView engines reject the mint; boot must swallow it');
    assert.doesNotMatch(boot, /await ensureWmSession\(\)/, 'no boot step waits on the mint');
  });

  it('keeps every web API transport behind the fetch interceptor that awaits the mint', () => {
    assert.match(WM_SESSION_TS, /await ensureWmSession\(\)\.catch\(\(\) => false\);/);
  });

  it('relies on the interceptor passing public tier reads through without a session', () => {
    assert.match(WM_SESSION_TS, /if \(isCredentiallessPublicDataRequest\(input, init, url\)\) return original\(input, init\);/);
    assert.match(BOOTSTRAP_TS, /toApiUrl\(`\/api\/bootstrap\?tier=\$\{tier\}&public=1`\)/);
    assert.match(BOOTSTRAP_TS, /await fetch\(requestUrl, \{ signal, credentials: 'omit' \}\)/);
  });
});
