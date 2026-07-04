import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dashboardFontFamilies } from '../src/bootstrap/secondary-startup.ts';
import { scheduleAfterFirstPaint } from '../src/utils/after-paint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const dashboardCsp = vercelConfig.headers
  .find((entry: { source: string }) => entry.source === '/((?!docs|embed|embed\\.html).*)')
  ?.headers
  ?.find((header: { key: string }) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
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

  it('keeps secondary startup script hosts out of the dashboard script-src allowlist', () => {
    const scriptSrc = dashboardCsp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.match(scriptSrc, /'strict-dynamic'/);
    assert.doesNotMatch(scriptSrc, /https:\/\/abacus\.worldmonitor\.app/);
    assert.doesNotMatch(scriptSrc, /https:\/\/static\.cloudflareinsights\.com/);
    assert.doesNotMatch(dashboardCsp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(dashboardCsp, /font-src[^;]*'self'/);
    assert.doesNotMatch(dashboardCsp, /font-src[^;]*https:/);
  });

  it('does not load any web font for the default English dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'en', dir: '' }), []);
  });

  it('loads only Nunito for the happy dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'happy', lang: 'en', dir: '' }), ['nunito']);
  });

  it('loads only Tajawal for the Arabic dashboard, not happy fonts', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'ar', dir: 'rtl' }), ['tajawal']);
  });

  it('combines Nunito + Tajawal for the Arabic happy dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'happy', lang: 'ar', dir: 'rtl' }), ['nunito', 'tajawal']);
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

interface FakeUmamiScript {
  async: boolean;
  src: string;
  dataset: Record<string, string>;
  removed: boolean;
  listeners: Map<string, () => void>;
  addEventListener: (type: string, cb: () => void) => void;
  remove: () => void;
}

function makeFakeScript(): FakeUmamiScript {
  const script: FakeUmamiScript = {
    async: false,
    src: '',
    dataset: {},
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
}

type FakeUmami = {
  track: (name: string, data?: Record<string, unknown>) => void;
  identify: (data: Record<string, unknown>) => void;
};

/**
 * Installs the synchronous fake window/document/setTimeout harness the deferred
 * Umami loader needs (requestAnimationFrame + requestIdleCallback + setTimeout
 * all run their callback inline so scheduleAfterFirstPaint resolves in one tick).
 */
function installUmamiHarness(opts: { existingScript?: FakeUmamiScript } = {}): {
  appendedScripts: FakeUmamiScript[];
  setUmami: (umami: FakeUmami) => void;
  restore: () => void;
} {
  const appendedScripts: FakeUmamiScript[] = [];
  const fakeWindow: Record<string, unknown> = {
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
    querySelector: () => opts.existingScript ?? null,
    createElement: (tag: string) => {
      assert.equal(tag, 'script');
      return makeFakeScript();
    },
    head: {
      appendChild: (script: FakeUmamiScript) => {
        appendedScripts.push(script);
        return script;
      },
    },
  };
  const saved: Record<string, PropertyDescriptor | undefined> = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, 'setTimeout'),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
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
  return {
    appendedScripts,
    setUmami: (umami: FakeUmami) => {
      fakeWindow.umami = umami;
    },
    restore: () => {
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

describe('scheduleAfterFirstPaint', () => {
  it('runs the task via the load-event listener when readyState is not complete', () => {
    const loadHandlers: Array<() => void> = [];
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      requestIdleCallback: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'load') loadHandlers.push(cb);
      },
    };
    const fakeDocument = { readyState: 'loading' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 0, 'task must not run before the load event fires');
      assert.equal(loadHandlers.length, 1, 'a load listener must be registered');
      loadHandlers[0]!();
      assert.equal(ran, 1, 'task runs exactly once after load -> rAF -> idle');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('falls back to setTimeout when requestIdleCallback is absent', () => {
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: () => {},
    };
    const fakeDocument = { readyState: 'complete' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const savedSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void) => {
        cb();
        return 1;
      },
    });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 1, 'task runs via the setTimeout fallback when rIC is missing');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (savedSetTimeout) Object.defineProperty(globalThis, 'setTimeout', savedSetTimeout);
    }
  });
});

describe('deferred Umami loader — failure and edge paths', () => {
  it('stops after the attempt limit and appends no third script on exhaustion', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installUmamiHarness();
    try {
      analytics.track('search-open', { source: 'x' });
      analytics.initAnalytics();
      assert.equal(h.appendedScripts.length, 1, 'first load attempt appends one script');
      h.appendedScripts[0]!.listeners.get('error')?.();
      assert.equal(h.appendedScripts.length, 2, 'first failure schedules exactly one retry');
      h.appendedScripts[1]!.listeners.get('error')?.();
      assert.equal(h.appendedScripts.length, 2, 'no third attempt past UMAMI_LOAD_ATTEMPT_LIMIT');
    } finally {
      h.restore();
    }
  });

  it('caps the pre-load queue at 50 and evicts the oldest call', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installUmamiHarness();
    const delivered: Array<Record<string, unknown> | undefined> = [];
    try {
      for (let i = 0; i < 51; i++) analytics.track('search-open', { i });
      h.setUmami({
        track: (_name: string, data?: Record<string, unknown>) => delivered.push(data),
        identify: () => {},
      });
      analytics.initAnalytics();
      h.appendedScripts[0]!.listeners.get('load')?.();
      assert.equal(delivered.length, 50, 'queue caps at 50 and flushes 50');
      assert.deepEqual(delivered[0], { i: 1 }, 'the oldest call (i:0) was evicted');
      assert.deepEqual(delivered[49], { i: 50 });
    } finally {
      h.restore();
    }
  });

  it('queues a call when window.umami.track throws, then delivers it on flush', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installUmamiHarness();
    const delivered: string[] = [];
    let throwOnce = true;
    try {
      h.setUmami({
        track: (name: string) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('umami boom');
          }
          delivered.push(name);
        },
        identify: () => {},
      });
      analytics.track('search-open');
      assert.deepEqual(delivered, [], 'a throwing track() is not delivered — it is queued');
      analytics.initAnalytics();
      h.appendedScripts[0]!.listeners.get('load')?.();
      assert.deepEqual(delivered, ['search-open'], 'the queued call is delivered on flush');
    } finally {
      h.restore();
    }
  });

  it('attaches to an existing umami script without injecting a duplicate', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const existing = makeFakeScript();
    const h = installUmamiHarness({ existingScript: existing });
    const delivered: string[] = [];
    try {
      analytics.track('search-open');
      analytics.initAnalytics();
      assert.equal(h.appendedScripts.length, 0, 'no duplicate script is injected when one already exists');
      assert.ok(existing.listeners.get('load'), 'a load listener is attached to the existing script');
      h.setUmami({
        track: (name: string) => delivered.push(name),
        identify: () => {},
      });
      existing.listeners.get('load')!();
      assert.deepEqual(delivered, ['search-open'], 'queued events flush via the existing script load');
    } finally {
      h.restore();
    }
  });
});
