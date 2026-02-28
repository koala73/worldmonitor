export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type EventCategory =
  | 'conflict' | 'protest' | 'disaster' | 'diplomatic' | 'economic'
  | 'terrorism' | 'cyber' | 'health' | 'environmental' | 'military'
  | 'crime' | 'infrastructure' | 'tech' | 'general';

export interface ThreatClassification {
  level: ThreatLevel;
  category: EventCategory;
  confidence: number;
  source: 'keyword' | 'ml' | 'llm';
}

import { getCSSColor } from '@/utils';

/** @deprecated Use getThreatColor() instead for runtime CSS variable reads */
export const THREAT_COLORS: Record<ThreatLevel, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#22c55e',
  info: '#3b82f6',
};

const THREAT_VAR_MAP: Record<ThreatLevel, string> = {
  critical: '--threat-critical',
  high: '--threat-high',
  medium: '--threat-medium',
  low: '--threat-low',
  info: '--threat-info',
};

export function getThreatColor(level: string): string {
  return getCSSColor(THREAT_VAR_MAP[level as ThreatLevel] || '--text-dim');
}

export const THREAT_PRIORITY: Record<ThreatLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

import { t } from '@/services/i18n';

export function getThreatLabel(level: ThreatLevel): string {
  return t(`components.threatLabels.${level}`);
}

export const THREAT_LABELS: Record<ThreatLevel, string> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO',
};

type KeywordMap = Record<string, EventCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'nuclear strike': 'military',
  'nuclear attack': 'military',
  'nuclear war': 'military',
  'invasion': 'conflict',
  'declaration of war': 'conflict',
  'declares war': 'conflict',
  'all-out war': 'conflict',
  'full-scale war': 'conflict',
  'martial law': 'military',
  'coup': 'military',
  'coup attempt': 'military',
  'genocide': 'conflict',
  'ethnic cleansing': 'conflict',
  'chemical attack': 'terrorism',
  'biological attack': 'terrorism',
  'dirty bomb': 'terrorism',
  'mass casualty': 'conflict',
  'massive strikes': 'military',
  'military strikes': 'military',
  'retaliatory strikes': 'military',
  'launches strikes': 'military',
  'strikes on iran': 'military',
  'strikes iran': 'military',
  'bombs iran': 'military',
  'attacks iran': 'military',
  'attack on iran': 'military',
  'attack iran': 'military',
  'attacked iran': 'military',
  'attack against iran': 'military',
  'bombing iran': 'military',
  'bombed iran': 'military',
  'war with iran': 'conflict',
  'war on iran': 'conflict',
  'war against iran': 'conflict',
  'pandemic declared': 'health',
  'health emergency': 'health',
  'nato article 5': 'military',
  'evacuation order': 'disaster',
  'meltdown': 'disaster',
  'nuclear meltdown': 'disaster',
  'major combat operations': 'military',
  'declared war': 'conflict',
};

const HIGH_KEYWORDS: KeywordMap = {
  'war': 'conflict',
  'armed conflict': 'conflict',
  'airstrike': 'conflict',
  'airstrikes': 'conflict',
  'air strike': 'conflict',
  'air strikes': 'conflict',
  'drone strike': 'conflict',
  'drone strikes': 'conflict',
  'strikes': 'conflict',
  'missile': 'military',
  'missile launch': 'military',
  'missiles fired': 'military',
  'troops deployed': 'military',
  'military escalation': 'military',
  'military operation': 'military',
  'ground offensive': 'military',
  'bombing': 'conflict',
  'bombardment': 'conflict',
  'shelling': 'conflict',
  'casualties': 'conflict',
  'killed in': 'conflict',
  'hostage': 'terrorism',
  'terrorist': 'terrorism',
  'terror attack': 'terrorism',
  'assassination': 'crime',
  'cyber attack': 'cyber',
  'ransomware': 'cyber',
  'data breach': 'cyber',
  'sanctions': 'economic',
  'embargo': 'economic',
  'earthquake': 'disaster',
  'tsunami': 'disaster',
  'hurricane': 'disaster',
  'typhoon': 'disaster',
  'strike on': 'conflict',
  'strikes on': 'conflict',
  'attack on': 'conflict',
  'attack against': 'conflict',
  'attacks on': 'conflict',
  'launched attack': 'conflict',
  'launched attacks': 'conflict',
  'launches attack': 'conflict',
  'launches attacks': 'conflict',
  'explosions': 'conflict',
  'military operations': 'military',
  'combat operations': 'military',
  'retaliatory strike': 'military',
  'retaliatory attack': 'military',
  'retaliatory attacks': 'military',
  'preemptive strike': 'military',
  'preemptive attack': 'military',
  'preventive attack': 'military',
  'preventative attack': 'military',
  'military offensive': 'military',
  'ballistic missile': 'military',
  'cruise missile': 'military',
  'air defense intercepted': 'military',
  'forces struck': 'conflict',
};

