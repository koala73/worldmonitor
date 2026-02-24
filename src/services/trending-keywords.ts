import type { CorrelationSignal } from './correlation';
import { mlWorker } from './ml-worker';
import { generateSummary } from './summarization';
import { SUPPRESSED_TRENDING_TERMS, escapeRegex, generateSignalId, tokenize } from '@/utils/analysis-constants';
import { t } from '@/services/i18n';

export interface TrendingHeadlineInput {
  title: string;
  pubDate: Date;
  source: string;
  link?: string;
}

interface StoredHeadline {
  title: string;
  source: string;
  link: string;
  publishedAt: number;
  ingestedAt: number;
}

interface TermCandidate {
  display: string;
  isEntity: boolean;
}

interface PendingMLEnrichmentHeadline {
  headline: TrendingHeadlineInput;
  baseTermKeys: Set<string>;
}

interface MLEntity {
  text: string;
  type: string;
  confidence: number;
}

interface TermRecord {
  timestamps: number[];
  baseline7d: number;
  lastSpikeAlertMs: number;
  displayTerm: string;
  headlines: StoredHeadline[];
}

export interface TrendingSpike {
  term: string;
  count: number;
  baseline: number;
  multiplier: number;
  windowMs: number;
  uniqueSources: number;
  headlines: StoredHeadline[];
}

export interface TrendingConfig {
  blockedTerms: string[];
  minSpikeCount: number;
  spikeMultiplier: number;
  autoSummarize: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ROLLING_WINDOW_MS = 2 * HOUR_MS;
const BASELINE_WINDOW_MS = 7 * DAY_MS;
const BASELINE_REFRESH_MS = HOUR_MS;
const SPIKE_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_TRACKED_TERMS = 10000;
const MAX_AUTO_SUMMARIES_PER_HOUR = 5;
const MIN_TOKEN_LENGTH = 3;
const MIN_SPIKE_SOURCE_COUNT = 2;
const CONFIG_KEY = 'worldmonitor-trending-config-v1';
const ML_ENTITY_MIN_CONFIDENCE = 0.75;
const ML_ENTITY_BATCH_SIZE = 20;
const ML_ENTITY_TYPES = new Set(['PER', 'ORG', 'LOC', 'MISC']);

const DEFAULT_CONFIG: TrendingConfig = {
  blockedTerms: [],
  minSpikeCount: 5,
  spikeMultiplier: 3,
  autoSummarize: true,
};

const CVE_PATTERN = /CVE-\d{4}-\d{4,}/gi;
const APT_PATTERN = /APT\d+/gi;
const FIN_PATTERN = /FIN\d+/gi;

const LEADER_NAMES = [
  'putin', 'zelensky', 'xi jinping', 'biden', 'trump', 'netanyahu',
  'khamenei', 'erdogan', 'modi', 'macron', 'scholz', 'starmer',
  'orban', 'milei', 'kim jong un', 'al-sisi',
];
const LEADER_PATTERNS = LEADER_NAMES.map(name => ({
  name,
  pattern: new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),
}));

const termFrequency = new Map<string, TermRecord>();
const seenHeadlines = new Map<string, number>();
const pendingSignals: CorrelationSignal[] = [];
const activeSpikeTerms = new Set<string>();
const autoSummaryRuns: number[] = [];

let cachedConfig: TrendingConfig | null = null;
let lastBaselineRefreshMs = 0;

function toTermKey(term: string): string {
  return term.trim().toLowerCase();
}

function asDisplayTerm(term: string): string {
  if (/^(cve-\d{4}-\d{4,}|apt\d+|fin\d+)$/i.test(term)) {
    return term.toUpperCase();
  }
  return term.toLowerCase();
}

function isStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function uniqueBlockedTerms(terms: string[]): string[] {
  return Array.from(
    new Set(
      terms
        .map(term => toTermKey(term))
        .filter(term => term.length > 0)
    )
  );
}

function sanitizeConfig(config: Partial<TrendingConfig> | null | undefined): TrendingConfig {
  return {
    blockedTerms: uniqueBlockedTerms(config?.blockedTerms ?? DEFAULT_CONFIG.blockedTerms),
    minSpikeCount: Math.max(1, Math.round(config?.minSpikeCount ?? DEFAULT_CONFIG.minSpikeCount)),
    spikeMultiplier: Math.max(1, Number(config?.spikeMultiplier ?? DEFAULT_CONFIG.spikeMultiplier)),
    autoSummarize: config?.autoSummarize ?? DEFAULT_CONFIG.autoSummarize,
  };
}

