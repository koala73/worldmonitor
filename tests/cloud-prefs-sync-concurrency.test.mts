import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { build, stop } from 'esbuild';

import { MiniStorage } from './helpers/mini-dom.mts';

const root = resolve(import.meta.dirname, '..');
const stubs: Record<string, string> = {
  '@/services/runtime': 'export const isDesktopRuntime = () => false;',
  '@/services/clerk': 'export const getClerkToken = async () => globalThis.__cloudPrefsToken;',
  '@/config/feeds': [
    "export const CANADA_ARCTIC_OPT_IN_SOURCES = ['Globe and Mail', 'Global News', 'Yle News', 'NRK', 'Aftenposten', 'DR Nyheder', 'Arctic Today'];",
    "export const CANADA_DEPTH_OPT_IN_SOURCES = [];",
    "export const CRISIS_FLOOR_OPT_IN_SOURCES = ['WAFA English'];",
    "export const CURATED_REGIONAL_OPT_IN_SOURCES = ['Guardian Pacific'];",
    'export const FEEDS = {};',
    'export const FRONTLINE_EUROPE_PROTECTED_SOURCES = [];',
    'export const INTEL_SOURCES = [];',
    'export const computeDefaultDisabledSources = () => [];',
    'export const computePreStrategicDefaultDisabledSources = () => [];',
    'export const computeLegacyDefaultDisabledSources = () => [];',
    'export const getStrategicDefaultSources = () => new Set();',
  ].join('\n'),
  '@/config/panels': 'export const FREE_MAX_SOURCES = 80;',
  '@/utils/dom-utils': [
    'export const trustedHtml = (value) => value;',
    'export const setTrustedHtml = (element, value) => { element.innerHTML = value; };',
  ].join('\n'),
  '@/services/source-cap': [
    'export const computeCapDisabledSources = () => [];',
    'export const findFullyDisabledCategories = () => [];',
  ].join('\n'),
  '@/services/regional-feed-rollout': [
    'export const buildPreStrategicDefaultDisabledStates = () => [];',
    'export const buildRegionalFeedRolloutMigrationTargets = () => [];',
  ].join('\n'),
};

interface HarnessResult {
  acceptedDataByToken: Record<string, Record<string, string>>;
  acceptedSchemaVersionsByToken: Record<string, number[]>;
  conflictCount: number;
  localSyncVersion: number;
  localSchemaVersion: number;
  postCount: number;
  serverSyncVersion: number;
  state: string | null;
  stateHistory: string[];
}

interface HeldRequest {
  release: () => void;
  started: Promise<void>;
}

interface HarnessControls {
  dispatchHidden: () => void;
  events: Array<{ detail: unknown; type: string }>;
  failNextGetTemporarily: () => void;
  fireSignInRetry: () => void;
  holdNextGet: () => HeldRequest;
  holdNextPost: () => HeldRequest;
  /** Make the backing store REJECT writes to `key`, as a full disk does. */
  rejectWritesTo: (key: string) => void;
  /** Make the backing store THROW when `key` is read. */
  rejectReadsOf: (key: string) => void;
  seedRow: (token: string, data: Record<string, string>, syncVersion: number, schemaVersion?: number) => void;
  setToken: (token: string) => void;
  stateHistory: string[];
  timeoutNextRequest: () => void;
}

let harnessSequence = 0;
const bundledSourcePromises = new Map<boolean, Promise<string>>();

after(() => {
  stop();
});

