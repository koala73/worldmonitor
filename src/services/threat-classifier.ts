export type IntentLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type SignalCategory =
  | 'funding' | 'hiring' | 'expansion' | 'leadership' | 'technology'
  | 'financial' | 'competitive' | 'partnership' | 'product' | 'general';

export interface IntentClassification {
  level: IntentLevel;
  category: SignalCategory;
  confidence: number;
  source: 'keyword' | 'ml' | 'llm';
  buyingIntentScore?: number;
  recommendedAction?: 'research' | 'monitor' | 'engage' | 'urgent_outreach';
}

import { getCSSColor } from '@/utils';

export const INTENT_COLORS: Record<IntentLevel, string> = {
  critical: '#10b981',
  high: '#3b82f6',
  medium: '#f59e0b',
  low: '#6b7280',
  info: '#8b5cf6',
};

const INTENT_VAR_MAP: Record<IntentLevel, string> = {
  critical: '--intent-critical',
  high: '--intent-high',
  medium: '--intent-medium',
  low: '--intent-low',
  info: '--intent-info',
};

export function getIntentColor(level: string): string {
  return getCSSColor(INTENT_VAR_MAP[level as IntentLevel] || '--text-dim');
}

export const INTENT_PRIORITY: Record<IntentLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

import { t } from '@/services/i18n';

export function getIntentLabel(level: IntentLevel): string {
  return t(`components.intentLabels.${level}`);
}

export const INTENT_LABELS: Record<IntentLevel, string> = {
  critical: 'HOT',
  high: 'WARM',
  medium: 'NURTURE',
  low: 'WATCH',
  info: 'INFO',
};

type KeywordMap = Record<string, SignalCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'series a funding': 'funding',
  'series b funding': 'funding',
  'series c funding': 'funding',
  'series d funding': 'funding',
  'series e funding': 'funding',
  'closed funding round': 'funding',
  'raised million': 'funding',
  'raised billion': 'funding',
  'appointed new cto': 'leadership',
  'appointed new cio': 'leadership',
  'appointed new cfo': 'leadership',
  'new chief technology officer': 'leadership',
  'rfp issued': 'technology',
  'vendor evaluation': 'technology',
  'request for proposal': 'technology',
  'digital transformation': 'technology',
  'cloud migration': 'technology',
  'infrastructure modernization': 'technology',
  'ipo filing': 'financial',
  's-1 filing': 'financial',
  'acquisition announced': 'financial',
  'merger announced': 'financial',
  'urgent hiring': 'hiring',
};

const HIGH_KEYWORDS: KeywordMap = {
  'expansion into': 'expansion',
  'opened new office': 'expansion',
  'new headquarters': 'expansion',
  'market entry': 'expansion',
  'hiring surge': 'hiring',
  'mass hiring': 'hiring',
  'hiring spree': 'hiring',
  'recruiting blitz': 'hiring',
  'tech stack modernization': 'technology',
  'enterprise rollout': 'technology',
  'platform migration': 'technology',
  'new vp engineering': 'leadership',
  'new vp sales': 'leadership',
  'new head of': 'leadership',
  'revenue growth': 'financial',
  'earnings beat': 'financial',
  'raised guidance': 'financial',
  'strategic partnership': 'partnership',
  'selected as vendor': 'competitive',
};

const MEDIUM_KEYWORDS: KeywordMap = {
  'partnership announced': 'partnership',
  'product launch': 'product',
  'quarterly earnings': 'financial',
  'market expansion': 'expansion',
  'international expansion': 'expansion',
  'new market': 'expansion',
  'technology adoption': 'technology',
  'implemented new': 'technology',
  'deployed': 'technology',
  'restructuring': 'financial',
  'cost optimization': 'financial',
  'headcount growth': 'hiring',
  'conference keynote': 'leadership',
  'industry award': 'competitive',
};

const LOW_KEYWORDS: KeywordMap = {
  'thought leadership': 'leadership',
  'industry conference': 'leadership',
  'analyst mention': 'competitive',
  'blog post': 'product',
  'webinar': 'product',
  'podcast appearance': 'leadership',
  'community engagement': 'product',
  'open source contribution': 'technology',
};

const EXCLUSIONS = [
  'recipe', 'cooking', 'celebrity', 'movie', 'tv show', 'sports',
  'game', 'concert', 'festival', 'wedding', 'vacation', 'travel tips',
  'life hack', 'self-care', 'wellness', 'dating', 'diet', 'fitness',
  'fashion', 'horoscope', 'gossip',
];

