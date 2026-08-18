import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const prepushMaxWorkers = optionalPositiveInteger('VITEST_MAX_THREADS');

/**
 * DOM-behavioral test project (#5634).
 *
 * Deliberately SEPARATE from the `tsx --test` unit profile (`npm run
 * test:data`) for two reasons:
 *
 *   1. Gate components import `@/services/i18n`, which uses `import.meta.glob`
 *      to split the locale dictionaries. tsx cannot transform that — only a
 *      Vite pipeline can — so these files are unreachable from the node:test
 *      runner no matter how the DOM globals are registered.
 *   2. `test:data` already runs ~390 files in one tsx process and OOMs at the
 *      tail in a worktree. Adding a DOM environment to that glob would make it
 *      worse; a separate runner keeps the blast radius at these files only.
 *
 * happy-dom over jsdom: 6 transitive packages instead of ~30, and it boots per
 * file fast enough that the extra CI job stays under a few seconds.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    // Local pre-push exports this cap so several worktrees cannot each fan out
    // to every core. CI leaves it unset and retains Vitest's full-width default.
    ...(prepushMaxWorkers === undefined ? {} : { maxWorkers: prepushMaxWorkers }),
    // Both extensions on purpose: `tests/` is 573 `.test.mjs` to 416
    // `.test.mts`, so an `.mts`-only glob would silently never run a file a
    // contributor named after the repo's more common convention — the exact
    // never-reported-test failure this directory exists to prevent.
    include: ['tests/dom/**/*.test.{mts,mjs}'],
    // Every test file installs its own listeners on a shared `document`;
    // isolate so a leaked listener cannot reach across files.
    isolate: true,
    // Single mechanism for spy cleanup — test files must NOT also call
    // vi.restoreAllMocks() or the two can drift.
    restoreMocks: true,
  },
});
