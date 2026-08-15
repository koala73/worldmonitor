import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './_lib/built-output-guard.mjs';

/**
 * Load-bearing guard for the DebugBear trampoline gate in
 * `src/bootstrap/sentry-init.ts` (WORLDMONITOR-VC / VQ / Y4 / Z6 / ZG).
 *
 * That gate suppresses a bare `Failed to fetch` when every non-infra frame is
 * either the DebugBear RUM collector or one of the `panel-storage` /
 * `widget-store` chunks. Its entire safety argument is that those chunks never
 * issue a fetch of their own — they only appear because Vite emits
 * `window.fetch` trampolines into them, so a stack confined to them cannot be a
 * real first-party network failure.
 *
 * The check runs at TWO levels, because the gate and the source tree do not name
 * the same thing (#6746):
 *
 *   1. Per SOURCE MODULE — the authored file must stay fetch-free.
 *   2. Per BUILT CHUNK — the artifact the gate's regex actually matches.
 *
 * Level 2 exists because level 1 does not imply it. The gate keys on chunk names
 * and Rollup shared chunks are many-modules-to-one-chunk: the same build that
 * emits `widget-store-*.js` also puts `src/services/wm-session.ts` in it, and
 * puts `src/services/runtime.ts` — the app's fetch interceptor, which every API
 * request passes through — in `analytics-*.js`. Nothing pins which chunk a
 * module lands in. A repartition that moves a fetching module into an
 * allowlisted chunk makes the gate hide real `api.worldmonitor.app` outages
 * while every level-1 assertion stays green — the green-on-red shape documented
 * in
 * `docs/solutions/best-practices/checks-must-fail-closed-when-they-lose-their-target.md`.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');
const assetsDir = resolve(distDir, 'assets');
const dashboardHtml = resolve(distDir, 'dashboard.html');

/**
 * Chunk name (as the gate's regex spells it) paired with the source module it is
 * named after, so the two levels cannot drift apart.
 *
 * Deliberately hardcoded rather than parsed out of `sentry-init.ts`: a guard that
 * derives its expectations from the file under test only ever agrees with itself.
 * The coupling to the gate is asserted separately, at the bottom.
 */
const TRAMPOLINE_CHUNKS = [
  { chunk: 'panel-storage', source: '../src/utils/panel-storage.ts' },
  { chunk: 'widget-store', source: '../src/services/widget-store.ts' },
];

/**
 * Chunks the gate still matches that the build no longer emits.
 *
 * `panel-storage` stopped being its own chunk when Rollup folded that module
 * into `font-settings-*.js` and `analytics-*.js`. The gate arm is kept because it
 * still covers browsers running a bundle cached from before that repartition
 * (WORLDMONITOR-VC), but no current artifact can prove it caller-free.
 *
 * This list is what keeps that honest. An absent chunk NOT listed here fails —
 * so a chunk silently vanishing is loud — while a listed one is a recorded,
 * reviewable gap rather than an invisible one. Entries are expected to be
 * removed, not accumulated: when the cached bundles age out, drop the arm from
 * the gate and the entry from here.
 */
const KNOWN_ABSENT_CHUNKS = new Set(['panel-storage']);

/**
 * `fetch(`, `window.fetch`, `globalThis.fetch`, plus the other ways a module can
 * reach the network behind the same trampoline frame.
 *
 * Shared by both levels so the authored-source check and the built-chunk check
 * can never disagree about what "issues a network call" means.
 *
 * Limit worth naming: this matches the GLOBAL fetch vocabulary. A call through a
 * captured alias (`const f = window.fetch; f(url)`) survives minification as a
 * renamed local and is invisible here — as it already is at level 1. The pattern
 * is a floor, not a proof of absence.
 */
