/**
 * ML Worker Manager
 * Provides typed async interface to the ML Web Worker for ONNX inference
 */

import { detectMLCapabilities, type MLCapabilities } from './ml-capabilities';
import { ML_THRESHOLDS, MODEL_CONFIGS } from '@/config/ml-config';

// Import worker using Vite's worker syntax
import MLWorkerClass from '@/workers/ml.worker?worker';

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface MLWorkerManagerOptions {
  readyTimeoutMs?: number;
  recoveryBaseDelayMs?: number;
  recoveryStableMs?: number;
  recoveryMaxAttempts?: number;
  modelRestoreMaxAttempts?: number;
}

interface WorkerStartup {
  generation: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (ready: boolean) => void;
}

interface NEREntity {
  text: string;
  type: string;
  confidence: number;
  start: number;
  end: number;
}

interface SentimentResult {
  label: 'positive' | 'negative' | 'neutral';
  score: number;
}

export interface VectorSearchResult {
  text: string;
  pubDate: number;
  source: string;
  score: number;
}

type WorkerResult =
  | { type: 'worker-ready' }
  | { type: 'ready'; id: string }
  | { type: 'model-loaded'; id: string; modelId: string }
  | { type: 'model-unloaded'; id: string; modelId: string }
  | { type: 'model-progress'; modelId: string; progress: number }
  | { type: 'embed-result'; id: string; embeddings: number[][] }
  | { type: 'summarize-result'; id: string; summaries: string[] }
  | { type: 'sentiment-result'; id: string; results: SentimentResult[] }
  | { type: 'entities-result'; id: string; entities: NEREntity[][] }
  | { type: 'cluster-semantic-result'; id: string; clusters: number[][] }
  | { type: 'vector-store-ingest-result'; id: string; stored: number }
  | { type: 'vector-store-search-result'; id: string; results: VectorSearchResult[] }
  | { type: 'vector-store-count-result'; id: string; count: number }
  | { type: 'vector-store-reset-result'; id: string }
  | { type: 'status-result'; id: string; loadedModels: string[] }
  | { type: 'reset-complete' }
  | { type: 'error'; id?: string; error: string };

