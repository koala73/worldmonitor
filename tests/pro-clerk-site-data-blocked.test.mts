import assert from 'node:assert/strict';
import { afterEach, before, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

interface ClerkHarness {
  imported: boolean;
  constructed: number;
  instance: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __proClerkSiteDataHarness: ClerkHarness;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let moduleUrl: string;

before(async () => {
  const stubSources: Record<string, string> = {
    '@clerk/clerk-js': `
      globalThis.__proClerkSiteDataHarness.imported = true;
      export class Clerk {
        constructor() {
          globalThis.__proClerkSiteDataHarness.constructed += 1;
          globalThis.__proClerkSiteDataHarness.instance = this;
        }
        async load() {}
      }
    `,
    './clerk-dom-safety': 'export function protectClerkDomFromTranslators() { return () => {}; }',
  };
  const plugin: Plugin = {
    name: 'pro-clerk-site-data-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) =>
        Object.hasOwn(stubSources, args.path) ? { path: args.path, namespace: 'stub' } : null,
      );
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubSources[args.path], loader: 'js' }));
    },
  };
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: ['pro-test/src/services/clerk.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: { 'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': '"pk_test"' },
    plugins: [plugin],
  });
  moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

async function loadClerkService(localStorage: () => unknown): Promise<{ ensureClerk(): Promise<unknown> }> {
  globalThis.__proClerkSiteDataHarness = { imported: false, constructed: 0, instance: null };
  const window = {};
  Object.defineProperty(window, 'localStorage', { configurable: true, get: localStorage });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  return import(`${moduleUrl}#${Math.random()}`);
}

it('rejects with SiteDataBlockedError and never loads Clerk when the browser blocks site data', async () => {
  const securityError = Object.assign(new Error("Failed to read the 'localStorage' property from 'Window': Access is denied for this document."), { name: 'SecurityError' });
  const { ensureClerk } = await loadClerkService(() => { throw securityError; });

  await assert.rejects(ensureClerk(), (err: Error) => {
    assert.equal(err.name, 'SiteDataBlockedError');
    assert.equal(err.cause, securityError);
    return true;
  });
  assert.equal(globalThis.__proClerkSiteDataHarness.imported, false, 'Clerk must not be downloaded when it cannot work');
  assert.equal(globalThis.__proClerkSiteDataHarness.constructed, 0);
});

it('loads Clerk when localStorage is readable', async () => {
  const { ensureClerk } = await loadClerkService(() => ({}));

  const loaded = await ensureClerk();
  assert.equal(globalThis.__proClerkSiteDataHarness.constructed, 1);
  assert.equal(loaded, globalThis.__proClerkSiteDataHarness.instance);
});
