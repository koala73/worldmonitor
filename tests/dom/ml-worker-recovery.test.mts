import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockWorkerInstance {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  posted: Array<Record<string, unknown>>;
  terminated: boolean;
  pendingModelLoads: Array<Record<string, unknown>>;
  emitReady(): void;
  emitError(message: string): void;
  respondToNextModelLoad(): void;
}

const workerHarness = vi.hoisted(() => ({
  instances: [] as MockWorkerInstance[],
  autoReady: true,
  autoLoadModels: true,
  failModelLoads: 0,
  deferEmbeds: false,
}));

vi.mock('@/services/ml-capabilities', () => ({
  detectMLCapabilities: vi.fn(async () => ({
    isSupported: true,
    isDesktop: true,
    hasWebGL: true,
    hasWebGPU: false,
    hasSIMD: true,
    hasThreads: true,
    estimatedMemoryMB: 256,
    recommendedExecutionProvider: 'webgl',
    recommendedThreads: 2,
  })),
}));

vi.mock('@/workers/ml.worker?worker', () => ({
  default: class MockMLWorker implements MockWorkerInstance {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    posted: Array<Record<string, unknown>> = [];
    terminated = false;
    pendingModelLoads: Array<Record<string, unknown>> = [];

    constructor() {
      workerHarness.instances.push(this);
      if (workerHarness.autoReady) queueMicrotask(() => this.emitReady());
    }

    emitReady(): void {
      this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent);
    }

    emitError(message: string): void {
      this.onerror?.({ message } as ErrorEvent);
    }

    respondToNextModelLoad(): void {
      const message = this.pendingModelLoads.shift();
      if (!message) throw new Error('No pending model load');
      this.onmessage?.({
        data: { type: 'model-loaded', modelId: message.modelId },
      } as MessageEvent);
      this.onmessage?.({
        data: {
          type: 'model-loaded',
          id: message.id,
          modelId: message.modelId,
        },
      } as MessageEvent);
    }

    postMessage(message: Record<string, unknown>): void {
      this.posted.push(message);
      if (message.type === 'load-model') {
        if (workerHarness.failModelLoads > 0) {
          workerHarness.failModelLoads -= 1;
          queueMicrotask(() => this.onmessage?.({
            data: { type: 'error', id: message.id, error: 'model load failed' },
          } as MessageEvent));
          return;
        }
        if (!workerHarness.autoLoadModels) {
          this.pendingModelLoads.push(message);
          return;
        }
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'model-loaded', modelId: message.modelId },
        } as MessageEvent));
        queueMicrotask(() => this.onmessage?.({
          data: {
            type: 'model-loaded',
            id: message.id,
            modelId: message.modelId,
          },
        } as MessageEvent));
        return;
      }
      if (message.type === 'unload-model') {
        queueMicrotask(() => this.onmessage?.({
          data: {
            type: 'model-unloaded',
            id: message.id,
            modelId: message.modelId,
          },
        } as MessageEvent));
        return;
      }
      if (message.type === 'embed' && !workerHarness.deferEmbeds) {
        queueMicrotask(() => this.onmessage?.({
          data: {
            type: 'embed-result',
            id: message.id,
            embeddings: [[0.25, 0.75]],
          },
        } as MessageEvent));
        return;
      }
      if (message.type === 'status') {
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'status-result', id: message.id, loadedModels: [] },
        } as MessageEvent));
      }
    }

    terminate(): void {
      this.terminated = true;
    }
  },
}));

import { MLWorkerManager } from '@/services/ml-worker';