function readConfig(): TrendingConfig {
  if (cachedConfig) return cachedConfig;
  if (!isStorageAvailable()) {
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) {
      cachedConfig = { ...DEFAULT_CONFIG };
      return cachedConfig;
    }
    cachedConfig = sanitizeConfig(JSON.parse(raw) as Partial<TrendingConfig>);
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig;
}

function persistConfig(config: TrendingConfig): void {
  cachedConfig = config;
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {}
}

function getBlockedTermSet(config: TrendingConfig): Set<string> {
  return new Set([
    ...Array.from(SUPPRESSED_TRENDING_TERMS).map(term => toTermKey(term)),
    ...config.blockedTerms.map(term => toTermKey(term)),
  ]);
}

export function extractEntities(text: string): string[] {
  const entities: string[] = [];
  const lower = text.toLowerCase();

  for (const match of text.matchAll(CVE_PATTERN)) {
    entities.push(match[0].toUpperCase());
  }
  for (const match of text.matchAll(APT_PATTERN)) {
    entities.push(match[0].toUpperCase());
  }
  for (const match of text.matchAll(FIN_PATTERN)) {
    entities.push(match[0].toUpperCase());
  }
  for (const { name, pattern } of LEADER_PATTERNS) {
    if (pattern.test(lower)) {
      entities.push(name);
    }
  }

  return entities;
}

function normalizeEntityType(type: string): string {
  return type.replace(/^[BI]-/, '').trim().toUpperCase();
}