const MEDIUM_KEYWORDS: KeywordMap = {
  'protest': 'protest',
  'protests': 'protest',
  'riot': 'protest',
  'riots': 'protest',
  'unrest': 'protest',
  'demonstration': 'protest',
  'strike action': 'protest',
  'military exercise': 'military',
  'naval exercise': 'military',
  'arms deal': 'military',
  'weapons sale': 'military',
  'diplomatic crisis': 'diplomatic',
  'ambassador recalled': 'diplomatic',
  'expel diplomats': 'diplomatic',
  'trade war': 'economic',
  'tariff': 'economic',
  'recession': 'economic',
  'inflation': 'economic',
  'market crash': 'economic',
  'flood': 'disaster',
  'flooding': 'disaster',
  'wildfire': 'disaster',
  'volcano': 'disaster',
  'eruption': 'disaster',
  'outbreak': 'health',
  'epidemic': 'health',
  'infection spread': 'health',
  'oil spill': 'environmental',
  'pipeline explosion': 'infrastructure',
  'blackout': 'infrastructure',
  'power outage': 'infrastructure',
  'internet outage': 'infrastructure',
  'derailment': 'infrastructure',
};

const LOW_KEYWORDS: KeywordMap = {
  'election': 'diplomatic',
  'vote': 'diplomatic',
  'referendum': 'diplomatic',
  'summit': 'diplomatic',
  'treaty': 'diplomatic',
  'agreement': 'diplomatic',
  'negotiation': 'diplomatic',
  'talks': 'diplomatic',
  'peacekeeping': 'diplomatic',
  'humanitarian aid': 'diplomatic',
  'ceasefire': 'diplomatic',
  'peace treaty': 'diplomatic',
  'climate change': 'environmental',
  'emissions': 'environmental',
  'pollution': 'environmental',
  'deforestation': 'environmental',
  'drought': 'environmental',
  'vaccine': 'health',
  'vaccination': 'health',
  'disease': 'health',
  'virus': 'health',
  'public health': 'health',
  'covid': 'health',
  'interest rate': 'economic',
  'gdp': 'economic',
  'unemployment': 'economic',
  'regulation': 'economic',
};

const TECH_HIGH_KEYWORDS: KeywordMap = {
  'major outage': 'infrastructure',
  'service down': 'infrastructure',
  'global outage': 'infrastructure',
  'zero-day': 'cyber',
  'critical vulnerability': 'cyber',
  'supply chain attack': 'cyber',
  'mass layoff': 'economic',
};

const TECH_MEDIUM_KEYWORDS: KeywordMap = {
  'outage': 'infrastructure',
  'breach': 'cyber',
  'hack': 'cyber',
  'vulnerability': 'cyber',
  'layoff': 'economic',
  'layoffs': 'economic',
  'antitrust': 'economic',
  'monopoly': 'economic',
  'ban': 'economic',
  'shutdown': 'infrastructure',
};

const TECH_LOW_KEYWORDS: KeywordMap = {
  'ipo': 'economic',
  'funding': 'economic',
  'acquisition': 'economic',
  'merger': 'economic',
  'launch': 'tech',
  'release': 'tech',
  'update': 'tech',
  'partnership': 'economic',
  'startup': 'tech',
  'ai model': 'tech',
  'open source': 'tech',
};

const EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
  'strikes deal', 'strikes agreement', 'strikes partnership',
];

const SHORT_KEYWORDS = new Set([
  'war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp',
  'virus', 'disease', 'flood', 'strikes',
]);