async function getBundledSource(enabled = true): Promise<string> {
  let bundledSourcePromise = bundledSourcePromises.get(enabled);
  if (bundledSourcePromise) return bundledSourcePromise;

  bundledSourcePromise = build({
    absWorkingDir: root,
    entryPoints: ['src/utils/cloud-prefs-sync.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    define: {
      'import.meta.env.VITE_CLOUD_PREFS_ENABLED': enabled ? '"true"' : '"false"',
    },
    plugins: [{
      name: 'cloud-prefs-test-stubs',
      setup(buildApi) {
        buildApi.onLoad({ filter: /src\/utils\/cloud-prefs-sync\.ts$/ }, async (args) => ({
          contents: await readFile(args.path, 'utf8'),
          loader: 'ts',
        }));
        buildApi.onResolve({ filter: /^@\// }, (args) => {
          // safe-storage is bundled REAL, not stubbed. It is the accessor every
          // storage call in cloud-prefs-sync now goes through (#7833), so a
          // stub would quietly replace the exact code this harness exists to
          // drive against its fake Storage — including safeStorageSetChecked,
          // whose quota-rejection report the sync-version guard depends on.
          if (args.path === '@/utils/safe-storage') {
            return { path: resolve(root, 'src/utils/safe-storage.ts'), namespace: 'file' };
          }
          if (!(args.path in stubs)) throw new Error(`unexpected alias import: ${args.path}`);
          return { path: args.path, namespace: 'stub' };
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
      },
    }],
  }).then((bundled) => bundled.outputFiles[0]!.text);
  bundledSourcePromises.set(enabled, bundledSourcePromise);
  return bundledSourcePromise;
}

async function loadCloudPrefsModule(enabled = true) {
  const source = await getBundledSource(enabled);
  const encoded = Buffer.from(source).toString('base64');
  harnessSequence += 1;
  return import(`data:text/javascript;base64,${encoded}#harness-${harnessSequence}`);
}

async function runHarness(
  invoke: (
    cloudPrefs: Awaited<ReturnType<typeof loadCloudPrefsModule>>,
    controls: HarnessControls,
  ) => Promise<void>,
  { enabled = true }: { enabled?: boolean } = {},
): Promise<HarnessResult> {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalCloudPrefsToken = Object.getOwnPropertyDescriptor(globalThis, '__cloudPrefsToken');
  const originalAbortSignalTimeout = AbortSignal.timeout;
  const originalFetch = globalThis.fetch;
  const originals = {
    CustomEvent: globalThis.CustomEvent,
    Storage: globalThis.Storage,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  const originalSetTimeout = globalThis.setTimeout;
  const stateHistory: string[] = [];
  const events: Array<{ detail: unknown; type: string }> = [];
  const rejectedWriteKeys = new Set<string>();
  const rejectedReadKeys = new Set<string>();
  class TestStorage extends MiniStorage {
    override getItem(key: string): string | null {
      if (rejectedReadKeys.has(key)) throw new Error('SecurityError');
      return super.getItem(key);
    }

    override setItem(key: string, value: string): void {
      // A full disk rejects the write for a large value while still accepting
      // the small sync-version marker written straight afterwards — the exact
      // asymmetry that let stale prefs overwrite cloud data (#7833 review).
      if (rejectedWriteKeys.has(key)) throw new Error('QuotaExceededError');
      super.setItem(key, value);
      if (key === 'wm-cloud-sync-state') stateHistory.push(value);
    }
  }
  const storage = new TestStorage();
  const documentListeners = new Map<string, Array<() => void>>();
  const windowListeners = new Map<string, Array<() => void>>();
  const documentStub = {
    visibilityState: 'visible',
    addEventListener(type: string, listener: () => void) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    body: {
      appendChild(element: { dismissForTest?: () => void }) {
        element.dismissForTest?.();
      },
    },
    createElement() {
      let clickListener: ((event: unknown) => void) | null = null;
      return {
        addEventListener(type: string, listener: (event: unknown) => void) {
          if (type === 'click') clickListener = listener;
        },
        className: '',
        dismissForTest() {
          clickListener?.({
            target: {
              closest: () => ({ getAttribute: () => 'dismiss' }),
            },
          });
        },
        innerHTML: '',
        remove() {},
      };
    },
    querySelector() {
      return null;
    },
  };

  Object.assign(globalThis, {
    __cloudPrefsToken: 'test-token',
    CustomEvent: class TestCustomEvent {
      detail: unknown;
      type: string;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    Storage: TestStorage,
    document: documentStub,
    localStorage: storage,
    window: {
      addEventListener(type: string, listener: () => void) {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
      },
      dispatchEvent(event: { detail?: unknown; type?: string }) {
        const type = event.type ?? '';
        events.push({ type, detail: event.detail });
        for (const listener of windowListeners.get(type) ?? []) listener();
        return true;
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });

  interface ServerRow {
    data: Record<string, string>;
    schemaVersion: number;
    syncVersion: number;
  }
  const rows = new Map<string, ServerRow>();
  const acceptedSchemaVersionsByToken: Record<string, number[]> = {};
  let postCount = 0;
  let conflictCount = 0;
  let pendingHold: {
    releasePromise: Promise<void>;
    resolveRelease: () => void;
    resolveStarted: () => void;
  } | null = null;
  let timeoutNextRequest = false;
  let failNextGetTemporarily = false;
  let captureSignInRetryTimer = false;
  let pendingSignInRetry: (() => void) | null = null;
  let pendingGetHold: {
    releasePromise: Promise<void>;
    resolveRelease: () => void;
    resolveStarted: () => void;
  } | null = null;

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (captureSignInRetryTimer && (delay ?? 0) >= 1000) {
      captureSignInRetryTimer = false;
      pendingSignInRetry = () => {
        if (typeof callback === 'function') callback(...args);
      };
      return 987_654 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;

  AbortSignal.timeout = ((_delay: number) => {
    const controller = new AbortController();
    if (timeoutNextRequest) {
      timeoutNextRequest = false;
      queueMicrotask(() => {
        controller.abort(new DOMException('cloud prefs request timed out', 'TimeoutError'));
      });
    }
    return controller.signal;
  }) as typeof AbortSignal.timeout;

  globalThis.fetch = async (_input, init = {}) => {
    const method = init.method ?? 'GET';
    const authorization = new Headers(init.headers).get('Authorization') ?? '';
    const token = authorization.replace(/^Bearer\s+/, '') || 'anonymous';
    const row = rows.get(token) ?? { data: {}, schemaVersion: 2, syncVersion: 0 };
    if (method === 'GET') {
      if (failNextGetTemporarily) {
        failNextGetTemporarily = false;
        captureSignInRetryTimer = true;
        return Response.json(
          { error: 'SERVICE_UNAVAILABLE' },
          { status: 503, headers: { 'Retry-After': '1' } },
        );
      }
      const held = pendingGetHold;
      if (held) {
        pendingGetHold = null;
        held.resolveStarted();
        await held.releasePromise;
      }
      return Response.json({
        data: row.data,
        schemaVersion: row.schemaVersion,
        syncVersion: row.syncVersion,
      });
    }

    postCount += 1;
    const body = JSON.parse(String(init.body));

    const held = pendingHold;
    if (held) {
      pendingHold = null;
      held.resolveStarted();
      await held.releasePromise;
    }

    await new Promise<void>((resolveDelay, rejectDelay) => {
      const timer = originalSetTimeout(resolveDelay, 5);
      const signal = init.signal;
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        rejectDelay(signal.reason);
      }, { once: true });
    });

    if (body.expectedSyncVersion !== row.syncVersion) {
      conflictCount += 1;
      return Response.json(
        { error: 'CONFLICT', actualSyncVersion: row.syncVersion },
        { status: 409 },
      );
    }

    const nextRow = {
      data: body.data as Record<string, string>,
      schemaVersion: body.schemaVersion as number,
      syncVersion: row.syncVersion + 1,
    };
    const acceptedVersions = acceptedSchemaVersionsByToken[token] ?? [];
    acceptedVersions.push(nextRow.schemaVersion);
    acceptedSchemaVersionsByToken[token] = acceptedVersions;
    rows.set(token, nextRow);
    return Response.json({ syncVersion: nextRow.syncVersion });
  };

  const controls: HarnessControls = {
    dispatchHidden: () => {
      documentStub.visibilityState = 'hidden';
      for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
    },
    events,
    rejectWritesTo: (key: string) => { rejectedWriteKeys.add(key); },
    rejectReadsOf: (key: string) => { rejectedReadKeys.add(key); },
    failNextGetTemporarily: () => {
      failNextGetTemporarily = true;
    },
    fireSignInRetry: () => {
      const retry = pendingSignInRetry;
      pendingSignInRetry = null;
      if (!retry) throw new Error('no sign-in retry is pending');
      retry();
    },
    holdNextGet: () => {
      let resolveRelease!: () => void;
      let resolveStarted!: () => void;
      const releasePromise = new Promise<void>((resolveReleasePromise) => {
        resolveRelease = resolveReleasePromise;
      });
      const started = new Promise<void>((resolveStartedPromise) => {
        resolveStarted = resolveStartedPromise;
      });
      pendingGetHold = { releasePromise, resolveRelease, resolveStarted };
      return { release: resolveRelease, started };
    },
    holdNextPost: () => {
      let resolveRelease!: () => void;
      let resolveStarted!: () => void;
      const releasePromise = new Promise<void>((resolveReleasePromise) => {
        resolveRelease = resolveReleasePromise;
      });
      const started = new Promise<void>((resolveStartedPromise) => {
        resolveStarted = resolveStartedPromise;
      });
      pendingHold = { releasePromise, resolveRelease, resolveStarted };
      return { release: resolveRelease, started };
    },
    seedRow: (token, data, syncVersion, schemaVersion = 2) => {
      rows.set(token, { data: { ...data }, schemaVersion, syncVersion });
    },
    setToken: (token) => {
      Object.assign(globalThis, { __cloudPrefsToken: token });
    },
    stateHistory,
    timeoutNextRequest: () => {
      timeoutNextRequest = true;
    },
  };

  try {
    const cloudPrefs = await loadCloudPrefsModule(enabled);
    await invoke(cloudPrefs, controls);
    // Rejections simulate a condition during the RUN, not during measurement —
    // the result assembly below reads the same keys directly and would throw.
    rejectedReadKeys.clear();
    rejectedWriteKeys.clear();
    const activeToken = String(Reflect.get(globalThis, '__cloudPrefsToken'));
    const activeRow = rows.get(activeToken) ?? { data: {}, schemaVersion: 2, syncVersion: 0 };
    return {
      acceptedDataByToken: Object.fromEntries(
        [...rows].map(([token, row]) => [token, { ...row.data }]),
      ),
      acceptedSchemaVersionsByToken: Object.fromEntries(
        Object.entries(acceptedSchemaVersionsByToken).map(([token, versions]) => [token, [...versions]]),
      ),
      conflictCount,
      localSyncVersion: Number(localStorage.getItem('wm-cloud-sync-version') ?? 0),
      localSchemaVersion: Number(localStorage.getItem('wm-cloud-prefs-local-schema-version') ?? 0),
      postCount,
      serverSyncVersion: activeRow.syncVersion,
      state: localStorage.getItem('wm-cloud-sync-state'),
      stateHistory: [...stateHistory],
    };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    AbortSignal.timeout = originalAbortSignalTimeout;
    Object.assign(globalThis, originals);
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
    if (originalCloudPrefsToken) {
      Object.defineProperty(globalThis, '__cloudPrefsToken', originalCloudPrefsToken);
    } else {
      Reflect.deleteProperty(globalThis, '__cloudPrefsToken');
    }
  }
}

describe('cloud preference write serialization', () => {
  it('coalesces overlapping uploads instead of racing stale sync versions', async () => {
    const result = await runHarness(async (cloudPrefs) => {
      await Promise.all(Array.from({ length: 6 }, () => cloudPrefs.syncNow()));
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(result.postCount, 1);
    assert.equal(result.localSyncVersion, result.serverSyncVersion);
    assert.equal(result.state, 'synced');
  });

  it('replays once when a preference changes after the active snapshot', async () => {
    const result = await runHarness(async (cloudPrefs) => {
      cloudPrefs.install('full');
      const sync = cloudPrefs.syncNow();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
      localStorage.setItem('wm-market-watchlist-v1', 'changed-mid-flight');
      await Promise.all([sync, cloudPrefs.syncNow()]);
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(result.postCount, 2);
    assert.equal(result.localSyncVersion, result.serverSyncVersion);
    assert.equal(result.state, 'synced');
  });

  it('serializes sign-in reconciliation with startup preference uploads', async () => {
    const result = await runHarness(async (cloudPrefs) => {
      await Promise.all([
        cloudPrefs.onSignIn('user-1', 'full'),
        ...Array.from({ length: 5 }, () => cloudPrefs.syncNow()),
      ]);
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(result.postCount, 2);
    assert.equal(result.localSyncVersion, result.serverSyncVersion);
    assert.equal(result.state, 'synced');
  });

  it('serializes a sign-out keepalive before a rapid re-sign-in', async () => {
    const result = await runHarness(async (cloudPrefs) => {
      await cloudPrefs.onSignIn('user-1', 'full');
      cloudPrefs.install('full');
      localStorage.setItem('wm-market-watchlist-v1', 'save-before-sign-out');
      cloudPrefs.onSignOut();
      await cloudPrefs.onSignIn('user-1', 'full');
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(result.postCount, 2);
    assert.equal(result.localSyncVersion, result.serverSyncVersion);
    assert.equal(result.state, 'synced');
  });

  it('migrates the local blob before a sign-out keepalive upload', async () => {
    const result = await runHarness(async (cloudPrefs) => {
      await cloudPrefs.onSignIn('user-1', 'full');
      cloudPrefs.install('full');
      localStorage.setItem('wm-cloud-prefs-local-schema-version', '4');
      localStorage.setItem('worldmonitor-disabled-feeds', '["user-choice"]');
      localStorage.setItem('wm-market-watchlist-v1', 'save-before-sign-out');
      cloudPrefs.onSignOut();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    });

    assert.equal(result.localSchemaVersion, 9);
    assert.deepEqual(result.acceptedSchemaVersionsByToken['test-token'], [9, 9]);
    const disabled = JSON.parse(result.acceptedDataByToken['test-token']['worldmonitor-disabled-feeds']) as string[];
    assert.ok(disabled.includes('user-choice'));
    assert.ok(disabled.includes('Guardian Pacific'));
  });

  it('preserves edits made for a new account while its sign-in waits in the queue', async () => {
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.setToken('user-a-token');
      await cloudPrefs.onSignIn('user-a', 'full');
      cloudPrefs.install('full');

      localStorage.setItem('wm-market-watchlist-v1', 'user-a-edit');
      const heldPost = controls.holdNextPost();
      const userAUpload = cloudPrefs.syncNow();
      await heldPost.started;

      cloudPrefs.onSignOut();
      controls.seedRow('user-b-token', {
        'wm-market-watchlist-v1': 'user-b-cloud',
      }, 1);
      controls.setToken('user-b-token');
      const userBSignIn = cloudPrefs.onSignIn('user-b', 'full');
      localStorage.setItem('wm-market-watchlist-v1', 'user-b-edit');

      heldPost.release();
      await Promise.all([userAUpload, userBSignIn]);
      await cloudPrefs.syncNow();
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(
      result.acceptedDataByToken['user-b-token']?.['wm-market-watchlist-v1'],
      'user-b-edit',
    );
    assert.equal(result.localSyncVersion, result.serverSyncVersion);
    assert.equal(result.state, 'synced');
  });

  it('does not report synced between an observable flush and its queued newer upload', async () => {
    const result = await runHarness(async (cloudPrefs, controls) => {
      await cloudPrefs.onSignIn('user-1', 'full');
      cloudPrefs.install('full');

      localStorage.setItem('wm-market-watchlist-v1', 'first-hidden-edit');
      const heldFlush = controls.holdNextPost();
      controls.dispatchHidden();
      await heldFlush.started;

      localStorage.setItem('wm-market-watchlist-v1', 'second-hidden-edit');
      const transitionStart = controls.stateHistory.length;
      controls.dispatchHidden();
      heldFlush.release();
      await cloudPrefs.syncNow();

      assert.deepEqual(
        controls.stateHistory.slice(transitionStart),
        ['pending', 'syncing', 'synced'],
      );
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(result.postCount, 3);
    assert.equal(result.localSyncVersion, result.serverSyncVersion);
    assert.equal(result.state, 'synced');
  });

  it('releases the serialized writer after a timed-out request', async () => {
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.timeoutNextRequest();
      await cloudPrefs.syncNow();
      assert.equal(cloudPrefs.getSyncState(), 'pending');

      await cloudPrefs.syncNow();
      assert.equal(cloudPrefs.getSyncState(), 'synced');
      cloudPrefs.onSignOut();
    });

    assert.equal(result.conflictCount, 0);
    assert.equal(result.postCount, 2);
    assert.equal(result.serverSyncVersion, 1);
  });

  it('keeps a sign-in retry pending after its timer fires until the request settles', async () => {
    await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', {}, 1, 7);
      controls.failNextGetTemporarily();

      await cloudPrefs.onSignIn('user-1', 'full', { handoffGeneration: 41 });
      assert.equal(cloudPrefs.hasPendingCloudPrefsRetry(), true);

      const heldGet = controls.holdNextGet();
      controls.fireSignInRetry();
      await heldGet.started;
      assert.equal(
        cloudPrefs.hasPendingCloudPrefsRetry(),
        true,
        'firing the timer must not expose an idle gap while the retry fetch is unresolved',
      );
      assert.equal(
        controls.events.filter((event) => event.type === cloudPrefs.CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT).length,
        0,
      );

      heldGet.release();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      assert.equal(cloudPrefs.hasPendingCloudPrefsRetry(), false);
      const terminalEvents = controls.events.filter(
        (event) => event.type === cloudPrefs.CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      );
      assert.deepEqual(terminalEvents.map((event) => event.detail), [{
        accountId: 'user-1',
        authGeneration: 1,
        handoffGeneration: 41,
        origin: 'sign-in',
        outcome: 'synced',
      }]);
    });
  });

  it('emits a scoped terminal event even when cloud apply changes no keys', async () => {
    await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', {}, 1, 7);
      await cloudPrefs.onSignIn('user-1', 'full', { handoffGeneration: 73 });

      assert.equal(
        controls.events.filter((event) => event.type === cloudPrefs.CLOUD_PREFS_APPLIED_EVENT).length,
        0,
        'unchanged apply has no generic change event',
      );
      const terminal = controls.events.find(
        (event) => event.type === cloudPrefs.CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      );
      assert.deepEqual(terminal?.detail, {
        accountId: 'user-1',
        authGeneration: 1,
        handoffGeneration: 73,
        origin: 'sign-in',
        outcome: 'synced',
      });
    });
  });

  it('releases the scoped handoff immediately when cloud sync is disabled', async () => {
    const result = await runHarness(async (cloudPrefs, controls) => {
      await cloudPrefs.onSignIn('user-1', 'full', { handoffGeneration: 89 });

      const terminal = controls.events.find(
        (event) => event.type === cloudPrefs.CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      );
      assert.deepEqual(terminal?.detail, {
        accountId: 'user-1',
        authGeneration: 0,
        handoffGeneration: 89,
        origin: 'sign-in',
        outcome: 'skipped',
      });
    }, { enabled: false });

    assert.equal(result.postCount, 0);
    assert.equal(result.state, null);
  });

  it('does not retain account A ownership for account B legacy cloud rows', async () => {
    await runHarness(async (cloudPrefs, controls) => {
      const sourceOwnership = 'worldmonitor-free-tier-source-ownership';
      const layerOwnership = 'worldmonitor-free-tier-layer-ownership';
      controls.seedRow('user-a-token', {
        [sourceOwnership]: '["source-a"]',
        [layerOwnership]: '["resilienceScore"]',
      }, 1, 7);
      controls.setToken('user-a-token');
      await cloudPrefs.onSignIn('user-a', 'full');
      assert.equal(localStorage.getItem(sourceOwnership), '["source-a"]');
      assert.equal(localStorage.getItem(layerOwnership), '["resilienceScore"]');

      cloudPrefs.onSignOut();
      controls.seedRow('user-b-token', { 'worldmonitor-theme': 'light' }, 1, 7);
      controls.setToken('user-b-token');
      await cloudPrefs.onSignIn('user-b', 'full');

      assert.equal(localStorage.getItem(sourceOwnership), null);
      assert.equal(localStorage.getItem(layerOwnership), null);
      assert.equal(localStorage.getItem('worldmonitor-theme'), 'light');
    });
  });
});

// #4746 - two same-user tabs share one KEY_DIRTY_KEYS entry. A faithful
// simulation needs each tab's install() patch to fire only for that tab's
// writes, so each tab gets its own Storage prototype over one shared backing
// map (a single shared prototype would stack both patches and make tab A
// observe tab B's writes, which real renderer isolation never does).
async function runTwoTabDirtyKeyHarness(
  drive: (
    tabA: Awaited<ReturnType<typeof loadCloudPrefsModule>>,
    tabB: Awaited<ReturnType<typeof loadCloudPrefsModule>>,
    readPersistedDirtyKeys: () => string[],
    withTabA: <T>(fn: () => Promise<T>) => Promise<T>,
    withTabB: <T>(fn: () => Promise<T>) => Promise<T>,
  ) => Promise<void>,
): Promise<void> {
  const backing = new Map<string, string>();
  const makeStorageClass = () => class SharedBackingStorage {
    get length(): number { return backing.size; }
    getItem(key: string): string | null { return backing.has(key) ? backing.get(key)! : null; }
    setItem(key: string, value: string): void { backing.set(key, String(value)); }
    removeItem(key: string): void { backing.delete(key); }
    clear(): void { backing.clear(); }
    key(index: number): string | null { return [...backing.keys()][index] ?? null; }
  };
  const StorageA = makeStorageClass();
  const StorageB = makeStorageClass();
  const storageA = new StorageA();
  const storageB = new StorageB();
  const documentListeners = new Map<string, Array<() => void>>();
  const originals = {
    CustomEvent: globalThis.CustomEvent,
    Storage: globalThis.Storage,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalCloudPrefsToken = Object.getOwnPropertyDescriptor(globalThis, '__cloudPrefsToken');
  const originalFetch = globalThis.fetch;

  const installGlobals = (StorageClass: unknown, storageInstance: unknown): void => {
    Object.assign(globalThis, {
      __cloudPrefsToken: 'two-tab-token',
      CustomEvent: class TestCustomEvent {
        detail: unknown;
        type: string;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      Storage: StorageClass,
      document: {
        visibilityState: 'visible',
        addEventListener(type: string, listener: () => void) {
          const arr = documentListeners.get(type) ?? [];
          arr.push(listener);
          documentListeners.set(type, arr);
        },
        body: { appendChild() {} },
        createElement() { return { addEventListener() {}, className: '', innerHTML: '', remove() {} }; },
        querySelector() { return null; },
      },
      localStorage: storageInstance,
      window: {
        addEventListener() {},
        dispatchEvent() { return true; },
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
  };

  globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      return Response.json({ data: {}, schemaVersion: 2, syncVersion: 0 });
    }
    return Response.json({ ok: true, syncVersion: 1 });
  }) as typeof fetch;

  const readPersistedDirtyKeys = (): string[] => {
    const raw = backing.get('wm-cloud-prefs-dirty-keys');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { keys?: unknown };
      return Array.isArray(parsed.keys) ? parsed.keys.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  };

  const withTabA = async <T>(fn: () => Promise<T>): Promise<T> => {
    installGlobals(StorageA, storageA);
    return fn();
  };
  const withTabB = async <T>(fn: () => Promise<T>): Promise<T> => {
    installGlobals(StorageB, storageB);
    return fn();
  };

  try {
    const tabA = await withTabA(() => loadCloudPrefsModule());
    const tabB = await withTabB(() => loadCloudPrefsModule());
    await drive(tabA, tabB, readPersistedDirtyKeys, withTabA, withTabB);
  } finally {
    Object.assign(globalThis, originals);
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    if (originalCloudPrefsToken) Object.defineProperty(globalThis, '__cloudPrefsToken', originalCloudPrefsToken);
    else delete (globalThis as { __cloudPrefsToken?: unknown }).__cloudPrefsToken;
    globalThis.fetch = originalFetch;
  }
}
describe('two-tab dirty-key persistence (#4746)', () => {
  it('unions markers across concurrent same-user tabs and settles only the uploading tab keys', async () => {
    await runTwoTabDirtyKeyHarness(async (tabA, tabB, readPersistedDirtyKeys, withTabA, withTabB) => {
      // Each tab signs in and installs while ITS Storage prototype is the
      // global one, so its write patch lands on its own prototype. Writes and
      // uploads then run through the same per-tab globals — exactly the
      // renderer isolation two real tabs have over one shared profile.
      await withTabA(async () => {
        await tabA.onSignIn('user-1', 'full');
        tabA.install('full');
      });
      await withTabB(async () => {
        await tabB.onSignIn('user-1', 'full');
        tabB.install('full');
      });

      // Tab A dirties the watchlist key. Old code: disk = {A}.
      await withTabA(async () => {
        globalThis.localStorage.setItem('wm-market-watchlist-v1', 'tab-a-edit');
      });
      assert.deepEqual(readPersistedDirtyKeys(), ['wm-market-watchlist-v1']);

      // Tab B (same user, same browser profile) dirties a different key.
      // Old wholesale overwrite: disk = {B}, A's marker lost.
      await withTabB(async () => {
        globalThis.localStorage.setItem('worldmonitor-theme', 'tab-b-edit');
      });
      assert.deepEqual(
        [...readPersistedDirtyKeys()].sort(),
        ['wm-market-watchlist-v1', 'worldmonitor-theme'],
        'the second tab write must union, not clobber, the first tab marker',
      );

      // Tab A uploads and settles only its own key: B's still-pending marker
      // must survive on disk for B's own upload/hydrate.
      await withTabA(async () => {
        await tabA.syncNow();
      });
      assert.deepEqual(
        readPersistedDirtyKeys(),
        ['worldmonitor-theme'],
        'a settled upload must remove only the keys that tab durably synced',
      );
    });
  });
});

describe('cloud prefs storage-rejection safety (#7833)', () => {
  it('does not advance the sync version when a pref write is rejected', async () => {
    // The data-loss shape review found: safeStorageSet swallowed a
    // QuotaExceededError, so applyCloudBlob "succeeded", setSyncVersion
    // advanced local to the cloud row's version, and the NEXT upload posted the
    // stale local value back over good cloud data with no conflict to stop it.
    // The pref value is what gets rejected; the small version marker would
    // still fit, which is exactly why the version must not be written.
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', { 'wm-market-watchlist-v1': 'cloud-value' }, 9);
      controls.rejectWritesTo('wm-market-watchlist-v1');
      await cloudPrefs.onSignIn('user-1', 'full');
    });

    assert.notEqual(
      result.localSyncVersion,
      9,
      'local must not claim the cloud version after a write that never landed',
    );
    assert.equal(result.state, 'error', 'a rejected reconciliation must surface as error');
  });

  it('still reconciles normally when the same write is accepted', async () => {
    // The control. Without it the assertions above would also pass if sign-in
    // were broken outright, which is the failure mode a negative-only
    // regression test cannot see.
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', { 'wm-market-watchlist-v1': 'cloud-value' }, 9);
      await cloudPrefs.onSignIn('user-1', 'full');
    });

    assert.equal(result.localSyncVersion, 9);
    assert.equal(result.state, 'synced');
  });
});

describe('cloud prefs read-failure safety (#7833 review)', () => {
  it('does not upload a blob that omits a preference it could not read', () => {
    // The deletion path: this blob REPLACES the server's, and an omitted key
    // means "cleared". Degrading a throwing read to null therefore turned a
    // transient read failure into a permanent cloud deletion of that
    // preference. The raw read before #7833 threw and aborted the upload.
    return runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', { 'wm-market-watchlist-v1': 'cloud-value' }, 1);
      await cloudPrefs.onSignIn('user-1', 'full');
      cloudPrefs.install('full');
      localStorage.setItem('wm-market-watchlist-v1', 'local-edit');
      controls.rejectReadsOf('wm-market-watchlist-v1');
      await cloudPrefs.syncNow();
    }).then((result) => {
      // The assertion has to be that the key SURVIVES on the server. Accepting
      // "absent from the posted blob" would accept the deletion itself, which
      // is how the first version of this test passed against the bug.
      const row = result.acceptedDataByToken['test-token'] ?? {};
      assert.ok(
        'wm-market-watchlist-v1' in row,
        'an unreadable preference must not be deleted from the cloud row by an upload',
      );
    });
  });
});

describe('cloud prefs sign-out cleanup (#7833 review)', () => {
  it('completes sign-out cleanup even when the pending flush cannot be built', async () => {
    // The flush is best-effort; the CLEANUP is not. Returning early from
    // onSignOut on an unreadable preference left the auth generation un-bumped,
    // the retry timers live, and _cachedToken holding the signed-out user's
    // token — which a later unload handler could still post with.
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', { 'wm-market-watchlist-v1': 'cloud-value' }, 1);
      await cloudPrefs.onSignIn('user-1', 'full');
      cloudPrefs.install('full');
      localStorage.setItem('wm-market-watchlist-v1', 'local-edit');
      controls.rejectReadsOf('wm-market-watchlist-v1');
      cloudPrefs.onSignOut();
    });

    assert.equal(
      result.state,
      'signed-out',
      'sign-out must reach its state cleanup even when the flush is skipped',
    );
    assert.equal(
      result.localSyncVersion,
      0,
      'sign-out must clear the durable sync-version metadata',
    );
  });
});

describe('cloud prefs fail closed on undeterminable state (#7833 review)', () => {
  it('does not apply the cloud blob when the local sync version cannot be read', async () => {
    // Degrading this read to 0 means "never synced", which makes the cloud
    // unconditionally look ahead — so the cloud blob is applied over local
    // edits that were never uploaded.
    // The local value has to be captured INSIDE the harness: it restores the
    // globals on exit, so `localStorage` is gone by the time assertions run.
    let watchlistAfter: string | null = null;
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', { 'wm-market-watchlist-v1': 'cloud-value' }, 9);
      localStorage.setItem('wm-market-watchlist-v1', 'local-edit');
      controls.rejectReadsOf('wm-cloud-sync-version');
      await cloudPrefs.onSignIn('user-1', 'full');
      watchlistAfter = localStorage.getItem('wm-market-watchlist-v1');
    });

    assert.equal(
      watchlistAfter,
      'local-edit',
      'an unreadable sync version must not let cloud overwrite local edits',
    );
    assert.equal(result.state, 'error');
  });

  it('does not sign in when prior-account ownership cannot be determined', async () => {
    // Skipping the sidecar cleanup on an account transition leaves account A's
    // ownership values in place for B, so tier reconciliation attributes A's
    // gate decisions to B.
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', {}, 1);
      controls.rejectReadsOf('wm-last-signed-in-as');
      await cloudPrefs.onSignIn('user-b', 'full');
    });

    assert.equal(result.state, 'error', 'undeterminable provenance must fail closed');
    assert.equal(result.postCount, 0, 'nothing may be uploaded on a provenance failure');
  });
});