function normalizeMLEntityText(text: string): string {
  return text
    .replace(/^##/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .trim();
}

function collectMLEntities(rawEntities: MLEntity[] | undefined): string[] {
  if (!rawEntities || rawEntities.length === 0) return [];

  const entities: string[] = [];
  for (const entity of rawEntities) {
    const type = normalizeEntityType(entity.type);
    if (!ML_ENTITY_TYPES.has(type)) continue;
    if (!Number.isFinite(entity.confidence) || entity.confidence < ML_ENTITY_MIN_CONFIDENCE) continue;

    const normalized = normalizeMLEntityText(entity.text);
    if (normalized.length < 2 || /^\d+$/.test(normalized)) continue;
    entities.push(normalized);
  }
  return entities;
}

function dedupeEntityTerms(entities: string[]): string[] {
  const deduped = new Map<string, string>();
  for (const entity of entities) {
    const key = toTermKey(entity);
    if (!key || deduped.has(key)) continue;
    deduped.set(key, entity);
  }
  return Array.from(deduped.values());
}

async function extractMLEntitiesForTexts(texts: string[]): Promise<string[][]> {
  if (!mlWorker.isAvailable || texts.length === 0) {
    return texts.map(() => []);
  }

  const entitiesByText: string[][] = [];
  for (let i = 0; i < texts.length; i += ML_ENTITY_BATCH_SIZE) {
    const batch = texts.slice(i, i + ML_ENTITY_BATCH_SIZE);
    const batchResults = await mlWorker.extractEntities(batch);
    for (const entities of batchResults) {
      entitiesByText.push(collectMLEntities(entities));
    }
  }
  return entitiesByText;
}

export async function extractEntitiesWithML(text: string): Promise<string[]> {
  const regexEntities = extractEntities(text);
  if (!mlWorker.isAvailable) return dedupeEntityTerms(regexEntities);

  try {
    const mlEntitiesByText = await extractMLEntitiesForTexts([text]);
    return dedupeEntityTerms([
      ...regexEntities,
      ...(mlEntitiesByText[0] ?? []),
    ]);
  } catch (error) {
    console.debug('[TrendingKeywords] ML entity extraction failed, using regex entities only:', error);
    return dedupeEntityTerms(regexEntities);
  }
}

function headlineKey(headline: TrendingHeadlineInput): string {
  const publishedAt = Number.isFinite(headline.pubDate.getTime()) ? headline.pubDate.getTime() : 0;
  return [
    headline.source.trim().toLowerCase(),
    (headline.link ?? '').trim().toLowerCase(),
    headline.title.trim().toLowerCase(),
    publishedAt,
  ].join('|');
}

function pruneOldState(now: number): void {
  for (const [key, seenAt] of seenHeadlines) {
    if (now - seenAt > BASELINE_WINDOW_MS) {
      seenHeadlines.delete(key);
    }
  }

  for (const [term, record] of termFrequency) {
    record.timestamps = record.timestamps.filter(ts => now - ts <= BASELINE_WINDOW_MS);
    record.headlines = record.headlines.filter(h => now - h.ingestedAt <= ROLLING_WINDOW_MS);
    if (record.timestamps.length === 0) {
      termFrequency.delete(term);
    }
  }

  while (autoSummaryRuns.length > 0 && now - autoSummaryRuns[0]! > HOUR_MS) {
    autoSummaryRuns.shift();
  }

  if (termFrequency.size <= MAX_TRACKED_TERMS) return;

  const ordered = Array.from(termFrequency.entries())
    .map(([term, record]) => ({ term, latest: record.timestamps[record.timestamps.length - 1] ?? 0 }))
    .sort((a, b) => a.latest - b.latest);

  for (const { term } of ordered) {
    if (termFrequency.size <= MAX_TRACKED_TERMS) break;
    termFrequency.delete(term);
  }
}

function maybeRefreshBaselines(now: number): void {
  if (now - lastBaselineRefreshMs < BASELINE_REFRESH_MS) return;
  for (const record of termFrequency.values()) {
    const weekCount = record.timestamps.filter(ts => now - ts <= BASELINE_WINDOW_MS).length;
    record.baseline7d = weekCount / 7;
  }
  lastBaselineRefreshMs = now;
}

function dedupeHeadlines(headlines: StoredHeadline[]): StoredHeadline[] {
  const seen = new Set<string>();
  const unique: StoredHeadline[] = [];
  for (const headline of headlines) {
    const key = `${headline.source}|${headline.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(headline);
  }
  return unique;
}

function stripSourceAttribution(title: string): string {
  const idx = title.lastIndexOf(' - ');
  if (idx === -1) return title;
  const after = title.slice(idx + 3).trim();
  if (after.length > 0 && after.length <= 60 && !/[.!?]/.test(after)) {
    return title.slice(0, idx).trim();
  }
  return title;
}

function buildBaseTermCandidates(title: string): Map<string, TermCandidate> {
  const termCandidates = new Map<string, TermCandidate>();
  const cleanTitle = stripSourceAttribution(title);

  for (const token of tokenize(cleanTitle)) {
    const termKey = toTermKey(token);
    termCandidates.set(termKey, { display: token, isEntity: false });
  }

  for (const entity of extractEntities(cleanTitle)) {
    const termKey = toTermKey(entity);
    termCandidates.set(termKey, { display: entity, isEntity: true });
  }

  return termCandidates;
}

function recordTermCandidates(
  termCandidates: Map<string, TermCandidate>,
  headline: TrendingHeadlineInput,
  now: number,
  blockedTerms: Set<string>
): boolean {
  let addedAny = false;

  for (const [term, meta] of termCandidates) {
    if (blockedTerms.has(term)) continue;
    if (!meta.isEntity && term.length < MIN_TOKEN_LENGTH) continue;

    let record = termFrequency.get(term);
    if (!record) {
      record = {
        timestamps: [],
        baseline7d: 0,
        lastSpikeAlertMs: 0,
        displayTerm: asDisplayTerm(meta.display),
        headlines: [],
      };
      termFrequency.set(term, record);
    } else if (/^(CVE-\d{4}-\d{4,}|APT\d+|FIN\d+)$/i.test(meta.display)) {
      record.displayTerm = asDisplayTerm(meta.display);
    }

    record.timestamps.push(now);
    record.headlines.push({
      title: headline.title,
      source: headline.source,
      link: headline.link ?? '',
      publishedAt: Number.isFinite(headline.pubDate.getTime()) ? headline.pubDate.getTime() : now,
      ingestedAt: now,
    });
    addedAny = true;
  }

  return addedAny;
}

function checkForSpikes(now: number, config: TrendingConfig, blockedTerms: Set<string>): TrendingSpike[] {
  const spikes: TrendingSpike[] = [];

  for (const [term, record] of termFrequency) {
    if (blockedTerms.has(term)) continue;

    const recentCount = record.timestamps.filter(ts => now - ts < ROLLING_WINDOW_MS).length;
    if (recentCount < config.minSpikeCount) continue;

    const baseline = record.baseline7d;
    const multiplier = baseline > 0 ? recentCount / baseline : 0;
    const isSpike = baseline > 0
      ? recentCount > baseline * config.spikeMultiplier
      : recentCount >= config.minSpikeCount;

    if (!isSpike) continue;
    if (now - record.lastSpikeAlertMs < SPIKE_COOLDOWN_MS) continue;

    const recentHeadlines = dedupeHeadlines(
      record.headlines.filter(headline => now - headline.ingestedAt <= ROLLING_WINDOW_MS)
    );
    const uniqueSources = new Set(recentHeadlines.map(headline => headline.source)).size;
    if (uniqueSources < MIN_SPIKE_SOURCE_COUNT) continue;

    record.lastSpikeAlertMs = now;
    spikes.push({
      term: record.displayTerm,
      count: recentCount,
      baseline,
      multiplier,
      windowMs: ROLLING_WINDOW_MS,
      uniqueSources,
      headlines: recentHeadlines,
    });
  }

  return spikes.sort((a, b) => b.count - a.count);
}

function canRunAutoSummary(now: number): boolean {
  while (autoSummaryRuns.length > 0 && now - autoSummaryRuns[0]! > HOUR_MS) {
    autoSummaryRuns.shift();
  }
  return autoSummaryRuns.length < MAX_AUTO_SUMMARIES_PER_HOUR;
}

function pushSignal(signal: CorrelationSignal): void {
  pendingSignals.push(signal);
  while (pendingSignals.length > 200) {
    pendingSignals.shift();
  }
}

function isLikelyProperNoun(term: string, headlines: StoredHeadline[]): boolean {
  if (term.includes(' ') && term.length > 5) return true;
  if (/^\d/.test(term)) return true;

  const titles = headlines.slice(0, 8).map(h => h.title);
  const termRe = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
  let capitalizedCount = 0;
  let midSentenceCount = 0;
  for (const title of titles) {
    for (const m of title.matchAll(termRe)) {
      const idx = m.index ?? 0;
      if (idx === 0) continue;
      midSentenceCount++;
      if (/[A-Z]/.test(title[idx]!)) capitalizedCount++;
    }
  }
  if (midSentenceCount === 0) {
    return titles.some(t => {
      const allCaps = t.match(new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'));
      return allCaps?.some(match => match === match.toUpperCase() && match.length >= 2);
    });
  }
  return capitalizedCount / midSentenceCount >= 0.5;
}

async function isSignificantTerm(term: string, headlines: StoredHeadline[]): Promise<boolean> {
  const lower = term.toLowerCase();

  if (/^(cve-\d{4}-\d{4,}|apt\d+|fin\d+)$/i.test(term)) return true;
  for (const { pattern } of LEADER_PATTERNS) {
    if (pattern.test(term)) return true;
  }

  if (!mlWorker.isAvailable) {
    return isLikelyProperNoun(term, headlines);
  }

  try {
    const titles = headlines.slice(0, 6).map(h => h.title);
    const entitiesPerTitle = await mlWorker.extractEntities(titles);

    for (const entities of entitiesPerTitle) {
      for (const entity of entities) {
        if (entity.text.toLowerCase().includes(lower) || lower.includes(entity.text.toLowerCase())) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return isLikelyProperNoun(term, headlines);
  }
}

async function handleSpike(spike: TrendingSpike, config: TrendingConfig): Promise<void> {
  const termKey = toTermKey(spike.term);
  if (activeSpikeTerms.has(termKey)) return;
  activeSpikeTerms.add(termKey);

  try {
    const significant = await isSignificantTerm(spike.term, spike.headlines);
    if (!significant) {
      console.log(`[TrendingKeywords] Suppressed non-entity term: "${spike.term}"`);
      return;
    }

    const windowHours = Math.round((spike.windowMs / HOUR_MS) * 10) / 10;
    const headlines = spike.headlines.slice(0, 6).map(h => h.title);
    const multiplierText = spike.baseline > 0 ? `${spike.multiplier.toFixed(1)}x baseline` : 'cold-start threshold';

    let description = `${spike.term} is appearing across ${spike.uniqueSources} sources (${spike.count} mentions in ${windowHours}h).`;

    const now = Date.now();
    if (config.autoSummarize && headlines.length >= 2 && canRunAutoSummary(now)) {
      autoSummaryRuns.push(now);
      const summary = await generateSummary(
        headlines,
        undefined,
        `Breaking: "${spike.term}" mentioned ${spike.count}x in ${windowHours}h (${multiplierText})`
      );
      if (summary?.summary) {
        description = summary.summary;
      }
    }

    const priorityBoost = spike.multiplier >= 5 ? 0.9 : spike.multiplier >= 3 ? 0.75 : 0.6;
    const confidence = spike.baseline > 0
      ? Math.min(0.95, priorityBoost)
      : Math.min(0.8, 0.45 + spike.count / 20);

    pushSignal({
      id: generateSignalId(),
      type: 'keyword_spike',
      title: t('alerts.trending', { term: spike.term, count: spike.count, hours: windowHours }),
      description,
      confidence,
      timestamp: new Date(),
      data: {
        term: spike.term,
        newsVelocity: spike.count,
        relatedTopics: [spike.term],
        baseline: spike.baseline,
        multiplier: spike.baseline > 0 ? spike.multiplier : undefined,
        sourceCount: spike.uniqueSources,
        explanation: `${spike.term}: ${spike.count} mentions across ${spike.uniqueSources} sources (${multiplierText})`,
      },
    });
  } catch (error) {
    console.warn('[TrendingKeywords] Failed to handle spike:', error);
  } finally {
    activeSpikeTerms.delete(termKey);
  }
}

async function enrichWithMLEntities(headlines: PendingMLEnrichmentHeadline[], ingestedAt: number): Promise<void> {
  if (headlines.length === 0 || !mlWorker.isAvailable) return;

  try {
    const texts = headlines.map(entry => entry.headline.title);
    const mlEntitiesByText = await extractMLEntitiesForTexts(texts);
    const config = readConfig();
    const blockedTerms = getBlockedTermSet(config);

    let addedAny = false;
    for (let i = 0; i < headlines.length; i += 1) {
      const pending = headlines[i]!;
      const mlEntities = mlEntitiesByText[i] ?? [];
      if (mlEntities.length === 0) continue;

      const termCandidates = new Map<string, TermCandidate>();
      for (const entity of mlEntities) {
        const termKey = toTermKey(entity);
        if (!termKey || pending.baseTermKeys.has(termKey)) continue;
        termCandidates.set(termKey, { display: entity, isEntity: true });
      }

      if (termCandidates.size === 0) continue;
      addedAny = recordTermCandidates(termCandidates, pending.headline, ingestedAt, blockedTerms) || addedAny;
    }

    if (!addedAny) return;

    const now = Date.now();
    pruneOldState(now);
    maybeRefreshBaselines(now);

    const spikes = checkForSpikes(now, config, blockedTerms);
    for (const spike of spikes) {
      void handleSpike(spike, config).catch(() => {});
    }
  } catch (error) {
    console.debug('[TrendingKeywords] ML entity enrichment skipped:', error);
  }
}

export function ingestHeadlines(headlines: TrendingHeadlineInput[]): void {
  if (headlines.length === 0) return;

  const now = Date.now();
  const config = readConfig();
  const blockedTerms = getBlockedTermSet(config);
  const pendingMLEnrichment: PendingMLEnrichmentHeadline[] = [];

  for (const headline of headlines) {
    if (!headline.title?.trim()) continue;

    const key = headlineKey(headline);
    const previouslySeen = seenHeadlines.get(key);
    if (previouslySeen && now - previouslySeen <= BASELINE_WINDOW_MS) {
      continue;
    }
    seenHeadlines.set(key, now);

    const termCandidates = buildBaseTermCandidates(headline.title);
    recordTermCandidates(termCandidates, headline, now, blockedTerms);
    pendingMLEnrichment.push({
      headline,
      baseTermKeys: new Set(termCandidates.keys()),
    });
  }

  pruneOldState(now);
  maybeRefreshBaselines(now);

  const spikes = checkForSpikes(now, config, blockedTerms);
  for (const spike of spikes) {
    void handleSpike(spike, config).catch(() => {});
  }

  void enrichWithMLEntities(pendingMLEnrichment, now);
}

export function drainTrendingSignals(): CorrelationSignal[] {
  if (pendingSignals.length === 0) return [];
  return pendingSignals.splice(0, pendingSignals.length);
}

export function getTrendingConfig(): TrendingConfig {
  return { ...readConfig() };
}

export function updateTrendingConfig(update: Partial<TrendingConfig>): TrendingConfig {
  const next = sanitizeConfig({
    ...readConfig(),
    ...update,
    blockedTerms: update.blockedTerms ?? readConfig().blockedTerms,
  });
  persistConfig(next);
  return { ...next };
}

export function suppressTrendingTerm(term: string): TrendingConfig {
  const config = readConfig();
  const blocked = new Set(config.blockedTerms);
  blocked.add(toTermKey(term));
  return updateTrendingConfig({ blockedTerms: Array.from(blocked) });
}

export function unsuppressTrendingTerm(term: string): TrendingConfig {
  const config = readConfig();
  const normalized = toTermKey(term);
  return updateTrendingConfig({
    blockedTerms: config.blockedTerms.filter(entry => toTermKey(entry) !== normalized),
  });
}

export function getTrackedTermCount(): number {
  return termFrequency.size;
}