const TRAILING_BOUNDARY_KEYWORDS = new Set([
  'attack iran', 'attacked iran', 'attack on iran', 'attack against iran',
  'bombing iran', 'bombed iran', 'strikes iran', 'attacks iran',
  'bombs iran', 'war on iran', 'war with iran', 'war against iran',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (SHORT_KEYWORDS.has(kw)) {
      re = new RegExp(`\\b${escaped}\\b`);
    } else if (TRAILING_BOUNDARY_KEYWORDS.has(kw)) {
      re = new RegExp(`${escaped}(?![\\w-])`);
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
): { keyword: string; category: EventCategory } | null {
  for (const [kw, cat] of Object.entries(keywords)) {
    if (getKeywordRegex(kw).test(titleLower)) {
      return { keyword: kw, category: cat };
    }
  }
  return null;
}

export function classifyByKeyword(title: string, variant = 'full'): ThreatClassification {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  const isTech = variant === 'tech';

  // Priority cascade: critical → high → medium → low → info
  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) return { level: 'critical', category: match.category, confidence: 0.9, source: 'keyword' };

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) return { level: 'high', category: match.category, confidence: 0.8, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_HIGH_KEYWORDS);
    if (match) return { level: 'high', category: match.category, confidence: 0.75, source: 'keyword' };
  }

  match = matchKeywords(lower, MEDIUM_KEYWORDS);
  if (match) return { level: 'medium', category: match.category, confidence: 0.7, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_MEDIUM_KEYWORDS);
    if (match) return { level: 'medium', category: match.category, confidence: 0.65, source: 'keyword' };
  }

  match = matchKeywords(lower, LOW_KEYWORDS);
  if (match) return { level: 'low', category: match.category, confidence: 0.6, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_LOW_KEYWORDS);
    if (match) return { level: 'low', category: match.category, confidence: 0.55, source: 'keyword' };
  }

  return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
}

// Batched AI classification — collects headlines then fires parallel sebuf RPCs
import {
  IntelligenceServiceClient,
  ApiError,
  type ClassifyEventResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const classifyClient = new IntelligenceServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const VALID_LEVELS: Record<string, ThreatLevel> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info',
};

function toThreat(resp: ClassifyEventResponse): ThreatClassification | null {
  const c = resp.classification;
  if (!c) return null;
  // Raw level preserved in subcategory by the handler
  const level = VALID_LEVELS[c.subcategory] ?? VALID_LEVELS[c.category] ?? null;
  if (!level) return null;
  return {
    level,
    category: c.category as EventCategory,
    confidence: c.confidence || 0.9,
    source: 'llm',
  };
}

type BatchJob = {
  title: string;
  variant: string;
  resolve: (v: ThreatClassification | null) => void;
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
            title: job.title, description: '', source: '', country: '',
          });
          job.resolve(toThreat(resp));
        } catch (err) {
          if (err instanceof ApiError && (err.statusCode === 429 || err.statusCode >= 500)) {
            batchPaused = true;
            const delay = err.statusCode === 429 ? 60_000 : 30_000;
            console.warn(`[Classify] ${err.statusCode} — pausing AI classification for ${delay / 1000}s`);
            const remaining = batch.slice(i + 1);
            // Failed job: increment attempts, requeue if under limit
            if ((job.attempts ?? 0) < MAX_RETRIES) {
              job.attempts = (job.attempts ?? 0) + 1;
              batchQueue.unshift(job);
            } else {
              job.resolve(null);
            }
            // Remaining jobs never hit the API — requeue without burning attempts
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
  variant: string
): Promise<ThreatClassification | null> {
  return new Promise((resolve) => {
    if (batchQueue.length >= MAX_QUEUE_LENGTH) {
      console.warn(`[Classify] Queue full (${MAX_QUEUE_LENGTH}), dropping classification for: ${title.slice(0, 60)}`);
      resolve(null);
      return;
    }
    batchQueue.push({ title, variant, resolve });
    scheduleBatch();
  });
}

export function aggregateThreats(
  items: Array<{ threat?: ThreatClassification; tier?: number }>
): ThreatClassification {
  const withThreat = items.filter(i => i.threat);
  if (withThreat.length === 0) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  // Level = max across items
  let maxLevel: ThreatLevel = 'info';
  let maxPriority = 0;
  for (const item of withThreat) {
    const p = THREAT_PRIORITY[item.threat!.level];
    if (p > maxPriority) {
      maxPriority = p;
      maxLevel = item.threat!.level;
    }
  }

  // Category = most frequent
  const catCounts = new Map<EventCategory, number>();
  for (const item of withThreat) {
    const cat = item.threat!.category;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  let topCat: EventCategory = 'general';
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
  for (const item of withThreat) {
    const weight = item.tier ? (6 - Math.min(item.tier, 5)) : 1;
    weightedSum += item.threat!.confidence * weight;
    weightTotal += weight;
  }

  return {
    level: maxLevel,
    category: topCat,
    confidence: weightTotal > 0 ? weightedSum / weightTotal : 0.5,
    source: 'keyword',
  };
}