const SHORT_KEYWORDS = new Set([
  'deployed', 'webinar',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (SHORT_KEYWORDS.has(kw)) {
      re = new RegExp(`\\b${escaped}\\b`);
    } else {
      re = new RegExp(escaped);
    }
    keywordRegexCache.set(kw, re);
  }
  return re;
}

function matchKeywords(
  titleLower: string,
  keywords: KeywordMap
): { keyword: string; category: SignalCategory } | null {
  for (const [kw, cat] of Object.entries(keywords)) {
    if (getKeywordRegex(kw).test(titleLower)) {
      return { keyword: kw, category: cat };
    }
  }
  return null;
}

function deriveRecommendedAction(level: IntentLevel): 'research' | 'monitor' | 'engage' | 'urgent_outreach' {
  switch (level) {
    case 'critical': return 'urgent_outreach';
    case 'high': return 'engage';
    case 'medium': return 'monitor';
    case 'low': return 'research';
    case 'info': return 'research';
  }
}

function deriveBuyingIntentScore(level: IntentLevel, confidence: number): number {
  const baseScores: Record<IntentLevel, number> = {
    critical: 85,
    high: 65,
    medium: 45,
    low: 25,
    info: 10,
  };
  return Math.min(100, Math.round(baseScores[level] + confidence * 15));
}

export function classifyByKeyword(title: string): IntentClassification {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return {
      level: 'info',
      category: 'general',
      confidence: 0.3,
      source: 'keyword',
      buyingIntentScore: 5,
      recommendedAction: 'research',
    };
  }

  // Priority cascade: critical → high → medium → low → info
  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) {
    return {
      level: 'critical',
      category: match.category,
      confidence: 0.9,
      source: 'keyword',
      buyingIntentScore: deriveBuyingIntentScore('critical', 0.9),
      recommendedAction: 'urgent_outreach',
    };
  }

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) {
    return {
      level: 'high',
      category: match.category,
      confidence: 0.8,
      source: 'keyword',
      buyingIntentScore: deriveBuyingIntentScore('high', 0.8),
      recommendedAction: 'engage',
    };
  }

  match = matchKeywords(lower, MEDIUM_KEYWORDS);
  if (match) {
    return {
      level: 'medium',
      category: match.category,
      confidence: 0.7,
      source: 'keyword',
      buyingIntentScore: deriveBuyingIntentScore('medium', 0.7),
      recommendedAction: 'monitor',
    };
  }

  match = matchKeywords(lower, LOW_KEYWORDS);
  if (match) {
    return {
      level: 'low',
      category: match.category,
      confidence: 0.6,
      source: 'keyword',
      buyingIntentScore: deriveBuyingIntentScore('low', 0.6),
      recommendedAction: 'research',
    };
  }

  return {
    level: 'info',
    category: 'general',
    confidence: 0.3,
    source: 'keyword',
    buyingIntentScore: 10,
    recommendedAction: 'research',
  };
}

// Batched AI classification — collects signals then fires parallel classifyIntent RPCs
import {
  IntelligenceServiceClient,
  ApiError,
  type ClassifyEventResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const classifyClient = new IntelligenceServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const VALID_LEVELS: Record<string, IntentLevel> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info',
};

function toIntent(resp: ClassifyEventResponse): IntentClassification | null {
  const c = resp.classification;
  if (!c) return null;
  const level = VALID_LEVELS[c.subcategory] ?? VALID_LEVELS[c.category] ?? null;
  if (!level) return null;
  const confidence = c.confidence || 0.9;
  return {
    level,
    category: c.category as SignalCategory,
    confidence,
    source: 'llm',
    buyingIntentScore: deriveBuyingIntentScore(level, confidence),
    recommendedAction: deriveRecommendedAction(level),
  };
}

type BatchJob = {
  title: string;
  body: string;
  resolve: (v: IntentClassification | null) => void;
  attempts?: number;
};

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500;
const STAGGER_BASE_MS = 2100;
const STAGGER_JITTER_MS = 200;
const MIN_GAP_MS = 2000;
const MAX_RETRIES = 2;
const MAX_QUEUE_LENGTH = 100;
let batchPaused = false;
let batchInFlight = false;
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let lastRequestAt = 0;
const batchQueue: BatchJob[] = [];

