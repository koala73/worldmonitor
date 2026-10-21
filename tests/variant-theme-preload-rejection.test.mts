import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * WORLDMONITOR-XT — `Error: Unable to preload CSS for /assets/happy-theme-DInLuQYM.css`,
 * onunhandledrejection, error level, 2026-07-28.
 *
 * `main.ts` loaded the happy variant stylesheet with a bare
 * `void import('./styles/happy-theme.css')`. Vite's preload helper rejects that
 * promise when the injected `<link rel="stylesheet">` fires `error`, and `void`
 * discards the promise rather than handling it — so the rejection escaped to
 * `onunhandledrejection`. These tests pin the contract that the variant theme
 * loader consumes its own rejection: the failure is reported, and nothing ever
 * reaches the process-level unhandled-rejection handler.
 */

const REJECTION = new Error('Unable to preload CSS for /assets/happy-theme-DInLuQYM.css');

const { loadVariantThemeStylesheet } = await import('../src/bootstrap/variant-theme.ts');

const leaked: unknown[] = [];
const captureLeak = (reason: unknown): void => {
  leaked.push(reason);
};

/**
 * Node emits `unhandledRejection` at the end of the turn in which the rejected
 * promise was left unhandled, so a macrotask hop is required before asserting.
 */
function flushRejectionQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('loadVariantThemeStylesheet', () => {
  beforeEach(() => {
    leaked.length = 0;
    process.on('unhandledRejection', captureLeak);
  });

  afterEach(() => {
    process.off('unhandledRejection', captureLeak);
  });

  it('never leaks an unhandled rejection when the stylesheet fails to preload', async () => {
    const reported: Array<[string, unknown]> = [];

    await loadVariantThemeStylesheet('happy', () => Promise.reject(REJECTION), (variant, error) => {
      reported.push([variant, error]);
    });
    await flushRejectionQueue();

    assert.deepEqual(
      leaked,
      [],
      'the CSS preload rejection reached process unhandledRejection — this is exactly WORLDMONITOR-XT',
    );
    assert.deepEqual(reported, [['happy', REJECTION]], 'the failure must be reported exactly once');
  });

  it('handles an importer that throws synchronously', async () => {
    const reported: Array<[string, unknown]> = [];

    await loadVariantThemeStylesheet('happy', () => {
      throw REJECTION;
    }, (variant, error) => {
      reported.push([variant, error]);
    });
    await flushRejectionQueue();

    assert.deepEqual(leaked, []);
    assert.deepEqual(reported, [['happy', REJECTION]]);
  });

  it('does not resurrect the leak when the reporter itself throws', async () => {
    await loadVariantThemeStylesheet('happy', () => Promise.reject(REJECTION), () => {
      throw new Error('sentry queue blew up');
    });
    await flushRejectionQueue();

    assert.deepEqual(leaked, [], 'a throwing reporter must not re-reject the loader promise');
  });

  it('reports nothing when the stylesheet loads', async () => {
    const reported: Array<[string, unknown]> = [];

    await loadVariantThemeStylesheet('happy', () => Promise.resolve({}), (variant, error) => {
      reported.push([variant, error]);
    });
    await flushRejectionQueue();

    assert.deepEqual(leaked, []);
    assert.deepEqual(reported, []);
  });
});

describe('main.ts variant stylesheet call site', () => {
  const mainSource = readFileSync(
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    'utf8',
  );

  it('routes the variant stylesheet through the guarded loader', () => {
    assert.match(
      mainSource,
      /loadVariantThemeStylesheet\(\s*'happy',\s*\(\)\s*=>\s*import\('\.\/styles\/happy-theme\.css'\)\s*\)/,
      'main.ts must load the happy theme through loadVariantThemeStylesheet',
    );
  });

  it('has no bare fire-and-forget variant stylesheet import left', () => {
    const bareThemeImports = mainSource.match(/void import\(['"]\.\/styles\/[\w-]+\.css['"]\)/g) ?? [];
    assert.deepEqual(
      bareThemeImports,
      [],
      'a bare `void import(<theme>.css)` discards the preload rejection — route it through loadVariantThemeStylesheet',
    );
  });
});
