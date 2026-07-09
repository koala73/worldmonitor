import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initDebugBearRum,
  resetDebugBearRumForTesting,
  shouldEnableDebugBearRum,
} from '../src/bootstrap/debugbear-rum.ts';
import {
  initDebugBearRum as initMarketingDebugBearRum,
  resetDebugBearRumForTesting as resetMarketingDebugBearRumForTesting,
  shouldEnableDebugBearRum as shouldEnableMarketingDebugBearRum,
} from '../pro-test/src/debugbear-rum.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf8');
}

function collectReachableProAssets(entryAsset: string): Set<string> {
  const reachable = new Set<string>();
  const queue = [entryAsset];

  while (queue.length > 0) {
    const asset = queue.shift()!;
    if (reachable.has(asset)) continue;
    reachable.add(asset);

    const source = read(`public/pro/${asset}`);
    for (const match of source.matchAll(/(?:from|import)\(\s*["']\.\/([^"']+\.js)["']\s*\)|from\s*["']\.\/([^"']+\.js)["']/g)) {
      const specifier = match[1] ?? match[2];
      if (specifier) queue.push(`assets/${specifier}`);
    }
  }

  return reachable;
}

function proPageModuleEntries(htmlRelPath: string): string[] {
  return [...read(htmlRelPath).matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/pro\/([^"']+\.js)["'][^>]*>/g)]
    .map((match) => match[1]);
}

interface FakeDebugBearScript {
  async: boolean;
  src: string;
  fetchPriority?: string;
}

function installDebugBearHarness(hostname: string, existingScript: FakeDebugBearScript | null = null): {
  appendedScripts: FakeDebugBearScript[];
  listeners: Map<string, (event: Event) => void>;
  win: Window & { dbbRum?: unknown[] };
  restore: () => void;
} {
  const appendedScripts: FakeDebugBearScript[] = [];
  const listeners = new Map<string, (event: Event) => void>();
  const win = {
    location: { hostname },
    addEventListener: (type: string, cb: (event: Event) => void) => {
      listeners.set(type, cb);
    },
  } as Window & { dbbRum?: unknown[] };
  const doc = {
    querySelector: () => existingScript,
    createElement: (tag: string) => {
      assert.equal(tag, 'script');
      return { async: false, src: '', fetchPriority: 'auto' } satisfies FakeDebugBearScript;
    },
    head: {
      appendChild: (script: FakeDebugBearScript) => {
        appendedScripts.push(script);
        return script;
      },
    },
  };

  const saved: Record<string, PropertyDescriptor | undefined> = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });

  return {
    appendedScripts,
    listeners,
    win,
    restore: () => {
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      resetDebugBearRumForTesting();
    },
  };
}

describe('DebugBear RUM loader', () => {
  it('enables only first-party production dashboard hosts', () => {
    assert.equal(shouldEnableDebugBearRum('www.worldmonitor.app'), true);
    assert.equal(shouldEnableDebugBearRum('happy.worldmonitor.app'), true);
    assert.equal(shouldEnableDebugBearRum('localhost'), false);
    assert.equal(shouldEnableDebugBearRum('worldmonitor-git-codex-preview-eliewm.vercel.app'), false);
    assert.equal(shouldEnableDebugBearRum('evilworldmonitor.app'), false);
  });

  it('installs DebugBear RUM with presampling and pre-script error buffering', () => {
    const h = installDebugBearHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();

      assert.equal(h.appendedScripts.length, 1);
      assert.equal(h.appendedScripts[0]!.async, true);
      assert.equal(h.appendedScripts[0]!.src, 'https://cdn.debugbear.com/lpMwA9KpC6pf.js');
      assert.equal(h.appendedScripts[0]!.fetchPriority, 'low');
      assert.deepEqual(h.win.dbbRum?.[0], ['presampling', 100]);
      assert.ok(h.listeners.has('error'), 'window error listener missing');
      assert.ok(h.listeners.has('unhandledrejection'), 'window unhandledrejection listener missing');

      const errorEvent = { type: 'error' } as Event;
      const rejectionEvent = { type: 'unhandledrejection' } as Event;
      h.listeners.get('error')!(errorEvent);
      h.listeners.get('unhandledrejection')!(rejectionEvent);
      assert.deepEqual(h.win.dbbRum, [
        ['presampling', 100],
        ['error', errorEvent],
        ['unhandledrejection', rejectionEvent],
      ]);
    } finally {
      h.restore();
    }
  });

  it('does not load on local/dev hosts', () => {
    const h = installDebugBearHarness('localhost');
    try {
      initDebugBearRum();

      assert.equal(h.appendedScripts.length, 0);
      assert.equal(h.win.dbbRum, undefined);
      assert.equal(h.listeners.size, 0);
    } finally {
      h.restore();
    }
  });

  it('does not append a duplicate script when one already exists', () => {
    const existing = { async: true, src: 'https://cdn.debugbear.com/lpMwA9KpC6pf.js' };
    const h = installDebugBearHarness('worldmonitor.app', existing);
    try {
      initDebugBearRum();

      assert.equal(h.appendedScripts.length, 0);
      assert.deepEqual(h.win.dbbRum?.[0], ['presampling', 100]);
    } finally {
      h.restore();
    }
  });
});

describe('DebugBear RUM marketing loader', () => {
  it('uses the same production-host gate as the dashboard loader', () => {
    for (const host of [
      'worldmonitor.app',
      'www.worldmonitor.app',
      'tech.worldmonitor.app',
      'finance.worldmonitor.app',
      'commodity.worldmonitor.app',
      'happy.worldmonitor.app',
      'energy.worldmonitor.app',
      'localhost',
      'worldmonitor-git-codex-preview-eliewm.vercel.app',
      'evilworldmonitor.app',
    ]) {
      assert.equal(
        shouldEnableMarketingDebugBearRum(host),
        shouldEnableDebugBearRum(host),
        `marketing DebugBear host gate drifted for ${host}`,
      );
    }
  });

  it('installs DebugBear RUM on marketing pages', () => {
    const h = installDebugBearHarness('www.worldmonitor.app');
    try {
      initMarketingDebugBearRum();

      assert.equal(h.appendedScripts.length, 1);
      assert.equal(h.appendedScripts[0]!.async, true);
      assert.equal(h.appendedScripts[0]!.src, 'https://cdn.debugbear.com/lpMwA9KpC6pf.js');
      assert.equal(h.appendedScripts[0]!.fetchPriority, 'low');
      assert.deepEqual(h.win.dbbRum?.[0], ['presampling', 100]);
      assert.ok(h.listeners.has('error'), 'window error listener missing');
      assert.ok(h.listeners.has('unhandledrejection'), 'window unhandledrejection listener missing');
    } finally {
      h.restore();
      resetMarketingDebugBearRumForTesting();
    }
  });
});

describe('DebugBear RUM marketing build output', () => {
  it('/pro and root welcome can reach the DebugBear loader in committed assets', () => {
    for (const page of ['public/pro/index.html', 'public/pro/welcome.html']) {
      const entries = proPageModuleEntries(page);
      assert.ok(entries.length > 0, `${page}: no module entry found`);
      const reachableAssets = new Set(entries.flatMap((entry) => [...collectReachableProAssets(entry)]));
      assert.ok(
        [...reachableAssets].some((asset) => read(`public/pro/${asset}`).includes('cdn.debugbear.com')),
        `${page}: generated entry graph does not contain DebugBear RUM`,
      );
    }
  });
});
