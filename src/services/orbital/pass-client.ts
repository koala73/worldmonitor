import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { CatalogStatus, OrbitalCatalog } from './catalog-shape';
import type { PassJobInput, PassJobReply, PassJobRequest, PassJobResult, PointPass, SatelliteOutcome } from './pass-job';
import { assertPassQuery, type PassWindow } from './pass-query';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface PassWorkerLike {
  postMessage(message: PassJobRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<PassJobReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface PassLookupQuery {
  point: GeoPoint;
  pastDays?: number;
  futureHours?: number;
}

export interface PassLookupOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface PointPassLookup {
  point: GeoPoint;
  window: PassWindow;
  nowMs: number;
  catalog: { status: CatalogStatus; fetchedAt: number; inventoryVersion: string };
  passes: PointPass[];
  satellites: SatelliteOutcome[];
  computedOn: 'worker' | 'main-thread' | 'none';
}

export interface PassClientDeps {
  createWorker?: () => PassWorkerLike | Promise<PassWorkerLike>;
  loadCatalog?: () => Promise<OrbitalCatalog>;
  now?: () => number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface OrbitalPassClient {
  /** Starting a lookup cancels the previous one, which rejects with an AbortError. */
  lookup(query: PassLookupQuery, options?: PassLookupOptions): Promise<PointPassLookup>;
  dispose(): void;
}

interface PendingJob {
  resolve: (result: PassJobResult) => void;
  reject: (error: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

type WorkerState =
  | { kind: 'idle' }
  | { kind: 'starting'; ready: Promise<PassWorkerLike | null> }
  | { kind: 'ready'; worker: PassWorkerLike }
  | { kind: 'unavailable' };

const abortError = () => new DOMException('Superseded by a newer pass lookup', 'AbortError');

async function defaultCreateWorker(): Promise<PassWorkerLike> {
  const { default: OrbitalPassWorker } = await import('@/workers/orbital-pass.worker?worker');
  return new OrbitalPassWorker() as unknown as PassWorkerLike;
}

async function defaultLoadCatalog(): Promise<OrbitalCatalog> {
  const { loadOrbitalCatalog } = await import('./catalog');
  return loadOrbitalCatalog();
}

function errorFromReply(name: string, message: string): Error {
  return name === 'RangeError' ? new RangeError(message) : Object.assign(new Error(message), { name });
}

export function createOrbitalPassClient(deps: PassClientDeps = {}): OrbitalPassClient {
  const createWorker = deps.createWorker ?? defaultCreateWorker;
  const loadCatalog = deps.loadCatalog ?? defaultLoadCatalog;
  const now = deps.now ?? Date.now;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 10_000;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;

  let state: WorkerState = { kind: 'idle' };
  const pending = new Map<number, PendingJob>();
  let nextId = 1;
  let cancelCurrent: (() => void) | null = null;

  function resetWorker(error: Error): void {
    if (state.kind === 'ready') state.worker.terminate();
    if (state.kind !== 'unavailable') state = { kind: 'idle' };
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  }

  function onReply(reply: PassJobReply): void {
    if (reply.type === 'ready') return;
    const job = pending.get(reply.id);
    if (!job) return;
    if (reply.type === 'progress') {
      job.onProgress?.(reply.done, reply.total);
      return;
    }
    pending.delete(reply.id);
    if (reply.type === 'result') job.resolve(reply.result);
    else job.reject(errorFromReply(reply.name, reply.message));
  }

  /** Resolves null when the worker cannot be constructed or fails to load; rejects when it is not ready in time, download included. */
  function establishWorker(): Promise<PassWorkerLike | null> {
    return new Promise<PassWorkerLike | null>((resolve, reject) => {
      let timedOut = false;
      let worker: PassWorkerLike | null = null;
      const timer = setTimeout(() => {
        timedOut = true;
        worker?.terminate();
        reject(new Error(`Orbital pass worker did not become ready within ${readyTimeoutMs} ms`));
      }, readyTimeoutMs);
      Promise.resolve().then(createWorker).then(
        (created) => {
          if (timedOut) {
            created.terminate();
            return;
          }
          worker = created;
          created.onmessage = (event) => {
            if (event.data.type !== 'ready') return;
            clearTimeout(timer);
            created.onmessage = (next) => onReply(next.data);
            created.onerror = (failure) => resetWorker(new Error(`Orbital pass worker failed: ${failure.message}`));
            resolve(created);
          };
          created.onerror = () => {
            clearTimeout(timer);
            created.terminate();
            resolve(null);
          };
        },
        () => {
          clearTimeout(timer);
          if (!timedOut) resolve(null);
        },
      );
    });
  }

  function readyWorker(): Promise<PassWorkerLike | null> {
    if (state.kind === 'unavailable') return Promise.resolve(null);
    if (state.kind === 'ready') return Promise.resolve(state.worker);
    if (state.kind === 'starting') return state.ready;
    const ready = establishWorker().then(
      (worker) => {
        if (state !== starting) {
          worker?.terminate();
          return null;
        }
        state = worker ? { kind: 'ready', worker } : { kind: 'unavailable' };
        return worker;
      },
      (error: unknown) => {
        if (state === starting) state = { kind: 'idle' };
        throw error;
      },
    );
    const starting: WorkerState = { kind: 'starting', ready };
    state = starting;
    return ready;
  }

  function runOnWorker(worker: PassWorkerLike, input: PassJobInput, options: PassLookupOptions, cancelled: Promise<never>): Promise<PassJobResult> {
    const id = nextId++;
    const job = new Promise<PassJobResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        worker.postMessage({ type: 'cancel', id });
        reject(new Error(`Orbital pass lookup timed out after ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      pending.set(id, {
        onProgress: options.onProgress,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      worker.postMessage({ type: 'compute', id, input });
    });
    cancelled.catch((error: Error) => {
      const superseded = pending.get(id);
      if (!superseded) return;
      pending.delete(id);
      superseded.reject(error);
      worker.postMessage({ type: 'cancel', id });
    });
    return Promise.race([job, cancelled]);
  }

  async function runOnMainThread(input: PassJobInput, options: PassLookupOptions, isCancelled: () => boolean, cancelled: Promise<never>): Promise<PassJobResult> {
    const { runPassJob } = await import('./pass-job');
    const result = await Promise.race([runPassJob(input, { onProgress: options.onProgress, isCancelled }), cancelled]);
    if (!result) throw abortError();
    return result;
  }

  async function lookup(query: PassLookupQuery, options: PassLookupOptions = {}): Promise<PointPassLookup> {
    cancelCurrent?.();
    let isCancelled = false;
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    cancelled.catch(() => {});
    const cancel = () => {
      isCancelled = true;
      rejectCancelled(abortError());
    };
    cancelCurrent = cancel;
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });

    try {
      const nowMs = now();
      const window = {
        startMs: nowMs - (query.pastDays ?? 7) * DAY_MS,
        endMs: nowMs + (query.futureHours ?? 72) * HOUR_MS,
      };
      assertPassQuery(query.point, window);
      const catalog = await Promise.race([loadCatalog(), cancelled]);
      if (isCancelled) throw abortError();
      const base = {
        point: query.point,
        window,
        nowMs,
        catalog: { status: catalog.status, fetchedAt: catalog.fetchedAt, inventoryVersion: catalog.inventoryVersion },
      };
      if (catalog.satellites.length === 0) return { ...base, passes: [], satellites: [], computedOn: 'none' };

      const input: PassJobInput = { point: query.point, window, nowMs, satellites: catalog.satellites };
      const worker = await Promise.race([readyWorker(), cancelled]);
      const result = worker
        ? await runOnWorker(worker, input, options, cancelled)
        : await runOnMainThread(input, options, () => isCancelled, cancelled);
      if (isCancelled) throw abortError();
      return { ...base, ...result, computedOn: worker ? 'worker' : 'main-thread' };
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      if (cancelCurrent === cancel) cancelCurrent = null;
    }
  }

  return {
    lookup,
    dispose() {
      cancelCurrent?.();
      resetWorker(abortError());
    },
  };
}

let sharedClient: OrbitalPassClient | null = null;

export function getOrbitalPassClient(): OrbitalPassClient {
  sharedClient ??= createOrbitalPassClient();
  return sharedClient;
}
