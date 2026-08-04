import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Load-bearing guard for the DebugBear trampoline gate in
 * `src/bootstrap/sentry-init.ts` (WORLDMONITOR-VC / VQ / Y4).
 *
 * That gate suppresses a bare `Failed to fetch` when every non-infra frame is
 * either the DebugBear RUM collector or one of the `panel-storage` /
 * `widget-store` chunks. Its entire safety argument is that those two chunks
 * never issue a fetch of their own — they only appear because Vite emits
 * `window.fetch` trampolines into them, so a stack confined to them cannot be a
 * real first-party network failure.
 *
 * If either module ever gains a fetch call, that argument collapses and the
 * gate starts swallowing genuine outages. This test is what makes that
 * impossible to do silently.
 */
const TRAMPOLINE_CHUNK_SOURCES = [
  '../src/utils/panel-storage.ts',
  '../src/services/widget-store.ts',
];

/** Strips line and block comments so a `fetch` in prose doesn't fail the test. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('DebugBear trampoline chunks stay fetch-free', () => {
  for (const relativePath of TRAMPOLINE_CHUNK_SOURCES) {
    it(`${relativePath} issues no network call`, () => {
      const source = stripComments(
        readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
      );

      // `fetch(`, `.fetch(`, `window.fetch`, `globalThis.fetch`, plus the other
      // ways a module can reach the network behind the same trampoline frame.
      const networkCall = source.match(
        /(?:^|[^\w.])(?:(?:window|globalThis|self)\.)?fetch\s*\(|\bnew\s+(?:XMLHttpRequest|EventSource|WebSocket)\b|\bnavigator\.sendBeacon\s*\(/,
      );

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
  }

  it('the gate it protects still keys on these chunk names', () => {
    const sentryInit = readFileSync(
      new URL('../src/bootstrap/sentry-init.ts', import.meta.url),
      'utf8',
    );
    assert.match(
      sentryInit,
      /isTrampolineFrameFunction[\s\S]{0,400}panel-storage\|widget-store/,
      'sentry-init.ts must still gate on the panel-storage/widget-store chunks — ' +
        'if that gate was renamed or removed, update this guard to match rather ' +
        'than leaving it asserting a relationship that no longer exists.',
    );
  });
});
