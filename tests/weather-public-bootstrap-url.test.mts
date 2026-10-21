// The weather layer's direct bootstrap read must target the CDN-shielded PUBLIC
// URL, credential-less (#5386).
//
// Why this needs its own guard: the bare `?keys=weatherAlerts` URL still answers
// anonymous callers, so a regression back to it does not fail loudly — the panel
// keeps rendering. What silently changes is that every read becomes an uncached
// origin hit (the bare URL is `no-store` by design, precisely so no shared cache
// can answer a credentialed request there), and the map embed re-reads this on a
// poll loop with no tier hydration behind it. That is the origin-miss-rate trap
// docs/solutions/best-practices/egress-cost-tracks-origin-miss-rate-not-client-count.md
// is about.
//
// The only prior cover was e2e/embed.spec.ts's network-tracking list, which keys
// on the exact query string — and that list was itself left pinned to the old URL
// when the client moved, so it would have failed rather than caught anything.
//
// Source-level rather than behavioral, deliberately: src/services/weather.ts
// reaches `@/utils` -> src/utils/proxy.ts, which reads `import.meta.env.DEV`, so
// tsx cannot import it (the constraint documented in vitest.dom.config.mts). This
// matches the precedent tests/bootstrap.test.mjs already sets for the sibling
// tier URLs. It asserts the WHOLE fetch call, not a substring near it — a
// proximity check would pass with the marker dropped, since the bare URL is a
// prefix of the marked one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  PUBLIC_WEATHER_BOOTSTRAP_KEY,
  BOOTSTRAP_CACHE_KEYS,
  BOOTSTRAP_TIERS,
} from '../shared/bootstrap-tier-keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const weatherSrc = readFileSync(join(root, 'src/services/weather.ts'), 'utf-8');

describe('weather bootstrap read targets the public CDN-shielded URL (#5386)', () => {
  it('fetches the marked public URL with credentials omitted', () => {
    // Match the entire call expression so the URL literal is pinned exactly.
    // `[\s\S]*?` spans the multi-line formatting; the terminating `)` keeps the
    // match inside this one call.
    const call = weatherSrc.match(/const resp = await fetch\(([\s\S]*?)\n {4}\);/);
    assert.ok(call, 'could not locate the weather bootstrap fetch call in src/services/weather.ts');

    const callArgs = call[1]!;
    assert.match(
      callArgs,
      /toApiUrl\('\/api\/bootstrap\?keys=weatherAlerts&public=1'\)/,
      `weather must read the marked public URL; got: ${callArgs.trim()}`,
    );
    assert.match(
      callArgs,
      /credentials: 'omit'/,
      'credentials must be omitted: the marked URL answers every caller identically, and the '
      + 'wm-session interceptor only waves through credential-less public reads',
    );
  });

  it('does not read the bare credentialed weather URL anywhere', () => {
    // The bare URL is `no-store` by design. Any fetch of it from the client is
    // a permanent origin miss, which is exactly the regression above.
    const bareFetch = /toApiUrl\(\s*['"`]\/api\/bootstrap\?keys=weatherAlerts['"`]\s*\)/;
    assert.doesNotMatch(
      weatherSrc, bareFetch,
      'src/services/weather.ts must not fetch the unmarked weather URL',
    );
  });

  it('the key it requests is a registered bootstrap cache key', () => {
    // If the name ever drifts from the registry, the handler's registry filter
    // yields {} and the response is a structurally-valid `{data:{}, missing:[]}`
    // 200 — no error anywhere, the layer just silently renders nothing.
    assert.equal(PUBLIC_WEATHER_BOOTSTRAP_KEY, 'weatherAlerts');
    assert.ok(
      Object.hasOwn(BOOTSTRAP_CACHE_KEYS, PUBLIC_WEATHER_BOOTSTRAP_KEY),
      `${PUBLIC_WEATHER_BOOTSTRAP_KEY} must be a registered bootstrap cache key`,
    );
    // The URL the client builds must carry that same registered name.
    assert.ok(
      weatherSrc.includes(`keys=${PUBLIC_WEATHER_BOOTSTRAP_KEY}&public=1`),
      'the client URL must use the registered key name',
    );
  });

  it('stays out of the on-demand tier, which would silently steal its cache profile', () => {
    assert.equal(
      BOOTSTRAP_TIERS[PUBLIC_WEATHER_BOOTSTRAP_KEY], 'fast',
      `${PUBLIC_WEATHER_BOOTSTRAP_KEY} must stay a fast-tier key; moving it to on-demand changes `
      + 'which predicate claims its public URL and therefore its CDN TTL',
    );
  });
});
