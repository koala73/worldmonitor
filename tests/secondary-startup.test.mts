import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDashboardFontStylesheetHref } from '../src/bootstrap/secondary-startup.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const activeMarkup = indexHtml.replace(/<!--[\s\S]*?-->/g, '');

describe('secondary dashboard startup', () => {
  it('keeps analytics, auth, Sentry, and font fetches out of index.html startup tags', () => {
    assert.equal(
      /<script\b[^>]+src=["']https:\/\/abacus\.worldmonitor\.app\/script\.js["']/i.test(activeMarkup),
      false,
      'Umami must be injected by the deferred dashboard loader, not index.html',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/o4509927897890816\.ingest\.us\.sentry\.io["']/i.test(activeMarkup),
      false,
      'Sentry ingest preconnect must not compete with initial dashboard paint',
    );
    assert.equal(
      /<link\b[^>]+rel=["']dns-prefetch["'][^>]+href=["']https:\/\/clerk\.worldmonitor\.app["']/i.test(activeMarkup),
      false,
      'Clerk dns-prefetch must not run before the deferred Clerk loader',
    );
    assert.equal(
      /<link\b[^>]+href=["']https:\/\/fonts\.googleapis\.com\/css2\?/i.test(activeMarkup),
      false,
      'Google Fonts stylesheet must not be an eager head request',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com["']/i.test(activeMarkup),
      false,
      'Google Fonts preconnects must be deferred with the narrowed font request',
    );
  });

  it('retains CSP permission for the deferred loaders', () => {
    assert.match(indexHtml, /script-src[^;]*https:\/\/abacus\.worldmonitor\.app/);
    assert.match(indexHtml, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(indexHtml, /font-src[^;]*https:/);
  });

  it('does not request dashboard fonts for the default English dashboard', () => {
    assert.equal(
      buildDashboardFontStylesheetHref({ variant: 'full', lang: 'en', dir: '' }),
      null,
    );
  });

  it('narrows happy dashboard fonts to the weights the UI uses', () => {
    const href = buildDashboardFontStylesheetHref({ variant: 'happy', lang: 'en', dir: '' });
    assert.equal(href, 'https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,400;0,600;0,700;1,400&display=swap');
    assert.equal(href?.includes('300'), false);
    assert.equal(href?.includes('ital'), true);
  });

  it('narrows Arabic dashboard fonts without loading happy fonts by default', () => {
    const href = buildDashboardFontStylesheetHref({ variant: 'full', lang: 'ar', dir: 'rtl' });
    assert.equal(href, 'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap');
    assert.equal(href?.includes('Nunito'), false);
    assert.equal(href?.includes('200'), false);
    assert.equal(href?.includes('800'), false);
    assert.equal(href?.includes('900'), false);
  });

  it('combines only the needed families for the Arabic happy dashboard', () => {
    assert.equal(
      buildDashboardFontStylesheetHref({ variant: 'happy', lang: 'ar', dir: 'rtl' }),
      'https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,400;0,600;0,700;1,400&family=Tajawal:wght@400;500;700&display=swap',
    );
  });
});

describe('deferred Umami loader', () => {
  it('queues dashboard analytics calls and flushes them after the deferred script loads', async () => {
    const appendedScripts: Array<{
      async: boolean;
      src: string;
      dataset: Record<string, string>;
      removed: boolean;
      listeners: Map<string, () => void>;
      addEventListener: (type: string, cb: () => void) => void;
      remove: () => void;
    }> = [];
    const calls: Array<{ kind: string; name?: string; data: Record<string, unknown> | undefined }> = [];

    const makeFakeScript = () => {
      const script = {
        async: false,
        src: '',
        dataset: {} as Record<string, string>,
        removed: false,
        listeners: new Map<string, () => void>(),
        addEventListener: (type: string, cb: () => void) => {
          script.listeners.set(type, cb);
        },
        remove: () => {
          script.removed = true;
        },
      };
      return script;
    };
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      requestIdleCallback: (cb: () => void) => {
        cb();
        return 1;
      },
    };
    const fakeDocument = {
      readyState: 'complete',
      querySelector: () => null,
      createElement: (tag: string) => {
        assert.equal(tag, 'script');
        return makeFakeScript();
      },
      head: {
        appendChild: (script: (typeof appendedScripts)[number]) => {
          appendedScripts.push(script);
          return script;
        },
      },
    };
    const originalSetTimeout = globalThis.setTimeout;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: fakeDocument,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void) => {
        cb();
        return 1;
      },
    });

    try {
      const analytics = await import('../src/services/analytics.ts');
      analytics.track('search-open', { source: 'desktop' });
      analytics.identifyUser('user_1', 'free', null, null);
      await analytics.initAnalytics();

      assert.equal(appendedScripts.length, 1);
      const firstScript = appendedScripts[0]!;
      assert.equal(firstScript.async, true);
      assert.equal(firstScript.src, 'https://abacus.worldmonitor.app/script.js');
      assert.equal(firstScript.dataset.websiteId, 'e8800335-c853-46a8-8497-c993ed2f58bc');
      assert.equal(firstScript.dataset.domains, 'worldmonitor.app,happy.worldmonitor.app');
      assert.deepEqual(calls, []);
      firstScript.listeners.get('error')?.();
      assert.equal(firstScript.removed, true);
      assert.equal(appendedScripts.length, 2, 'failed Umami script load should schedule one retry');

      Object.defineProperty(fakeWindow, 'umami', {
        configurable: true,
        value: {
          track: (name: string, data?: Record<string, unknown>) => calls.push({ kind: 'track', name, data }),
          identify: (data: Record<string, unknown>) => calls.push({ kind: 'identify', data }),
        },
      });
      appendedScripts[1]!.listeners.get('load')?.();

      assert.deepEqual(calls, [
        { kind: 'track', name: 'search-open', data: { source: 'desktop' } },
        { kind: 'identify', data: { userId: 'user_1', plan: 'free' } },
      ]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { document?: unknown }).document;
      delete (globalThis as { localStorage?: unknown }).localStorage;
      Object.defineProperty(globalThis, 'setTimeout', {
        configurable: true,
        value: originalSetTimeout,
      });
    }
  });
});