export class MLWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private requestIdCounter = 0;
  private isReady = false;
  private enabled = false;
  private initPromise: Promise<boolean> | null = null;
  private recoveryScheduled = false;
  private recoveryBlocked = false;
  private recoveryAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryResetTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryPromise: Promise<boolean> | null = null;
  private recoveryResolve: ((recovered: boolean) => void) | null = null;
  private lifecycleGeneration = 0;
  private workerGeneration = 0;
  private startup: WorkerStartup | null = null;
  private capabilities: MLCapabilities | null = null;
  private loadedModels = new Set<string>();
  private desiredModels = new Set<string>();
  private pendingModelUnloads = new Map<string, Promise<boolean>>();
  private modelProgressCallbacks: Map<string, (progress: number) => void> = new Map();

  private readonly readyTimeoutMs: number;
  private readonly recoveryBaseDelayMs: number;
  private readonly recoveryStableMs: number;
  private readonly recoveryMaxAttempts: number;
  private readonly modelRestoreMaxAttempts: number;

  constructor(options: MLWorkerManagerOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.recoveryBaseDelayMs = options.recoveryBaseDelayMs ?? 1_000;
    this.recoveryStableMs = options.recoveryStableMs ?? 30_000;
    this.recoveryMaxAttempts = options.recoveryMaxAttempts ?? 3;
    this.modelRestoreMaxAttempts = options.modelRestoreMaxAttempts ?? 2;
  }

  /**
   * Initialize the ML worker. Returns false if ML is not supported.
   */
  async init(): Promise<boolean> {
    if (!this.enabled || this.recoveryBlocked) {
      this.clearRecoveryTimer();
      this.recoveryAttempts = 0;
      this.recoveryBlocked = false;
    }
    this.enabled = true;
    return this.ensureReady();
  }

  private async ensureReady(): Promise<boolean> {
    if (!this.enabled || this.recoveryBlocked) return false;
    if (this.recoveryPromise) {
      if (!await this.recoveryPromise) return false;
    }
    return this.ensureReadyNow();
  }

  private async ensureReadyNow(): Promise<boolean> {
    while (this.enabled && !this.recoveryBlocked) {
      if (this.isReady && this.hasRestoredDesiredModels()) return true;

      const initialization = this.initPromise
        ?? this.initializeAndRestore(this.lifecycleGeneration);
      this.initPromise = initialization;
      try {
        if (!await initialization) return false;
      } finally {
        if (this.initPromise === initialization) this.initPromise = null;
      }
    }
    return false;
  }

  private async initializeAndRestore(lifecycleGeneration: number): Promise<boolean> {
    this.capabilities ??= await detectMLCapabilities();

    if (
      lifecycleGeneration !== this.lifecycleGeneration
      || !this.enabled
      || !this.capabilities.isSupported
    ) {
      return false;
    }

    if (!await this.initWorker()) return false;
    if (lifecycleGeneration !== this.lifecycleGeneration || !this.enabled) return false;

    return this.restoreDesiredModels();
  }

  private initWorker(): Promise<boolean> {
    if (this.worker) return Promise.resolve(this.isReady);

    return new Promise((resolve) => {
      const generation = ++this.workerGeneration;
      let settled = false;
      const finishStartup = (ready: boolean) => {
        if (settled) return;
        settled = true;
        if (this.startup?.generation === generation) {
          clearTimeout(this.startup.timeout);
          this.startup = null;
        }
        resolve(ready);
      };
      const readyTimeout = setTimeout(() => {
        if (this.startup?.generation === generation && !this.isReady) {
          console.error('[MLWorker] Worker failed to become ready');
          this.cleanup(false, new Error('ML Worker failed to become ready'));
        }
      }, this.readyTimeoutMs);
      this.startup = { generation, timeout: readyTimeout, resolve: finishStartup };

      let worker: Worker;
      try {
        worker = new MLWorkerClass();
        this.worker = worker;
      } catch (error) {
        console.error('[MLWorker] Failed to create worker:', error);
        this.cleanup(false, new Error('ML Worker failed to start'));
        return;
      }

      worker.onmessage = (event: MessageEvent<WorkerResult>) => {
        if (generation !== this.workerGeneration || worker !== this.worker) return;
        const data = event.data;

        if (data.type === 'worker-ready') {
          this.isReady = true;
          finishStartup(true);
          return;
        }

        if (data.type === 'model-progress') {
          const callback = this.modelProgressCallbacks.get(data.modelId);
          callback?.(data.progress);
          return;
        }

        // Unsolicited model-loaded notification (implicit load inside summarize/sentiment/etc.)
        if (data.type === 'model-loaded' && !('id' in data && data.id)) {
          this.acceptModelLoaded(data.modelId);
          return;
        }

        if (data.type === 'reset-complete') {
          this.loadedModels.clear();
          return;
        }

        if (data.type === 'error') {
          const pending = data.id ? this.pendingRequests.get(data.id) : null;
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(data.id!);
            pending.reject(new Error(data.error));
          } else {
            console.error('[MLWorker] Error:', data.error);
          }
          return;
        }

        if ('id' in data && data.id) {
          const pending = this.pendingRequests.get(data.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(data.id);

            if (data.type === 'model-loaded') {
              pending.resolve(this.acceptModelLoaded(data.modelId));
            } else if (data.type === 'model-unloaded') {
              this.loadedModels.delete(data.modelId);
              const shouldRemainUnloaded = !this.desiredModels.has(data.modelId);
              pending.resolve(shouldRemainUnloaded);
              if (!shouldRemainUnloaded) void this.ensureReady();
            } else if (data.type === 'embed-result') {
              pending.resolve(data.embeddings);
            } else if (data.type === 'summarize-result') {
              pending.resolve(data.summaries);
            } else if (data.type === 'sentiment-result') {
              pending.resolve(data.results);
            } else if (data.type === 'entities-result') {
              pending.resolve(data.entities);
            } else if (data.type === 'cluster-semantic-result') {
              pending.resolve(data.clusters);
            } else if (data.type === 'vector-store-ingest-result') {
              pending.resolve(data.stored);
            } else if (data.type === 'vector-store-search-result') {
              pending.resolve(data.results);
            } else if (data.type === 'vector-store-count-result') {
              pending.resolve(data.count);
            } else if (data.type === 'vector-store-reset-result') {
              pending.resolve(true);
            } else if (data.type === 'status-result') {
              pending.resolve(data.loadedModels);
            }
          }
        }
      };

      worker.onerror = (error) => {
        if (generation !== this.workerGeneration || worker !== this.worker) return;
        console.error('[MLWorker] Error:', error);

        if (!this.isReady) {
          this.cleanup(false, new Error(`Worker error: ${error.message}`));
          return;
        }

        this.cleanup(false, new Error(`Worker error: ${error.message}`));
        this.scheduleRecovery();
      };
    });
  }

  private hasRestoredDesiredModels(): boolean {
    return Array.from(this.desiredModels).every(modelId => this.loadedModels.has(modelId));
  }

  private async restoreDesiredModels(): Promise<boolean> {
    while (this.isReady) {
      const unrestoredModels = Array.from(this.desiredModels)
        .filter(modelId => !this.loadedModels.has(modelId));
      if (unrestoredModels.length === 0) return true;

      for (const modelId of unrestoredModels) {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < this.modelRestoreMaxAttempts; attempt += 1) {
          if (!this.desiredModels.has(modelId)) break;
          try {
            const restored = await this.request<boolean>(
              'load-model',
              { modelId },
              ML_THRESHOLDS.modelLoadTimeoutMs,
            );
            if (restored && this.loadedModels.has(modelId)) break;
          } catch (error) {
            lastError = error;
          }
        }

        if (this.desiredModels.has(modelId) && !this.loadedModels.has(modelId)) {
          console.error(`[MLWorker] Failed to restore model ${modelId}:`, lastError);
          return false;
        }
      }
    }

    return false;
  }

  private acceptModelLoaded(modelId: string): boolean {
    if (this.desiredModels.has(modelId)) {
      this.loadedModels.add(modelId);
      return true;
    }

    this.loadedModels.delete(modelId);
    void this.requestModelUnload(modelId).catch(() => {
      // The desired state is already unloaded. A failed best-effort unload is
      // harmless because the worker will be discarded on its next failure.
    });
    return false;
  }

  private scheduleRecovery(): void {
    if (!this.enabled || this.recoveryScheduled || this.recoveryBlocked) return;
    if (this.recoveryAttempts >= this.recoveryMaxAttempts) {
      this.recoveryBlocked = true;
      console.error('[MLWorker] Automatic recovery stopped after repeated failures');
      return;
    }

    this.recoveryAttempts += 1;
    this.recoveryScheduled = true;
    const recoveryGeneration = this.lifecycleGeneration;
    let resolveAttempt: (recovered: boolean) => void = () => {};
    const recoveryPromise = new Promise<boolean>((resolve) => {
      resolveAttempt = resolve;
    });
    this.recoveryPromise = recoveryPromise;
    this.recoveryResolve = resolveAttempt;
    const delay = this.recoveryBaseDelayMs * (2 ** (this.recoveryAttempts - 1));
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      const currentInitialization = this.initPromise;
      void (async () => {
        let recovered = false;
        try {
          await currentInitialization?.catch(() => false);
          if (this.enabled && recoveryGeneration === this.lifecycleGeneration) {
            recovered = this.isReady && this.hasRestoredDesiredModels()
              ? true
              : await this.ensureReadyNow().catch(() => false);
          }
        } finally {
          const isStaleRecovery =
            recoveryGeneration !== this.lifecycleGeneration
            || this.recoveryPromise !== recoveryPromise;
          if (isStaleRecovery) {
            resolveAttempt(false);
          } else {
            this.recoveryScheduled = false;
            this.recoveryPromise = null;
            this.recoveryResolve = null;
            resolveAttempt(recovered);
            if (recovered) {
              this.scheduleRecoveryBudgetReset();
            } else if (this.enabled) {
              this.scheduleRecovery();
            }
          }
        }
      })();
    }, delay);
    this.recoveryTimer.unref?.();
  }

  private scheduleRecoveryBudgetReset(): void {
    if (this.recoveryResetTimer) clearTimeout(this.recoveryResetTimer);
    this.recoveryResetTimer = setTimeout(() => {
      this.recoveryResetTimer = null;
      if (this.enabled && this.isReady && this.hasRestoredDesiredModels()) {
        this.recoveryAttempts = 0;
        this.recoveryBlocked = false;
      }
    }, this.recoveryStableMs);
    this.recoveryResetTimer.unref?.();
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (this.recoveryResetTimer) {
      clearTimeout(this.recoveryResetTimer);
      this.recoveryResetTimer = null;
    }
    this.recoveryScheduled = false;
    this.recoveryPromise = null;
    const resolveRecovery = this.recoveryResolve;
    this.recoveryResolve = null;
    resolveRecovery?.(false);
  }

  private cancelStartup(): void {
    const startup = this.startup;
    if (!startup) return;
    clearTimeout(startup.timeout);
    this.startup = null;
    startup.resolve(false);
  }

  private cleanup(clearDesiredModels = false, pendingError = new Error('ML Worker stopped')): void {
    this.workerGeneration += 1;
    this.cancelStartup();
    if (this.recoveryResetTimer) {
      clearTimeout(this.recoveryResetTimer);
      this.recoveryResetTimer = null;
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(pendingError);
      this.pendingRequests.delete(id);
    }
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.isReady = false;
    this.loadedModels.clear();
    this.pendingModelUnloads.clear();
    this.modelProgressCallbacks.clear();
    if (clearDesiredModels) this.desiredModels.clear();
  }

  private generateRequestId(): string {
    return `ml-${++this.requestIdCounter}-${Date.now()}`;
  }

  private request<T>(
    type: string,
    data: Record<string, unknown>,
    timeoutMs = ML_THRESHOLDS.inferenceTimeoutMs
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.isReady) {
        reject(new Error('ML Worker not initialized'));
        return;
      }

      const id = this.generateRequestId();
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ML request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.worker.postMessage({ type, id, ...data });
    });
  }

  private requestModelUnload(modelId: string): Promise<boolean> {
    const pending = this.pendingModelUnloads.get(modelId);
    if (pending) return pending;

    const unload = this.request<boolean>('unload-model', { modelId });
    const tracked = unload.finally(() => {
      if (this.pendingModelUnloads.get(modelId) === tracked) {
        this.pendingModelUnloads.delete(modelId);
      }
    });
    this.pendingModelUnloads.set(modelId, tracked);
    return tracked;
  }

  /**
   * Load a model by ID
   */
  async loadModel(
    modelId: string,
    onProgress?: (progress: number) => void
  ): Promise<boolean> {
    this.desiredModels.add(modelId);
    if (onProgress) {
      this.modelProgressCallbacks.set(modelId, onProgress);
    }

    try {
      return await this.ensureReady() && this.loadedModels.has(modelId);
    } finally {
      this.modelProgressCallbacks.delete(modelId);
    }
  }

  /**
   * Unload a model to free memory
   */
  async unloadModel(modelId: string): Promise<boolean> {
    const wasDesired = this.desiredModels.delete(modelId);
    if (!this.isReady || !this.loadedModels.has(modelId)) return wasDesired;
    try {
      return await this.requestModelUnload(modelId);
    } catch {
      return false;
    }
  }

  /**
   * Unload all optional models (non-required)
   */
  async unloadOptionalModels(): Promise<void> {
    const optionalModels = MODEL_CONFIGS.filter(m => !m.required);
    for (const model of optionalModels) {
      if (this.loadedModels.has(model.id) || this.desiredModels.has(model.id)) {
        await this.unloadModel(model.id);
      }
    }
  }

  /**
   * Generate embeddings for texts
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    this.desiredModels.add('embeddings');
    if (!await this.ensureReady()) throw new Error('ML Worker not ready');
    return this.request<number[][]>('embed', { texts });
  }

  /**
   * Generate summaries for texts
   */
  async summarize(texts: string[], modelId?: string): Promise<string[]> {
    this.desiredModels.add(modelId ?? 'summarization');
    if (!await this.ensureReady()) throw new Error('ML Worker not ready');
    return this.request<string[]>('summarize', { texts, ...(modelId && { modelId }) });
  }

  /**
   * Classify sentiment for texts
   */
  async classifySentiment(texts: string[]): Promise<SentimentResult[]> {
    this.desiredModels.add('sentiment');
    if (!await this.ensureReady()) throw new Error('ML Worker not ready');
    return this.request<SentimentResult[]>('classify-sentiment', { texts });
  }

  /**
   * Extract named entities from texts
   */
  async extractEntities(texts: string[]): Promise<NEREntity[][]> {
    this.desiredModels.add('ner');
    if (!await this.ensureReady()) throw new Error('ML Worker not ready');
    return this.request<NEREntity[][]>('extract-entities', { texts });
  }

  /**
   * Perform semantic clustering on embeddings
   */
  async semanticCluster(
    embeddings: number[][],
    threshold = ML_THRESHOLDS.semanticClusterThreshold
  ): Promise<number[][]> {
    if (!await this.ensureReady()) throw new Error('ML Worker not ready');
    return this.request<number[][]>('cluster-semantic', { embeddings, threshold });
  }

  /**
   * High-level: Cluster items by semantic similarity
   */
  async clusterBySemanticSimilarity(
    items: Array<{ id: string; text: string }>,
    threshold = ML_THRESHOLDS.semanticClusterThreshold
  ): Promise<string[][]> {
    const embeddings = await this.embedTexts(items.map(i => i.text));
    const clusterIndices = await this.semanticCluster(embeddings, threshold);
    return clusterIndices.map(cluster =>
      cluster.map(idx => items[idx]?.id).filter((id): id is string => id !== undefined)
    );
  }

  async vectorStoreIngest(
    items: Array<{ text: string; pubDate: number; source: string; url: string; tags?: string[] }>
  ): Promise<number> {
    this.desiredModels.add('embeddings');
    if (!await this.ensureReady()) return 0;
    return this.request<number>('vector-store-ingest', { items });
  }

  async vectorStoreSearch(
    queries: string[],
    topK = 5,
    minScore = 0.3,
  ): Promise<VectorSearchResult[]> {
    if (!await this.ensureReady() || !this.loadedModels.has('embeddings')) return [];
    return this.request<VectorSearchResult[]>('vector-store-search', { queries, topK, minScore });
  }

  async vectorStoreCount(): Promise<number> {
    if (!await this.ensureReady()) return 0;
    return this.request<number>('vector-store-count', {});
  }

  async vectorStoreReset(): Promise<boolean> {
    if (!await this.ensureReady()) return false;
    return this.request<boolean>('vector-store-reset', {});
  }

  async getStatus(): Promise<string[]> {
    if (!await this.ensureReady()) return [];
    return this.request<string[]>('status', {});
  }

  /**
   * Reset the worker (unload all models)
   */
  reset(): void {
    this.desiredModels.clear();
    if (this.worker) {
      this.worker.postMessage({ type: 'reset' });
    }
  }

  /**
   * Terminate the worker completely
   */
  terminate(): void {
    this.enabled = false;
    this.lifecycleGeneration += 1;
    this.clearRecoveryTimer();
    this.cleanup(true, new Error('ML Worker terminated'));
    this.initPromise = null;
    this.recoveryAttempts = 0;
    this.recoveryBlocked = false;
  }

  /**
   * Check if ML features are available
   */
  get isAvailable(): boolean {
    return this.enabled
      && !this.recoveryBlocked
      && this.isReady
      && this.hasRestoredDesiredModels()
      && (this.capabilities?.isSupported ?? false);
  }

  /**
   * Get detected capabilities
   */
  get mlCapabilities(): MLCapabilities | null {
    return this.capabilities;
  }

  /**
   * Get list of currently loaded models
   */
  get loadedModelIds(): string[] {
    return Array.from(this.loadedModels);
  }

  /**
   * Check if a specific model is already loaded (no waiting)
   */
  isModelLoaded(modelId: string): boolean {
    return this.loadedModels.has(modelId);
  }
}

// Export singleton instance
export const mlWorker = new MLWorkerManager();
