/**
 * ML Web Worker for ONNX inference using @xenova/transformers
 * Handles embeddings, sentiment analysis, summarization, and NER
 */

import { pipeline, env } from '@xenova/transformers';
import { MODEL_CONFIGS, type ModelConfig } from '@/config/ml-config';
import { storeVectors, searchVectors, getCount, closeDB, sanitizeTitle, type VectorSearchResult } from './vector-db';

// Configure transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;

// Message types
interface InitMessage {
  type: 'init';
  id: string;
}

interface LoadModelMessage {
  type: 'load-model';
  id: string;
  modelId: string;
}

interface UnloadModelMessage {
  type: 'unload-model';
  id: string;
  modelId: string;
}

interface EmbedMessage {
  type: 'embed';
  id: string;
  texts: string[];
}

interface SummarizeMessage {
  type: 'summarize';
  id: string;
  texts: string[];
  modelId?: string;
}

interface SentimentMessage {
  type: 'classify-sentiment';
  id: string;
  texts: string[];
}

interface NERMessage {
  type: 'extract-entities';
  id: string;
  texts: string[];
}

interface SemanticClusterMessage {
  type: 'cluster-semantic';
  id: string;
  embeddings: number[][];
  threshold: number;
}

interface StatusMessage {
  type: 'status';
  id: string;
}

interface ResetMessage {
  type: 'reset';
}

interface VectorStoreIngestMessage {
  type: 'vector-store-ingest';
  id: string;
  items: Array<{
    text: string;
    pubDate: number;
    source: string;
    url: string;
    tags?: string[];
  }>;
}

interface VectorStoreSearchMessage {
  type: 'vector-store-search';
  id: string;
  queries: string[];
  topK: number;
  minScore: number;
}

interface VectorStoreCountMessage {
  type: 'vector-store-count';
  id: string;
}

interface VectorStoreResetMessage {
  type: 'vector-store-reset';
  id: string;
}

type MLWorkerMessage =
  | InitMessage
  | LoadModelMessage
  | UnloadModelMessage
  | EmbedMessage
  | SummarizeMessage
  | SentimentMessage
  | NERMessage
  | SemanticClusterMessage
  | StatusMessage
  | ResetMessage
  | VectorStoreIngestMessage
  | VectorStoreSearchMessage
  | VectorStoreCountMessage
  | VectorStoreResetMessage;

// Loaded pipelines (using unknown since pipeline types vary)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadedPipelines = new Map<string, any>();
const loadingPromises = new Map<string, Promise<void>>();

function getModelConfig(modelId: string): ModelConfig | undefined {
  return MODEL_CONFIGS.find(m => m.id === modelId);
}

async function loadModel(modelId: string): Promise<void> {
  if (loadedPipelines.has(modelId)) return;

  // Prevent concurrent loads - return existing promise if loading
  const existing = loadingPromises.get(modelId);
  if (existing) return existing;

  const config = getModelConfig(modelId);
  if (!config) throw new Error(`Unknown model: ${modelId}`);

  console.log(`[MLWorker] Loading model: ${config.hfModel}`);
  const startTime = Date.now();

  const loadPromise = (async () => {
    // Suppress verbose ONNX Runtime warnings (CleanUnusedInitializersAndNodeArgs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ort = (globalThis as any).ort;
    if (ort?.env) { try { ort.env.logLevel = 'error'; } catch { /* ignore */ } }

    const pipe = await pipeline(config.task, config.hfModel, {
      progress_callback: (progress: { status: string; progress?: number }) => {
        if (progress.status === 'progress' && progress.progress !== undefined) {
          self.postMessage({
            type: 'model-progress',
            modelId,
            progress: progress.progress,
          });
        }
      },
    });

    loadedPipelines.set(modelId, pipe);
    loadingPromises.delete(modelId);
    console.log(`[MLWorker] Model loaded in ${Date.now() - startTime}ms: ${modelId}`);

    // Notify manager that model is now available (no id = unsolicited notification)
    self.postMessage({ type: 'model-loaded', modelId });
  })();

  loadingPromises.set(modelId, loadPromise);
  return loadPromise;
}

function unloadModel(modelId: string): void {
  const pipe = loadedPipelines.get(modelId);
  if (pipe) {
    loadedPipelines.delete(modelId);
    console.log(`[MLWorker] Unloaded model: ${modelId}`);
  }
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  await loadModel('embeddings');
  const pipe = loadedPipelines.get('embeddings')!;

  const results: number[][] = [];
  for (const text of texts) {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }

  return results;
}

async function summarizeTexts(texts: string[], modelId = 'summarization'): Promise<string[]> {
  await loadModel(modelId);
  const pipe = loadedPipelines.get(modelId)!;

  const results: string[] = [];
  for (const text of texts) {
    const output = await pipe(`summarize: ${text}`, {
      max_new_tokens: 64,
      min_length: 10,
    });
    const result = (output as Array<{ generated_text: string }>)[0];
    results.push(result?.generated_text ?? '');
  }

  return results;
}

async function classifySentiment(texts: string[]): Promise<Array<{ label: string; score: number }>> {
  await loadModel('sentiment');
  const pipe = loadedPipelines.get('sentiment')!;

  const results: Array<{ label: string; score: number }> = [];
  for (const text of texts) {
    const output = await pipe(text);
    const result = (output as Array<{ label: string; score: number }>)[0];
    if (result) {
      results.push({
        label: result.label.toLowerCase() === 'positive' ? 'positive' : 'negative',
        score: result.score,
      });
    }
  }

  return results;
}

