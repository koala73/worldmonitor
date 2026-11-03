import { ensureHydrated, getHydratedData, waitForBootstrapSlowTier } from './bootstrap';
import { getPersistentCache, setPersistentCache } from './persistent-cache';
import type { ConvergenceCard, CorrelationDomain } from './correlation-engine';
import { CORRELATION_DOMAINS } from '@/types/correlation';
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';

export interface CorrelationSnapshot {
  cards: ConvergenceCard[];
  computedAt: number;
  origin: 'seed' | 'local';
}

export type CorrelationSnapshotState = { offline: boolean } & (
  | { status: 'loading' | 'waiting'; snapshot: null }
  | { status: 'current' | 'updating'; snapshot: CorrelationSnapshot });

const CACHE_KEY = 'correlation-snapshots:v1';
const MINUTE = 60_000;
const REFRESH_MS = 5 * MINUTE;
const FRESH_MS = 15 * MINUTE;
// Historical display only; this does not extend the producer's freshness budget.
const MAX_AGE_MS = 60 * MINUTE;
// Client clocks can lag the producer; reject only implausibly future-dated data.
const CLOCK_SKEW_MS = 10 * MINUTE;

type Listener = (state: CorrelationSnapshotState) => void;
const snapshots = new Map<CorrelationDomain, CorrelationSnapshot>();
const listeners = new Map<CorrelationDomain, Set<Listener>>();
const failedDomains = new Set<CorrelationDomain>();
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let active = false;
let pending = false;
let attempted = false;
let failureCount = 0;
let nextFetchAt = 0;
let saveQueued = false;
let offlineProbeAt = 0;
let reachedServer = false;
let reportedFailure = false;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validCards(value: unknown, domain: CorrelationDomain): value is ConvergenceCard[] {
  return Array.isArray(value) && value.every(card => (
    record(card) && typeof card.id === 'string' && card.domain === domain
    && typeof card.title === 'string' && finite(card.score)
    && card.score >= 0 && card.score <= 100 && finite(card.timestamp)
    && ['escalating', 'stable', 'de-escalating'].includes(String(card.trend))
    && Array.isArray(card.countries) && card.countries.every(country => typeof country === 'string')
    && (card.assessment === undefined || typeof card.assessment === 'string')
    && (card.location === undefined || (record(card.location)
      && finite(card.location.lat) && Math.abs(card.location.lat) <= 90
      && finite(card.location.lon) && Math.abs(card.location.lon) <= 180
      && typeof card.location.label === 'string'))
    && Array.isArray(card.signals) && card.signals.every(signal => (
      record(signal) && typeof signal.type === 'string' && typeof signal.label === 'string'
      && typeof signal.source === 'string' && finite(signal.severity) && finite(signal.timestamp)
    ))
  ));
}

function validTime(value: unknown): value is number {
  return finite(value) && value > 0 && value <= Date.now() + CLOCK_SKEW_MS
    && Date.now() - value < MAX_AGE_MS;
}

function stateFor(domain: CorrelationDomain): CorrelationSnapshotState {
  const offline = navigator.onLine === false && !reachedServer;
  const snapshot = snapshots.get(domain);
  if (!snapshot || !validTime(snapshot.computedAt)) {
    return { status: attempted ? 'waiting' : 'loading', snapshot: null, offline };
  }
  const updating = pending || offline
    || Date.now() - snapshot.computedAt >= FRESH_MS
    || (snapshot.origin === 'seed' && failedDomains.has(domain));
  return { status: updating ? 'updating' : 'current', snapshot, offline };
}

function notify(): void {
  for (const [domain, callbacks] of listeners) {
    const state = stateFor(domain);
    for (const callback of callbacks) notifyListener(callback, state);
  }
}

function notifyListener(listener: Listener, state: CorrelationSnapshotState): void {
  try {
    listener(state);
  } catch (error) {
    console.warn('[CorrelationSnapshot] Listener failed', error);
  }
}

function accept(domain: CorrelationDomain, snapshot: CorrelationSnapshot): boolean {
  const previous = snapshots.get(domain);
  if (previous) {
    // A fresh seed has complete domain semantics, including confirmed absence.
    // Local computation time alone cannot supersede it with partial inputs.
    if (previous.origin === 'seed' && snapshot.origin === 'local'
      && Date.now() - previous.computedAt < FRESH_MS) return false;
    const freshSeedOverLocal = snapshot.origin === 'seed' && previous.origin === 'local'
      && Date.now() - snapshot.computedAt < FRESH_MS;
    if (!freshSeedOverLocal && previous.computedAt >= snapshot.computedAt) return false;
  }
  snapshots.set(domain, snapshot);
  return true;
}

function persist(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    const saved = Object.fromEntries([...snapshots].map(([domain, snapshot]) => [domain, {
      ...snapshot,
      // Local adapters may attach large source objects; the panel never renders them.
      cards: snapshot.cards.map(card => ({
        ...card,
        // Premium annotations belong to the current session, even on seed cards.
        assessment: undefined,
        signals: card.signals.map(({ rawData: _rawData, ...signal }) => signal),
      })),
    }]));
    void setPersistentCache(CACHE_KEY, saved).catch(error => {
      console.warn('[CorrelationSnapshot] Cache write failed', error);
    });
  });
}

