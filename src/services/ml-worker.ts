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
  | { type: 'status-result'; id: string; loadedModels: string[] }
  | { type: 'reset-complete' }
  | { type: 'error'; id?: string; error: string };

class MLWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private requestIdCounter = 0;
  private isReady = false;
  private capabilities: MLCapabilities | null = null;
  private loadedModels = new Set<string>();
  private readyResolve: (() => void) | null = null;
  private modelProgressCallbacks: Map<string, (progress: number) => void> = new Map();

  private static readonly READY_TIMEOUT_MS = 10000;

  /**
   * Initialize the ML worker. Returns false if ML is not supported.
   */
  async init(): Promise<boolean> {
    if (this.isReady) return true;

    // Detect capabilities
    this.capabilities = await detectMLCapabilities();

    if (!this.capabilities.isSupported) {
      console.log('[MLWorker] ML features disabled (device not supported)');
      return false;
    }

    return this.initWorker();
  }

  private initWorker(): Promise<boolean> {
    if (this.worker) return Promise.resolve(this.isReady);

    return new Promise((resolve) => {
      const readyTimeout = setTimeout(() => {
        if (!this.isReady) {
          console.error('[MLWorker] Worker failed to become ready');
          this.cleanup();
          resolve(false);
        }
      }, MLWorkerManager.READY_TIMEOUT_MS);

      try {
        this.worker = new MLWorkerClass();
      } catch (error) {
        console.error('[MLWorker] Failed to create worker:', error);
        this.cleanup();
        resolve(false);
        return;
      }

      this.worker.onmessage = (event: MessageEvent<WorkerResult>) => {
        const data = event.data;

        if (data.type === 'worker-ready') {
          this.isReady = true;
          clearTimeout(readyTimeout);
          this.readyResolve?.();
          resolve(true);
          return;
        }

        if (data.type === 'model-progress') {
          const callback = this.modelProgressCallbacks.get(data.modelId);
          callback?.(data.progress);
          return;
        }

        // Unsolicited model-loaded notification (implicit load inside summarize/sentiment/etc.)
        if (data.type === 'model-loaded' && !('id' in data && data.id)) {
          this.loadedModels.add(data.modelId);
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
              this.loadedModels.add(data.modelId);
              pending.resolve(true);
            } else if (data.type === 'model-unloaded') {
              this.loadedModels.delete(data.modelId);
              pending.resolve(true);
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
            } else if (data.type === 'status-result') {
              pending.resolve(data.loadedModels);
            }
          }
        }
      };

      this.worker.onerror = (error) => {
        console.error('[MLWorker] Error:', error);

        if (!this.isReady) {
          clearTimeout(readyTimeout);
          this.cleanup();
          resolve(false);
          return;
        }

        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Worker error: ${error.message}`));
          this.pendingRequests.delete(id);
        }
      };
    });
  }

  private cleanup(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isReady = false;
    this.pendingRequests.clear();
    this.loadedModels.clear();
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

  /**
   * Load a model by ID
   */
  async loadModel(
    modelId: string,
    onProgress?: (progress: number) => void
  ): Promise<boolean> {
    if (!this.isReady) return false;
    if (this.loadedModels.has(modelId)) return true;

    if (onProgress) {
      this.modelProgressCallbacks.set(modelId, onProgress);
    }

    try {
      return await this.request<boolean>(
        'load-model',
        { modelId },
        ML_THRESHOLDS.modelLoadTimeoutMs
      );
    } finally {
      this.modelProgressCallbacks.delete(modelId);
    }
  }

  /**
   * Unload a model to free memory
   */
  async unloadModel(modelId: string): Promise<boolean> {
    if (!this.isReady || !this.loadedModels.has(modelId)) return false;
    try {
      return await this.request<boolean>('unload-model', { modelId });
    } catch {
      this.loadedModels.delete(modelId);
      return false;
    }
  }

  /**
   * Unload all optional models (non-required)
   */
  async unloadOptionalModels(): Promise<void> {
    const optionalModels = MODEL_CONFIGS.filter(m => !m.required);
    for (const model of optionalModels) {
      if (this.loadedModels.has(model.id)) {
        await this.unloadModel(model.id);
      }
    }
  }

  /**
   * Generate embeddings for texts
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.isReady) throw new Error('ML Worker not ready');
    return this.request<number[][]>('embed', { texts });
  }

  /**
   * Generate summaries for texts
   */
  async summarize(texts: string[], modelId?: string): Promise<string[]> {
    if (!this.isReady) throw new Error('ML Worker not ready');
    return this.request<string[]>('summarize', { texts, ...(modelId && { modelId }) });
  }

  /**
   * Classify sentiment for texts
   */
  async classifySentiment(texts: string[]): Promise<SentimentResult[]> {
    if (!this.isReady) throw new Error('ML Worker not ready');
    return this.request<SentimentResult[]>('classify-sentiment', { texts });
  }

  /**
   * Extract named entities from texts
   */
  async extractEntities(texts: string[]): Promise<NEREntity[][]> {
    if (!this.isReady) throw new Error('ML Worker not ready');
    return this.request<NEREntity[][]>('extract-entities', { texts });
  }

  /**
   * Perform semantic clustering on embeddings
   */
  async semanticCluster(
    embeddings: number[][],
    threshold = ML_THRESHOLDS.semanticClusterThreshold
  ): Promise<number[][]> {
    if (!this.isReady) throw new Error('ML Worker not ready');
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

  /**
   * Get status of loaded models
   */
  async getStatus(): Promise<string[]> {
    if (!this.isReady) return [];
    return this.request<string[]>('status', {});
  }

  /**
   * Reset the worker (unload all models)
   */
  reset(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'reset' });
      this.loadedModels.clear();
    }
  }

  /**
   * Terminate the worker completely
   */
  terminate(): void {
    this.cleanup();
  }

  /**
   * Check if ML features are available
   */
  get isAvailable(): boolean {
    return this.isReady && (this.capabilities?.isSupported ?? false);
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
