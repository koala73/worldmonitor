/**
 * Desktop-key verdict for self-hosted web installs (plan 2026-11-04-001, U5).
 *
 * On a self-hosted install the sidecar holds the browser's desktop key in an
 * HttpOnly cookie and answers `/api/selfhost-key` with the cloud's verdict on
 * it. worldmonitor.app and the desktop app answer 404 there, which this
 * service reads as "not self-hosted" and then stays quiet for the page's life.
 *
 * Unlock state: `unknown` -> (active verdict) `unlocked` -> (inactive verdict)
 * `locked`. Only positive evidence moves it (CONCEPTS.md "Affirmative
 * Denial"): an explicit inactive status locks, while a transport error, a 429,
 * a 5xx or an `unavailable` verdict keeps the last state. The client owns the
 * 24-hour grace bound and measures it from `verifiedAt`, the time of the last
 * fresh verdict the sidecar saw; past it an unlocked browser drops to unknown.
 * Only `unlocked` grants Pro.
 *
 * App boot starts the service with `startSelfHostKeyService()` and never awaits
 * it. Reading the state does not start it, so code that only asks (gating,
 * Settings, tests) never sends a request on its own.
 */
import { isDesktopRuntime } from '@/config/desktop-runtime';

export type SelfHostKeyStatus =
  | 'none'
  | 'active'
  | 'invalid'
  | 'not_desktop_key'
  | 'over_cap'
  | 'lapsed'
  | 'unavailable'
  | 'disabled';

export type SelfHostUnlockState = 'unknown' | 'unlocked' | 'locked';

export interface SelfHostKeyVerdict {
  enabled: boolean;
  status: SelfHostKeyStatus;
  stale: boolean;
  verifiedAt: number | null;
}

export interface SelfHostKeySnapshot {
  /** null until the route has answered once; false after a 404. */
  selfHosted: boolean | null;
  /** The last verdict the sidecar returned, or null before the first one. */
  verdict: SelfHostKeyVerdict | null;
  unlock: SelfHostUnlockState;
  /** The latest check failed (network, 429, 5xx); the verdict is older. */
  checkFailed: boolean;
}

export type SelfHostKeyWriteResult =
  | { kind: 'verdict'; verdict: SelfHostKeyVerdict }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'failed' };

export const SELF_HOST_KEY_ROUTE = '/api/selfhost-key';
export const SELF_HOST_KEY_REFRESH_MS = 15 * 60 * 1000;
// Longer than the sidecar's own cloud check, so a slow cloud answers
// 'unavailable' before the browser gives up on the sidecar. Bounds reads and
// writes: a hung install must not pin the shared check or the Settings buttons.
export const SELF_HOST_KEY_REQUEST_TIMEOUT_MS = 20_000;
export const SELF_HOST_KEY_GRACE_MS = 24 * 60 * 60 * 1000;

const STATUSES = new Set<SelfHostKeyStatus>([
  'none', 'active', 'invalid', 'not_desktop_key', 'over_cap', 'lapsed', 'unavailable', 'disabled',
]);

interface Environment {
  fetch: typeof fetch;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Whether this page may talk to the route at all. */
  canRun: () => boolean;
  /** Deadline for one request to the route. */
  timeoutSignal: () => AbortSignal | undefined;
}

function defaultEnvironment(): Environment {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    setInterval: (fn, ms) => {
      const handle = globalThis.setInterval(fn, ms);
      // Node test harnesses that fake `window` must still be able to exit.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    },
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
    timeoutSignal: () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(SELF_HOST_KEY_REQUEST_TIMEOUT_MS)
      : undefined),
    // The desktop app keeps its key in the native vault and never serves this
    // route, and the hosted site answers it with a 404, so both skip the
    // request entirely.
    canRun: () => typeof window !== 'undefined'
      && typeof globalThis.fetch === 'function'
      && !isDesktopRuntime()
      && !isHostedWorldMonitorHost(window.location?.hostname),
  };
}