async function waitForGap(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_GAP_MS) {
    await new Promise<void>(r => setTimeout(r, MIN_GAP_MS - elapsed));
  }
  const jitter = Math.floor(Math.random() * STAGGER_JITTER_MS * 2) - STAGGER_JITTER_MS;
  const extra = Math.max(0, STAGGER_BASE_MS - MIN_GAP_MS + jitter);
  if (extra > 0) await new Promise<void>(r => setTimeout(r, extra));
  lastRequestAt = Date.now();
}

function flushBatch(): void {
  batchTimer = null;
  if (batchPaused || batchInFlight || batchQueue.length === 0) return;
  batchInFlight = true;

  const batch = batchQueue.splice(0, BATCH_SIZE);
  if (batch.length === 0) { batchInFlight = false; return; }

  (async () => {
    try {
      for (let i = 0; i < batch.length; i++) {
        const job = batch[i]!;
        if (batchPaused) { job.resolve(null); continue; }

        await waitForGap();

        try {
          const resp = await classifyClient.classifyEvent({
            title: job.title, description: job.body, source: '', country: '',
          });
          job.resolve(toIntent(resp));
        } catch (err) {
          if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 429 || err.statusCode >= 500)) {
            batchPaused = true;
            const delay = err.statusCode === 401 ? 120_000 : err.statusCode === 429 ? 60_000 : 30_000;
            console.warn(`[IntentClassify] ${err.statusCode} — pausing AI classification for ${delay / 1000}s`);
            const remaining = batch.slice(i + 1);
            if ((job.attempts ?? 0) < MAX_RETRIES) {
              job.attempts = (job.attempts ?? 0) + 1;
              batchQueue.unshift(job);
            } else {
              job.resolve(null);
            }
            for (let j = remaining.length - 1; j >= 0; j--) {
              batchQueue.unshift(remaining[j]!);
            }
            batchInFlight = false;
            setTimeout(() => { batchPaused = false; scheduleBatch(); }, delay);
            return;
          }
          job.resolve(null);
        }
      }
    } finally {
      if (batchInFlight) {
        batchInFlight = false;
        scheduleBatch();
      }
    }
  })();
}

function scheduleBatch(): void {
  if (batchTimer || batchPaused || batchInFlight || batchQueue.length === 0) return;
  if (batchQueue.length >= BATCH_SIZE) {
    flushBatch();
  } else {
    batchTimer = setTimeout(flushBatch, BATCH_DELAY_MS);
  }
}

export function classifyWithAI(
  title: string,
  body: string
): Promise<IntentClassification | null> {
  return new Promise((resolve) => {
    if (batchQueue.length >= MAX_QUEUE_LENGTH) {
      console.warn(`[IntentClassify] Queue full (${MAX_QUEUE_LENGTH}), dropping classification for: ${title.slice(0, 60)}`);
      resolve(null);
      return;
    }
    batchQueue.push({ title, body, resolve });
    scheduleBatch();
  });
}

export function aggregateIntents(
  items: Array<{ intent?: IntentClassification; tier?: number }>
): IntentClassification {
  const withIntent = items.filter(i => i.intent);
  if (withIntent.length === 0) {
    return {
      level: 'info',
      category: 'general',
      confidence: 0.3,
      source: 'keyword',
      buyingIntentScore: 10,
      recommendedAction: 'research',
    };
  }

  // Level = max across items
  let maxLevel: IntentLevel = 'info';
  let maxPriority = 0;
  for (const item of withIntent) {
    const p = INTENT_PRIORITY[item.intent!.level];
    if (p > maxPriority) {
      maxPriority = p;
      maxLevel = item.intent!.level;
    }
  }

  // Category = most frequent
  const catCounts = new Map<SignalCategory, number>();
  for (const item of withIntent) {
    const cat = item.intent!.category;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  let topCat: SignalCategory = 'general';
  let topCount = 0;
  for (const [cat, count] of catCounts) {
    if (count > topCount) {
      topCount = count;
      topCat = cat;
    }
  }

  // Confidence = weighted avg by source tier (lower tier = higher weight)
  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of withIntent) {
    const weight = item.tier ? (6 - Math.min(item.tier, 5)) : 1;
    weightedSum += item.intent!.confidence * weight;
    weightTotal += weight;
  }

  const confidence = weightTotal > 0 ? weightedSum / weightTotal : 0.5;

  return {
    level: maxLevel,
    category: topCat,
    confidence,
    source: 'keyword',
    buyingIntentScore: deriveBuyingIntentScore(maxLevel, confidence),
    recommendedAction: deriveRecommendedAction(maxLevel),
  };
}
