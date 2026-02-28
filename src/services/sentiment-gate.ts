import { mlWorker } from './ml-worker';
import type { NewsItem } from '@/types';

const DEFAULT_THRESHOLD = 0.85;
const BATCH_SIZE = 20; // ML_THRESHOLDS.maxTextsPerBatch from ml-config.ts

/**
 * Filter news items by positive sentiment using DistilBERT-SST2.
 * Returns only items classified as positive with score >= threshold.
 *
 * Graceful degradation:
 * - If mlWorker is not ready/available, returns all items unfiltered
 * - If classification fails, returns all items unfiltered
 * - Batches titles to respect ML worker limits
 *
 * @param items - News items to filter
 * @param threshold - Minimum positive confidence score (default 0.85)
 * @returns Items passing the sentiment filter
 */
export async function filterBySentiment(
  items: NewsItem[],
  threshold = DEFAULT_THRESHOLD
): Promise<NewsItem[]> {
  if (items.length === 0) return [];

  // Check localStorage override for threshold tuning during development
  try {
    const override = localStorage.getItem('positive-threshold');
    if (override) {
      const parsed = parseFloat(override);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        threshold = parsed;
      }
    }
  } catch { /* ignore localStorage errors */ }

  // Graceful degradation: if ML not available, pass all items through
  if (!mlWorker.isAvailable) {
    return items;
  }

  try {
    const titles = items.map(item => item.title);
    const allResults: Array<{ label: string; score: number }> = [];

    // Batch to avoid overwhelming the worker
    for (let i = 0; i < titles.length; i += BATCH_SIZE) {
      const batch = titles.slice(i, i + BATCH_SIZE);
      const batchResults = await mlWorker.classifySentiment(batch);
      allResults.push(...batchResults);
    }

    const passed = items.filter((_, idx) => {
      const result = allResults[idx];
      return result && result.label === 'positive' && result.score >= threshold;
    });

    return passed;
  } catch (err) {
    console.warn('[SentimentGate] Sentiment classification failed, passing all items through:', err);
    return items;
  }
}