async function restore(epoch: number): Promise<void> {
  try {
    const saved = await getPersistentCache<unknown>(CACHE_KEY);
    if (!active || epoch !== generation || !record(saved?.data)) return;
    for (const domain of CORRELATION_DOMAINS) {
      const value = saved.data[domain];
      if (record(value) && validTime(value.computedAt) && validCards(value.cards, domain)
        && (value.origin === 'seed' || (value.origin === 'local' && value.cards.length > 0))) {
        accept(domain, { cards: value.cards, computedAt: value.computedAt, origin: value.origin });
      }
    }
    notify();
  } catch (error) {
    console.warn('[CorrelationSnapshot] Cache read failed', error);
  }
}

async function refresh(): Promise<void> {
  const epoch = generation;
  pending = true;
  notify();
  try {
    // Drain legacy tier hydration during a rolling deploy without making its
    // completion a permanent prerequisite for this on-demand key.
    await waitForBootstrapSlowTier(3_500);
    if (!active || epoch !== generation) return;
    const payload = getHydratedData('correlationCards') ?? await ensureHydrated('correlationCards');
    if (!active || epoch !== generation) return;
    reachedServer = payload !== undefined;
    let changed = false;
    failedDomains.clear();
    for (const domain of CORRELATION_DOMAINS) {
      if (record(payload) && validTime(payload.computedAt) && validCards(payload[domain], domain)) {
        changed = accept(domain, {
          cards: payload[domain], computedAt: payload.computedAt, origin: 'seed',
        }) || changed;
      } else {
        failedDomains.add(domain);
      }
    }
    if (changed) persist();
    if (failedDomains.size) {
      console.warn('[CorrelationSnapshot] Missing, expired or invalid domains', [...failedDomains]);
    }
  } catch (error) {
    if (!active || epoch !== generation) return;
    reachedServer = false;
    for (const domain of CORRELATION_DOMAINS) failedDomains.add(domain);
    console.warn('[CorrelationSnapshot] Refresh failed', error);
  } finally {
    if (active && epoch === generation) {
      pending = false;
      attempted = true;
      failureCount = failedDomains.size ? failureCount + 1 : 0;
      if (!failureCount) reportedFailure = false;
      if (failureCount >= 3 && !reportedFailure && (navigator.onLine !== false || reachedServer)) {
        reportedFailure = true;
        const domains = [...failedDomains];
        try {
          enqueueSentryCall(s => s.captureMessage('Correlation snapshot recovery stalled', {
            level: 'warning', tags: { component: 'correlation-snapshots' }, extra: { domains },
          }));
        } catch { /* Telemetry must not interrupt recovery. */ }
      }
      const retryMs = Math.min(15_000 * 2 ** Math.min(failureCount - 1, 4), 180_000)
        * (0.8 + 0.2 * Math.random());
      offlineProbeAt = Date.now() + REFRESH_MS;
      nextFetchAt = navigator.onLine === false && !reachedServer
        ? offlineProbeAt : Date.now() + (failureCount ? retryMs : REFRESH_MS);
      notify();
      schedule();
    }
  }
}

function tick(): void {
  if (!active || document.hidden) return;
  if (!pending && Date.now() >= nextFetchAt) {
    if (navigator.onLine === false && !reachedServer && Date.now() < offlineProbeAt) {
      attempted = true;
      nextFetchAt = offlineProbeAt;
    } else {
      void refresh();
    }
  }
  notify();
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  if (!active || document.hidden) return;
  timer = setTimeout(tick, pending ? MINUTE : Math.max(1, Math.min(MINUTE, nextFetchAt - Date.now())));
}

function reconnect(): void {
  nextFetchAt = 0;
  offlineProbeAt = 0;
  tick();
}

function disconnect(): void {
  reachedServer = false;
  offlineProbeAt = Date.now() + MINUTE;
  nextFetchAt = offlineProbeAt;
  tick();
}

function visibilityChanged(): void {
  clearTimeout(timer);
  if (!document.hidden) tick();
}

export function subscribeCorrelationSnapshot(domain: CorrelationDomain, listener: Listener): () => void {
  let subscribed = true;
  const callbacks = listeners.get(domain) ?? new Set<Listener>();
  callbacks.add(listener);
  listeners.set(domain, callbacks);
  notifyListener(listener, stateFor(domain));
  if (!active) {
    active = true;
    generation++;
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', disconnect);
    document.addEventListener('visibilitychange', visibilityChanged);
    void restore(generation);
    nextFetchAt = 0;
    reachedServer = false;
    offlineProbeAt = Date.now() + MINUTE;
    tick();
  }
  return () => {
    if (!subscribed) return;
    subscribed = false;
    callbacks.delete(listener);
    if (!callbacks.size) listeners.delete(domain);
    if (listeners.size || !active) return;
    active = false;
    generation++;
    pending = false;
    clearTimeout(timer);
    window.removeEventListener('online', reconnect);
    window.removeEventListener('offline', disconnect);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}

export function publishLocalCorrelationCards(domain: CorrelationDomain, cards: ConvergenceCard[]): void {
  if (!validCards(cards, domain)) {
    console.warn('[CorrelationSnapshot] Invalid local cards', domain);
    return;
  }
  // Adapters also return [] when their inputs have not loaded. Only the
  // validated seed can authoritatively clear previously observed activity.
  if (cards.length === 0) return;
  if (accept(domain, { cards, computedAt: Date.now(), origin: 'local' })) persist();
  notify();
}