interface NEREntity {
  text: string;
  type: string;
  confidence: number;
  start: number;
  end: number;
}

async function extractEntities(texts: string[]): Promise<NEREntity[][]> {
  await loadModel('ner');
  const pipe = loadedPipelines.get('ner')!;

  const results: NEREntity[][] = [];
  for (const text of texts) {
    const output = await pipe(text);
    const entities = (output as Array<{
      entity_group: string;
      score: number;
      word: string;
      start: number;
      end: number;
    }>).map(e => ({
      text: e.word,
      type: e.entity_group,
      confidence: e.score,
      start: e.start,
      end: e.end,
    }));
    results.push(entities);
  }

  return results;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

function cosineSimilarityF32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let nA = 0;
  let nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    nA += a[i]! * a[i]!;
    nB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom === 0 ? 0 : dot / denom;
}

function semanticCluster(
  embeddings: number[][],
  threshold: number
): number[][] {
  const n = embeddings.length;
  const clusters: number[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;

    const embeddingI = embeddings[i];
    if (!embeddingI) continue;

    const cluster = [i];
    assigned.add(i);

    for (let j = i + 1; j < n; j++) {
      if (assigned.has(j)) continue;

      const embeddingJ = embeddings[j];
      if (!embeddingJ) continue;

      const similarity = cosineSimilarity(embeddingI, embeddingJ);
      if (similarity >= threshold) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// Worker message handler
self.onmessage = async (event: MessageEvent<MLWorkerMessage>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init': {
        self.postMessage({ type: 'ready', id: message.id });
        break;
      }

      case 'load-model': {
        await loadModel(message.modelId);
        self.postMessage({
          type: 'model-loaded',
          id: message.id,
          modelId: message.modelId,
        });
        break;
      }

      case 'unload-model': {
        unloadModel(message.modelId);
        self.postMessage({
          type: 'model-unloaded',
          id: message.id,
          modelId: message.modelId,
        });
        break;
      }

      case 'embed': {
        const embeddings = await embedTexts(message.texts);
        self.postMessage({
          type: 'embed-result',
          id: message.id,
          embeddings,
        });
        break;
      }

      case 'summarize': {
        const summaries = await summarizeTexts(message.texts, message.modelId);
        self.postMessage({
          type: 'summarize-result',
          id: message.id,
          summaries,
        });
        break;
      }

      case 'classify-sentiment': {
        const results = await classifySentiment(message.texts);
        self.postMessage({
          type: 'sentiment-result',
          id: message.id,
          results,
        });
        break;
      }

      case 'extract-entities': {
        const entities = await extractEntities(message.texts);
        self.postMessage({
          type: 'entities-result',
          id: message.id,
          entities,
        });
        break;
      }

      case 'cluster-semantic': {
        const clusters = semanticCluster(message.embeddings, message.threshold);
        self.postMessage({
          type: 'cluster-semantic-result',
          id: message.id,
          clusters,
        });
        break;
      }

      case 'vector-store-ingest': {
        const EMBED_DIM = 384;
        const embeddings = await embedTexts(message.items.map(i => sanitizeTitle(i.text)));
        const valid: Array<{
          text: string;
          embedding: Float32Array;
          pubDate: number;
          source: string;
          url: string;
          tags?: string[];
        }> = [];
        for (let i = 0; i < message.items.length; i++) {
          const emb = embeddings[i];
          if (!emb || emb.length !== EMBED_DIM) continue;
          const item = message.items[i]!;
          valid.push({
            text: item.text,
            embedding: new Float32Array(emb),
            pubDate: item.pubDate,
            source: item.source,
            url: item.url,
            ...(item.tags?.length ? { tags: item.tags } : {}),
          });
        }
        const stored = valid.length > 0 ? await storeVectors(valid) : 0;
        self.postMessage({
          type: 'vector-store-ingest-result',
          id: message.id,
          stored,
        });
        break;
      }

      case 'vector-store-search': {
        const clampedTopK = Math.max(1, Math.min(20, message.topK));
        const clampedMinScore = Math.max(0, Math.min(1, message.minScore));
        const queries = message.queries.slice(0, 5).map(q => sanitizeTitle(q));
        const queryEmbeddings = await embedTexts(queries);
        const queryF32: Float32Array[] = [];
        for (const emb of queryEmbeddings) {
          if (emb && emb.length > 0) queryF32.push(new Float32Array(emb));
        }
        let results: VectorSearchResult[] = [];
        if (queryF32.length > 0) {
          results = await searchVectors(queryF32, clampedTopK, clampedMinScore, cosineSimilarityF32);
        }
        self.postMessage({
          type: 'vector-store-search-result',
          id: message.id,
          results,
        });
        break;
      }

      case 'vector-store-count': {
        const count = await getCount();
        self.postMessage({
          type: 'vector-store-count-result',
          id: message.id,
          count,
        });
        break;
      }

      case 'vector-store-reset': {
        await closeDB();
        self.postMessage({
          type: 'vector-store-reset-result',
          id: message.id,
        });
        break;
      }

      case 'status': {
        self.postMessage({
          type: 'status-result',
          id: message.id,
          loadedModels: Array.from(loadedPipelines.keys()),
        });
        break;
      }

      case 'reset': {
        loadedPipelines.clear();
        self.postMessage({ type: 'reset-complete' });
        break;
      }
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: (message as { id?: string }).id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Signal ready
self.postMessage({ type: 'worker-ready' });