/** worldmonitor.app and its subdomains are never a self-hosted install. */
export function isHostedWorldMonitorHost(hostname: string | undefined): boolean {
  const host = (hostname ?? '').toLowerCase();
  return host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app');
}

let env: Environment = defaultEnvironment();
let started = false;
let selfHosted: boolean | null = null;
let verdict: SelfHostKeyVerdict | null = null;
let unlock: SelfHostUnlockState = 'unknown';
let lastActiveVerifiedAt: number | null = null;
let checkFailed = false;
let refreshTimer: unknown = null;
let inflight: Promise<void> | null = null;
// Bumped by every save and remove, so a status read sent before the change
// cannot overwrite the answer to it.
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function parseVerdict(body: unknown): SelfHostKeyVerdict | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean') return null;
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status as SelfHostKeyStatus)) return null;
  const verifiedAt = typeof raw.verifiedAt === 'number' && Number.isFinite(raw.verifiedAt)
    ? raw.verifiedAt
    : null;
  return {
    enabled: raw.enabled,
    status: raw.status as SelfHostKeyStatus,
    stale: raw.stale === true,
    verifiedAt,
  };
}

function withinGrace(verifiedAt: number | null): boolean {
  if (verifiedAt === null) return false;
  const age = env.now() - verifiedAt;
  return age >= 0 ? age < SELF_HOST_KEY_GRACE_MS : true;
}

/** Drop an unlocked browser to unknown once its last active verdict is 24h old. */
function applyGraceBound(): boolean {
  if (unlock === 'unlocked' && !withinGrace(lastActiveVerifiedAt)) {
    unlock = 'unknown';
    lastActiveVerifiedAt = null;
    return true;
  }
  return false;
}

function applyVerdict(next: SelfHostKeyVerdict): void {
  selfHosted = true;
  verdict = next;
  checkFailed = next.status === 'unavailable';
  if (next.status === 'active') {
    if (withinGrace(next.verifiedAt)) {
      unlock = 'unlocked';
      lastActiveVerifiedAt = next.verifiedAt;
    } else {
      // An active verdict the cloud has not repeated for a day is no longer
      // evidence either way.
      unlock = 'unknown';
      lastActiveVerifiedAt = null;
    }
  } else if (next.status !== 'unavailable') {
    unlock = 'locked';
    lastActiveVerifiedAt = null;
  } else {
    applyGraceBound();
  }
  notify();
}

function applyCheckFailure(): void {
  const expired = applyGraceBound();
  if (expired || !checkFailed) {
    checkFailed = true;
    notify();
  }
}

function stopPolling(): void {
  if (refreshTimer !== null) env.clearInterval(refreshTimer);
  refreshTimer = null;
}