const NETWORK_CALL_PATTERN =
  /(?:^|[^\w.])(?:(?:window|globalThis|self)\.)?fetch\s*\(|\bnew\s+(?:XMLHttpRequest|EventSource|WebSocket)\b|\bnavigator\.sendBeacon\s*\(/;

/** Strips line and block comments so a `fetch` in prose doesn't fail the test. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function findChunkFiles(name) {
  const pattern = new RegExp(`^${name}-[A-Za-z0-9_-]+\\.js$`);
  return readdirSync(assetsDir).filter(file => pattern.test(file));
}

describe('DebugBear trampoline chunks stay fetch-free', () => {
  for (const { chunk, source: relativePath } of TRAMPOLINE_CHUNKS) {
    it(`${relativePath} issues no network call`, () => {
      const source = stripComments(
        readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
      );

      const networkCall = source.match(NETWORK_CALL_PATTERN);

      assert.equal(
        networkCall,
        null,
        `${relativePath} now issues a network call (${networkCall?.[0]?.trim()}). ` +
          'The DebugBear trampoline gate in src/bootstrap/sentry-init.ts suppresses ' +
          '"Failed to fetch" whenever the whole stack is confined to this chunk plus ' +
          'the collector, on the assumption that this module never fetches. Either ' +
          'revert the network call or narrow that gate — as written it will now hide ' +
          'real first-party fetch failures.',
      );
    });

    // Dist-gated: skips when dist/dashboard.html is absent, and FAILS instead of
    // skipping when WM_EXPECT_BUILT_OUTPUT=1 (CI sets it right after building the
    // dashboard — .github/workflows/test.yml), so the built half can never go
    // quietly missing in CI.
    it(`the built ${chunk} chunk issues no network call`, () => {
      guardBuiltOutput(dashboardHtml);
      if (shouldSkipBuiltOutput(dashboardHtml)) return;

      const files = findChunkFiles(chunk);
      if (files.length === 0) {
        assert.ok(
          KNOWN_ABSENT_CHUNKS.has(chunk),
          `No dist/assets/${chunk}-<hash>.js chunk in the build, but the DebugBear ` +
            'trampoline gate in src/bootstrap/sentry-init.ts still suppresses ' +
            `"Failed to fetch" for frames attributed to a "${chunk}" chunk. Rollup ` +
            'repartitioned and this arm can no longer be verified against any ' +
            'artifact. Either drop the arm from the gate, or — if it is deliberately ' +
            'kept for bundles cached before the repartition — add it to ' +
            'KNOWN_ABSENT_CHUNKS with the reason, so the gap is recorded instead of ' +
            'silently trusted.',
        );
        return;
      }

      for (const file of files) {
        const built = readFileSync(resolve(assetsDir, file), 'utf8');
        const networkCall = built.match(NETWORK_CALL_PATTERN);

        assert.equal(
          networkCall,
          null,
          `dist/assets/${file} contains a network call (${networkCall?.[0]?.trim()}). ` +
            'Rollup put a fetching module in a chunk the DebugBear trampoline gate ' +
            'treats as caller-free, so that gate will now suppress a real first-party ' +
            '"Failed to fetch" — an api.worldmonitor.app outage would go unreported ' +
            'for every session running the DebugBear RUM script. Either split the ' +
            `fetching module out of the ${chunk} chunk (vite.config.ts manualChunks) ` +
            'or drop this chunk from the gate in src/bootstrap/sentry-init.ts.',
        );
      }
    });
  }

  // The known-absent escape hatch must never swallow the whole allowlist: if
  // every arm were declared absent, the gate would be suppressing entirely on
  // unverifiable chunk names and this file would be green while checking nothing.
  it('at least one gated chunk is still verified against a real artifact', () => {
    guardBuiltOutput(dashboardHtml);
    if (shouldSkipBuiltOutput(dashboardHtml)) return;

    const verified = TRAMPOLINE_CHUNKS.filter(({ chunk }) => findChunkFiles(chunk).length > 0);
    assert.ok(
      verified.length > 0,
      'Every chunk the DebugBear trampoline gate names is missing from the build, so ' +
        'nothing about that gate is being checked. Re-derive the allowlist from the ' +
        'chunks the build actually emits before trusting the suppression again.',
    );
  });

  it('the gate it protects still keys on these chunk names', () => {
    const sentryInit = readFileSync(
      new URL('../src/bootstrap/sentry-init.ts', import.meta.url),
      'utf8',
    );
    assert.match(
      sentryInit,
      /isTrampolineFrameFunction[\s\S]{0,600}panel-storage\|widget-store/,
      'sentry-init.ts must still gate on the panel-storage/widget-store chunks — ' +
        'if that gate was renamed or removed, update this guard to match rather ' +
        'than leaving it asserting a relationship that no longer exists.',
    );
  });
});