describe('cloud prefs marker ordering (#7833 review)', () => {
  it('does not advance the sync version when the schema marker is rejected', async () => {
    // Both writes are checked, but ORDER decides what a partial failure leaves
    // behind. Advancing the version first leaves a durable claim that this
    // cloud generation was reconciled while the schema marker is still old, and
    // the next sign-in then sees equal versions, takes the local-upload branch,
    // and reruns one-shot migrations over already-migrated data.
    const result = await runHarness(async (cloudPrefs, controls) => {
      controls.seedRow('test-token', { 'wm-market-watchlist-v1': 'cloud-value' }, 9, 8);
      controls.rejectWritesTo('wm-cloud-prefs-local-schema-version');
      await cloudPrefs.onSignIn('user-1', 'full');
    });

    assert.notEqual(
      result.localSyncVersion,
      9,
      'the sync version must not advance past a rejected schema marker',
    );
    assert.equal(result.state, 'error');
  });
});

describe('settings import cloud transaction', () => {
  it('does not mark partial imports dirty when a later write fails', async () => {
    await runHarness(async (cloudPrefs, controls) => {
      cloudPrefs.install('full');
      const before = localStorage.getItem('worldmonitor-theme');
      const dirtyBefore = localStorage.getItem('wm-cloud-prefs-dirty-keys');
      controls.rejectWritesTo('wm-font-scale');
      assert.throws(() => cloudPrefs.applyLocalPreferenceImport([
        ['worldmonitor-theme', 'light'], ['wm-font-scale', '1.2'],
      ]));
      assert.equal(localStorage.getItem('worldmonitor-theme'), before);
      assert.equal(localStorage.getItem('wm-cloud-prefs-dirty-keys'), dirtyBefore);
    });
  });

  it('publishes successful validated imports through the normal sync path', async () => {
    const result = await runHarness(async (cloudPrefs) => {
      cloudPrefs.install('full');
      cloudPrefs.applyLocalPreferenceImport([['worldmonitor-theme', 'light']]);
      await cloudPrefs.syncNow();
    });
    assert.equal(result.acceptedDataByToken['test-token']?.['worldmonitor-theme'], 'light');
  });
});