describe('MLWorkerManager recovery', () => {
  const managers: MLWorkerManager[] = [];
  const createManager = (options: ConstructorParameters<typeof MLWorkerManager>[0] = {}) => {
    const manager = new MLWorkerManager({
      recoveryBaseDelayMs: 1,
      recoveryStableMs: 1_000,
      ...options,
    });
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    workerHarness.instances.length = 0;
    workerHarness.autoReady = true;
    workerHarness.autoLoadModels = true;
    workerHarness.failModelLoads = 0;
    workerHarness.deferEmbeds = false;
    managers.length = 0;
  });

  afterEach(() => {
    managers.forEach(manager => manager.terminate());
  });

  it('restarts once after a post-ready error and restores desired models', async () => {
    const manager = createManager();
    expect(await manager.init()).toBe(true);
    expect(await manager.loadModel('embeddings')).toBe(true);
    expect(workerHarness.instances).toHaveLength(1);

    workerHarness.deferEmbeds = true;
    const failedRequest = manager.embedTexts(['before crash']);
    const firstWorker = workerHarness.instances[0]!;
    await vi.waitFor(() => {
      expect(firstWorker.posted.some(({ type }) => type === 'embed')).toBe(true);
    });
    firstWorker.emitError('runtime crash');
    await expect(failedRequest).rejects.toThrow('Worker error: runtime crash');
    expect(firstWorker.terminated).toBe(true);

    workerHarness.deferEmbeds = false;
    const recoveredA = manager.embedTexts(['after crash A']);
    const recoveredB = manager.embedTexts(['after crash B']);
    await expect(Promise.all([recoveredA, recoveredB])).resolves.toEqual([
      [[0.25, 0.75]],
      [[0.25, 0.75]],
    ]);

    expect(workerHarness.instances).toHaveLength(2);
    const replacement = workerHarness.instances[1]!;
    expect(replacement.posted.map(({ type }) => type)).toEqual([
      'load-model',
      'embed',
      'embed',
    ]);
    expect(manager.loadedModelIds).toContain('embeddings');
    expect(manager.isAvailable).toBe(true);
  });

  it('keeps callers behind the model-restoration barrier', async () => {
    const manager = createManager();
    expect(await manager.init()).toBe(true);
    expect(await manager.loadModel('embeddings')).toBe(true);

    workerHarness.autoLoadModels = false;
    workerHarness.instances[0]!.emitError('runtime crash');
    const operation = manager.embedTexts(['after crash']);
    let settled = false;
    void operation.finally(() => { settled = true; });

    await vi.waitFor(() => {
      expect(workerHarness.instances).toHaveLength(2);
      expect(workerHarness.instances[1]!.pendingModelLoads).toHaveLength(1);
    });
    expect(settled).toBe(false);

    workerHarness.instances[1]!.respondToNextModelLoad();
    await expect(operation).resolves.toEqual([[0.25, 0.75]]);
  });

  it('extends an in-flight restoration barrier when another model is requested', async () => {
    workerHarness.autoLoadModels = false;
    const manager = createManager();
    expect(await manager.init()).toBe(true);

    const embeddings = manager.loadModel('embeddings');
    await vi.waitFor(() => {
      expect(workerHarness.instances[0]!.pendingModelLoads).toHaveLength(1);
    });
    const sentiment = manager.loadModel('sentiment');

    const worker = workerHarness.instances[0]!;
    worker.respondToNextModelLoad();
    await vi.waitFor(() => {
      expect(worker.pendingModelLoads).toHaveLength(1);
      expect(worker.pendingModelLoads[0]!.modelId).toBe('sentiment');
    });
    worker.respondToNextModelLoad();

    await expect(Promise.all([embeddings, sentiment])).resolves.toEqual([true, true]);
    expect(manager.loadedModelIds).toEqual(expect.arrayContaining(['embeddings', 'sentiment']));
  });

  it('retries restoration and fails closed when the desired model stays unavailable', async () => {
    const manager = createManager({ recoveryBaseDelayMs: 1_000 });
    expect(await manager.init()).toBe(true);
    expect(await manager.loadModel('embeddings')).toBe(true);

    workerHarness.failModelLoads = 2;
    workerHarness.instances[0]!.emitError('runtime crash');
    await expect(manager.embedTexts(['after crash'])).rejects.toThrow('ML Worker not ready');

    const replacement = workerHarness.instances[1]!;
    expect(replacement.posted.filter(({ type }) => type === 'load-model')).toHaveLength(2);
    expect(replacement.posted.some(({ type }) => type === 'embed')).toBe(false);
  });

  it('can terminate startup and initialize a fresh worker immediately', async () => {
    workerHarness.autoReady = false;
    const manager = createManager();
    const firstInit = manager.init();
    await vi.waitFor(() => expect(workerHarness.instances).toHaveLength(1));

    const firstWorker = workerHarness.instances[0]!;
    manager.terminate();
    await expect(firstInit).resolves.toBe(false);

    const secondInit = manager.init();
    await vi.waitFor(() => expect(workerHarness.instances).toHaveLength(2));
    firstWorker.emitReady();
    expect(manager.isAvailable).toBe(false);
    workerHarness.instances[1]!.emitReady();
    await expect(secondInit).resolves.toBe(true);
  });

  it('keeps an unload request authoritative during model restoration', async () => {
    const manager = createManager();
    expect(await manager.init()).toBe(true);
    expect(await manager.loadModel('embeddings')).toBe(true);

    workerHarness.autoLoadModels = false;
    workerHarness.instances[0]!.emitError('runtime crash');
    const recovery = manager.getStatus();
    await vi.waitFor(() => {
      expect(workerHarness.instances).toHaveLength(2);
      expect(workerHarness.instances[1]!.pendingModelLoads).toHaveLength(1);
    });

    await expect(manager.unloadModel('embeddings')).resolves.toBe(true);
    const replacement = workerHarness.instances[1]!;
    replacement.respondToNextModelLoad();
    await expect(recovery).resolves.toEqual([]);

    await vi.waitFor(() => {
      expect(replacement.posted.map(({ type }) => type)).toEqual([
        'load-model',
        'unload-model',
        'status',
      ]);
    });
    expect(manager.loadedModelIds).not.toContain('embeddings');
  });

  it('caps automatic recovery after repeated post-ready crashes', async () => {
    const manager = createManager({ recoveryMaxAttempts: 3 });
    expect(await manager.init()).toBe(true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      workerHarness.instances[attempt - 1]!.emitError(`crash ${attempt}`);
      await vi.waitFor(() => {
        expect(workerHarness.instances).toHaveLength(attempt + 1);
        expect(manager.isAvailable).toBe(true);
      });
    }

    workerHarness.instances[3]!.emitError('crash 4');
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(workerHarness.instances).toHaveLength(4);
    expect(manager.isAvailable).toBe(false);
  });
});