function markNotSelfHosted(): void {
  stopPolling();
  const changed = selfHosted !== false;
  selfHosted = false;
  verdict = null;
  unlock = 'unknown';
  lastActiveVerifiedAt = null;
  checkFailed = false;
  if (changed) notify();
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function readStatus(): Promise<void> {
  const sentGeneration = generation;
  let res: Response;
  try {
    // A hung sidecar must not pin `inflight` forever: every later refresh and
    // denial re-check shares it.
    const signal = env.timeoutSignal();
    res = await env.fetch(SELF_HOST_KEY_ROUTE, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch {
    if (sentGeneration === generation) applyCheckFailure();
    return;
  }
  if (sentGeneration !== generation) return;
  if (res.status === 404) {
    markNotSelfHosted();
    return;
  }
  const parsed = res.ok ? parseVerdict(await readJson(res)) : null;
  if (sentGeneration !== generation) return;
  if (parsed) applyVerdict(parsed);
  else applyCheckFailure();
}

function startPolling(): void {
  if (refreshTimer !== null) return;
  refreshTimer = env.setInterval(() => {
    if (selfHosted === false) {
      stopPolling();
      return;
    }
    void refreshSelfHostKey();
  }, SELF_HOST_KEY_REFRESH_MS);
}

function ensureStarted(): void {
  if (started || !env.canRun()) return;
  started = true;
  // Never awaited: boot must not wait on this read.
  void refreshSelfHostKey().then(() => {
    if (selfHosted !== false) startPolling();
  });
}

/** Re-read the verdict. Concurrent callers share one request. */
export function refreshSelfHostKey(): Promise<void> {
  if (selfHosted === false) return Promise.resolve();
  if (!inflight) {
    inflight = readStatus().finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * A premium request came back 401 or 403. On an unlocked self-hosted browser
 * that may mean the key was revoked or lapsed, so check again now rather than
 * at the next 15-minute tick. Anywhere else the denial says nothing new.
 */
export function noteSelfHostPremiumDenial(): void {
  if (selfHosted !== true || unlock !== 'unlocked') return;
  void refreshSelfHostKey();
}

/** Start the boot read if it has not run. Safe to call repeatedly. */
export function startSelfHostKeyService(): void {
  ensureStarted();
}

export function isSelfHostKeyUnlocked(): boolean {
  return unlock === 'unlocked' && withinGrace(lastActiveVerifiedAt);
}

export function getSelfHostKeySnapshot(): SelfHostKeySnapshot {
  return {
    selfHosted,
    verdict: verdict ? { ...verdict } : null,
    unlock: unlock === 'unlocked' && !withinGrace(lastActiveVerifiedAt) ? 'unknown' : unlock,
    checkFailed,
  };
}

/** Fires on every change to the snapshot. */
export function subscribeSelfHostKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function writeKey(method: 'POST' | 'DELETE', body?: string): Promise<SelfHostKeyWriteResult> {
  generation += 1;
  const sentGeneration = generation;
  try {
    return await sendKeyWrite(method, body, sentGeneration);
  } finally {
    // A status read that started while this write was in flight saw the old
    // cookie; its answer must not overwrite the write's verdict.
    if (sentGeneration === generation) generation += 1;
  }
}

async function sendKeyWrite(
  method: 'POST' | 'DELETE',
  body: string | undefined,
  sentGeneration: number,
): Promise<SelfHostKeyWriteResult> {
  let res: Response;
  try {
    const signal = env.timeoutSignal();
    res = await env.fetch(SELF_HOST_KEY_ROUTE, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfterSeconds(res) };
  if (res.status === 404) {
    if (sentGeneration === generation) markNotSelfHosted();
    return { kind: 'failed' };
  }
  // 400 carries a verdict too: a malformed key is reported as invalid.
  const parsed = res.ok || res.status === 400 ? parseVerdict(await readJson(res)) : null;
  if (!parsed) return { kind: 'failed' };
  if (sentGeneration === generation) {
    if (!started && env.canRun()) {
      started = true;
      startPolling();
    }
    applyVerdict(parsed);
  }
  return { kind: 'verdict', verdict: parsed };
}

/** Send a key to this install's server, which asks the cloud about it. */
export function saveSelfHostKey(key: string): Promise<SelfHostKeyWriteResult> {
  return writeKey('POST', JSON.stringify({ key: key.trim() }));
}

/** Forget this browser's key. */
export function removeSelfHostKey(): Promise<SelfHostKeyWriteResult> {
  return writeKey('DELETE');
}

/**
 * Test seam. Resets the module state and swaps the environment. Subscribers
 * stay registered (widget-store subscribes once at module load) and are told
 * about the reset so their cached view matches.
 */
export function _resetSelfHostKeyForTests(overrides: Partial<Environment> = {}): void {
  stopPolling();
  const next = { ...defaultEnvironment(), ...overrides };
  // Listeners re-read the state below; they must not start a read from it.
  env = { ...next, canRun: () => false };
  started = false;
  selfHosted = null;
  verdict = null;
  unlock = 'unknown';
  lastActiveVerifiedAt = null;
  checkFailed = false;
  inflight = null;
  generation = 0;
  notify();
  env = next;
}
