#!/usr/bin/env node

// Daily forecast resolution seeder for Bet 2 (#5007).
//
// Pure exported helpers cover ledger ingest, hard resolution, scorecards, and
// pruning. Exported live-I/O helpers take options/test doubles so tests can use
// them without invoking Redis or LLM providers. The direct-run block is the
// Railway worker shell that reads the forecast history intake, persists the
// working ledger, writes the scorecard, and appends terminal receipts to R2.
//
// Railway service config (set up manually via Railway dashboard or
// `railway service`):
//   - Service name: seed-forecast-resolutions
//   - Start command: node scripts/seed-forecast-resolutions.mjs
//   - Cron: daily

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { resolveR2StorageConfig, putR2JsonObject } from './_r2-storage.mjs';
import { parseMetricKey, resolveHardSpec, extractMetricValue } from './_forecast-resolution-eval.mjs';
import { CONFLICT_COUNT_FEED_AVAILABLE, UNREST_COUNT_FEED_AVAILABLE, CONFLICT_COUNT_SOURCE_FEED, UNREST_COUNT_SOURCE_FEED } from './_forecast-resolution.mjs';
import { computeScorecard, DEFAULT_ROLLING_WINDOW_DAYS } from './_forecast-scorecard.mjs';
import { callForecastLLM } from './seed-forecasts.mjs';

export const HISTORY_KEY = 'forecast:predictions:history:v1';
export const RESOLUTIONS_KEY = 'forecast:resolutions:v1';
export const SCORECARD_KEY = 'forecast:scorecard:v1';
export const SCORECARD_META_KEY = 'seed-meta:forecast:scorecard';
export const SCORECARD_TTL_SECONDS = 7 * 24 * 60 * 60;
export const RESOLUTION_SOURCE_VERSION = 'forecast-resolution-engine-v1';
export const RESOLUTION_SCHEMA_VERSION = 1;
export const MAX_RECENT_SAMPLES = 40;
export const JUDGED_ARCHIVE_KEY = 'digest:accumulator:v1:full:en';
export const JUDGED_ARCHIVE_RETENTION_MS = 48 * 60 * 60 * 1000;
export const JUDGED_ARCHIVE_LOOKBACK_PAD_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_JUDGED_ARCHIVE_ITEMS = 16;
export const DEFAULT_JUDGED_MAX_PER_RUN = 12;
export const DEFAULT_JUDGED_RUN_BUDGET_MS = 110_000;
export const DEFAULT_JUDGED_ARCHIVE_HASH_LIMIT = 3_000;
const DEFAULT_MIN_JUDGED_STAGE_BUDGET_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JUDGED_MAX_PENDING_ATTEMPTS = 14;
export const DEFAULT_JUDGED_MAX_PENDING_AGE_MS = 14 * DAY_MS;
const JUDGED_TOKEN_STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'before', 'being', 'below',
  'between', 'could', 'deadline', 'during', 'forecast', 'from', 'have',
  'into', 'more', 'over', 'than', 'that', 'their', 'there', 'these',
  'this', 'through', 'under', 'until', 'what', 'when', 'where', 'which',
  'while', 'will', 'with', 'within', 'would',
]);
const STALE_COUNT_FEED_REPLACEMENTS = new Map([
  ['conflict:acled:v1:all:0:0', CONFLICT_COUNT_SOURCE_FEED],
  ['unrest:events:v1', UNREST_COUNT_SOURCE_FEED],
]);

// Retention for the persistent working ledger (#5067). A resolved entry only
// leaves the hot `forecast:resolutions:v1` value once it is (a) durably archived
// to R2 as a receipt AND (b) older than this window — by which point it no longer
// contributes to the rolling scorecard math, so pruning it is scorecard-neutral.
// Aligned to the scorecard's rolling window so the two never diverge: any pruned
// entry is exactly one the scorecard already excludes. The window (180d) dwarfs
// the forecast-history intake reach (LRANGE 200 at hourly cadence ~8.3 days), so
// a pruned window can never be re-ingested from a stale snapshot.
export const LEDGER_RETENTION_WINDOW_DAYS = DEFAULT_ROLLING_WINDOW_DAYS;

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) loadEnvFile(import.meta.url);

export function declareRecords(ledger) {
  return Object.keys(normalizeLedger(ledger)).length;
}

export function declareScorecardRecords(scorecard) {
  return Number.isInteger(scorecard?.totals?.entries) ? scorecard.totals.entries : 0;
}

export function processResolutionCycle(existingLedger, historySnapshots, feedsByKey, nowMs) {
  const ingested = ingestHistory(existingLedger, historySnapshots, nowMs);
  samplePendingEntries(ingested, feedsByKey, nowMs);
  const receipts = resolveDueEntries(ingested, feedsByKey, nowMs);
  // Drop terminal entries that are already receipted to R2 and outside the
  // rolling scorecard window, keeping the persistent ledger bounded (#5067). Runs after
  // resolveDueEntries so entries resolved this cycle (resolvedAt === nowMs, not
  // yet archived) are always retained and still emit a receipt above.
  const ledger = pruneArchivedTerminalEntries(ingested, nowMs);
  const scorecard = computeScorecard(ledger, nowMs);
  return { ledger, receipts, scorecard };
}

export async function processResolutionCycleWithJudges(existingLedger, historySnapshots, feedsByKey, newsArchive, nowMs, options = {}) {
  const ingested = ingestHistory(existingLedger, historySnapshots, nowMs);
  samplePendingEntries(ingested, feedsByKey, nowMs);
  const receipts = resolveDueEntries(ingested, feedsByKey, nowMs);
  receipts.push(...await resolvePendingJudgedEntries(ingested, newsArchive, nowMs, options));
  const ledger = pruneArchivedTerminalEntries(ingested, nowMs);
  const scorecard = computeScorecard(ledger, nowMs);
  return { ledger, receipts, scorecard };
}

export async function resolvePendingJudgedEntries(ledger, newsArchive, nowMs, options = {}) {
  const receipts = [];
  const maxEntries = Number.isFinite(options.maxJudgedEntries)
    ? Math.max(0, Math.floor(options.maxJudgedEntries))
    : Infinity;
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : Infinity;
  const judgeStageBudgetMs = Number.isFinite(options.judgeStageBudgetMs)
    ? Math.max(0, Math.floor(options.judgeStageBudgetMs))
    : envPositiveInt('FORECAST_RESOLUTION_JUDGE_STAGE_BUDGET_MS', 35_000);
  const minJudgeStageBudgetMs = Number.isFinite(options.minJudgeStageBudgetMs)
    ? Math.max(0, Math.floor(options.minJudgeStageBudgetMs))
    : Math.min(DEFAULT_MIN_JUDGED_STAGE_BUDGET_MS, judgeStageBudgetMs);
  const retryPolicy = resolveJudgedRetryPolicy(options);
  let attempted = 0;

  const pendingRows = Object.entries(ledger)
    .filter(([, entry]) => entry?.status === 'pending-judge')
    .sort((left, right) => comparePendingJudgedEntries(left, right, nowMs));

  for (const [key, entry] of pendingRows) {
    if (attempted >= maxEntries) break;
    let entryOptions = options;
    if (Number.isFinite(deadlineMs)) {
      const remainingBudgetMs = deadlineMs - Date.now() - 1_000;
      if (remainingBudgetMs < minJudgeStageBudgetMs) break;
      entryOptions = {
        ...options,
        judgeStageBudgetMs: Math.min(judgeStageBudgetMs, remainingBudgetMs),
      };
    }

    let result = await resolveJudgedEntry(entry, newsArchive, nowMs, entryOptions);
    if (result.status === 'skip') continue;
    attempted += 1;

    if (result.status === 'pending') {
      recordJudgedPendingAttempt(entry, result, nowMs);
      result = maybeExpireJudgedEntry(entry, nowMs, retryPolicy);
      if (!result) continue;
    }

    entry.status = 'resolved';
    entry.outcome = result.outcome;
    entry.resolvedAt = nowMs;
    entry.sealedAt = nowMs;
    entry.evidence = result.evidence;
    receipts.push({ key, entry: cloneJson(entry), resolvedAt: nowMs });
  }

  return receipts;
}

function comparePendingJudgedEntries([keyA, entryA], [keyB, entryB], nowMs) {
  const dueA = judgedEntryIsDue(entryA, nowMs);
  const dueB = judgedEntryIsDue(entryB, nowMs);
  if (dueA !== dueB) return dueA ? -1 : 1;

  const attemptA = toFiniteNumber(entryA?.judgeLastAttempt?.at);
  const attemptB = toFiniteNumber(entryB?.judgeLastAttempt?.at);
  const orderA = Number.isFinite(attemptA) ? attemptA : -Infinity;
  const orderB = Number.isFinite(attemptB) ? attemptB : -Infinity;
  if (orderA !== orderB) return orderA - orderB;

  const deadlineA = toFiniteNumber(entryA?.deadline ?? entryA?.spec?.deadline);
  const deadlineB = toFiniteNumber(entryB?.deadline ?? entryB?.spec?.deadline);
  const deadlineOrderA = Number.isFinite(deadlineA) ? deadlineA : Infinity;
  const deadlineOrderB = Number.isFinite(deadlineB) ? deadlineB : Infinity;
  if (deadlineOrderA !== deadlineOrderB) return deadlineOrderA - deadlineOrderB;

  return keyA.localeCompare(keyB);
}

function judgedEntryIsDue(entry, nowMs) {
  const deadline = toFiniteNumber(entry?.deadline ?? entry?.spec?.deadline);
  return !Number.isFinite(deadline) || nowMs >= deadline;
}

function recordJudgedPendingAttempt(entry, result, nowMs) {
  entry.judgeAttempts = toNonNegativeInteger(entry.judgeAttempts) + 1;
  entry.judgeLastAttempt = {
    at: nowMs,
    reason: result.reason || 'judge_pending',
    detail: result.detail || '',
  };
}

function resolveJudgedRetryPolicy(options = {}) {
  return {
    maxAttempts: Number.isFinite(options.maxJudgedPendingAttempts)
      ? Math.max(1, Math.floor(options.maxJudgedPendingAttempts))
      : envPositiveInt('FORECAST_RESOLUTION_JUDGE_MAX_PENDING_ATTEMPTS', DEFAULT_JUDGED_MAX_PENDING_ATTEMPTS),
    maxAgeMs: Number.isFinite(options.maxJudgedPendingAgeMs)
      ? Math.max(0, Math.floor(options.maxJudgedPendingAgeMs))
      : envPositiveInt('FORECAST_RESOLUTION_JUDGE_MAX_PENDING_AGE_MS', DEFAULT_JUDGED_MAX_PENDING_AGE_MS),
  };
}

function maybeExpireJudgedEntry(entry, nowMs, retryPolicy) {
  const attempts = toNonNegativeInteger(entry?.judgeAttempts);
  if (attempts < retryPolicy.maxAttempts) return null;
  const deadline = toFiniteNumber(entry?.deadline ?? entry?.spec?.deadline);
  const ageMs = Number.isFinite(deadline) ? nowMs - deadline : retryPolicy.maxAgeMs;
  if (ageMs < retryPolicy.maxAgeMs) return null;

  const result = resolvedJudgedResult('VOID', 'judge_retry_exhausted', entry, [], [], nowMs);
  result.evidence = pruneUndefined({
    ...result.evidence,
    attempts,
    maxAttempts: retryPolicy.maxAttempts,
    deadlineAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : undefined,
    maxAgeMs: retryPolicy.maxAgeMs,
    lastAttemptReason: entry?.judgeLastAttempt?.reason,
    lastAttemptDetail: entry?.judgeLastAttempt?.detail,
  });
  return result;
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export async function resolveJudgedEntry(entry, newsArchive, nowMs, options = {}) {
  const spec = entry?.spec || entry?.resolution;
  if (!spec || spec.kind !== 'judged') return { status: 'skip' };

  const deadline = Number(spec.deadline ?? entry.deadline);
  if (!Number.isFinite(deadline)) {
    return resolvedJudgedResult('VOID', 'missing_deadline', entry, [], [], nowMs);
  }
  if (nowMs < deadline) return { status: 'skip' };

  const archiveInput = normalizeJudgedArchiveInput(newsArchive);
  if (!archiveInput.available) {
    return { status: 'pending', reason: 'archive_unavailable' };
  }

  const archiveItems = selectJudgedArchiveItems(entry, archiveInput.items, {
    maxItems: options.maxArchiveItems ?? DEFAULT_JUDGED_ARCHIVE_ITEMS,
  });
  const archiveComplete = archiveCoversEntryWindow(entry, archiveInput, nowMs);
  if (!archiveItems.length) {
    if (!archiveComplete) {
      return { status: 'pending', reason: 'archive_unavailable', detail: 'archive_window_incomplete' };
    }
    return resolvedJudgedResult('VOID', 'no_archive_evidence', entry, [], [], nowMs);
  }

  if (Array.isArray(options.judgeModels) && options.judgeModels.length < 2) {
    return { status: 'pending', reason: 'judge_unavailable', detail: 'fewer_than_two_models' };
  }
  const judgeModels = Array.isArray(options.judgeModels)
    ? options.judgeModels.slice(0, 2)
    : createLiveJudgeModels(options);
  if (judgeModels.length < 2) {
    return { status: 'pending', reason: 'judge_unavailable', detail: 'fewer_than_two_models' };
  }

  const settled = await Promise.allSettled(judgeModels.map((judge) => judge(entry, archiveItems, nowMs)));
  const judgments = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      return { status: 'pending', reason: 'judge_unavailable', detail: result.reason?.message || String(result.reason || '') };
    }
    const normalized = normalizeJudgment(result.value, archiveItems);
    if (!normalized) return { status: 'pending', reason: 'judge_unavailable', detail: 'invalid_judge_response' };
    judgments.push(normalized);
  }

  const nonVoidOutcomes = judgments.map((judgment) => judgment.outcome).filter((outcome) => outcome !== 'VOID');
  if (nonVoidOutcomes.length === judgments.length && new Set(nonVoidOutcomes).size === 1) {
    return resolvedJudgedResult(nonVoidOutcomes[0], 'dual_model_agreement', entry, judgments, archiveItems, nowMs);
  }
  if (!archiveComplete) {
    return { status: 'pending', reason: 'archive_unavailable', detail: 'archive_window_incomplete' };
  }
  if (judgments.every((judgment) => judgment.outcome === 'VOID')) {
    return resolvedJudgedResult('VOID', 'all_judges_void', entry, judgments, archiveItems, nowMs);
  }
  return resolvedJudgedResult('VOID', 'judge_disagreement', entry, judgments, archiveItems, nowMs);
}

export function selectJudgedArchiveItems(entry, archiveItems, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(1, Math.floor(options.maxItems)) : DEFAULT_JUDGED_ARCHIVE_ITEMS;
  const tokenPatterns = judgedQueryTokens(entry).map(buildTokenPattern);
  return normalizeJudgedArchiveItems(archiveItems)
    .map((item, index) => ({
      ...item,
      id: item.id || `N${index + 1}`,
      relevance: scoreArchiveItem(item, tokenPatterns),
    }))
    .filter((item) => item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || Number(b.publishedAt || 0) - Number(a.publishedAt || 0))
    .slice(0, maxItems)
    .map((item, index) => pruneUndefined({
      id: item.id || `N${index + 1}`,
      title: item.title,
      description: item.description,
      url: item.url,
      source: item.source,
      publishedAt: item.publishedAt,
      severity: item.severity,
      relevance: item.relevance,
    }));
}

function normalizeJudgedArchiveInput(newsArchive) {
  if (Array.isArray(newsArchive)) {
    return { items: normalizeJudgedArchiveItems(newsArchive), available: true };
  }
  if (!newsArchive || typeof newsArchive !== 'object') {
    return { items: [], available: false };
  }
  if (newsArchive.available === false) {
    return { items: [], available: false };
  }
  const items = newsArchive.items
    ?? newsArchive.stories
    ?? newsArchive.topStories
    ?? newsArchive.articles
    ?? newsArchive.data
    ?? [];
  return {
    items: normalizeJudgedArchiveItems(items),
    available: true,
    truncated: Boolean(newsArchive.truncated || newsArchive.partial || newsArchive.coverageComplete === false),
    coverageStartMs: toFiniteMs(newsArchive.coverageStartMs ?? newsArchive.windowStartMs ?? newsArchive.fromMs),
    coverageEndMs: toFiniteMs(newsArchive.coverageEndMs ?? newsArchive.windowEndMs ?? newsArchive.toMs),
  };
}

function normalizeJudgedArchiveItems(value) {
  const rows = unwrapArchiveRows(value);
  return rows
    .map((row, index) => normalizeJudgedArchiveItem(row, index))
    .filter(Boolean);
}

function unwrapArchiveRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return unwrapArchiveRows(
    value.items
      ?? value.stories
      ?? value.topStories
      ?? value.articles
      ?? value.data
      ?? [],
  );
}

function normalizeJudgedArchiveItem(row, index) {
  if (!row || typeof row !== 'object') return null;
  const title = cleanString(row.title ?? row.headline ?? row.name);
  const description = truncateText(cleanString(row.description ?? row.summary ?? row.text ?? row.body), 700);
  if (!title && !description) return null;
  return pruneUndefined({
    id: cleanString(row.id ?? row.hash ?? row.titleHash ?? row.key) || `N${index + 1}`,
    hash: cleanString(row.hash ?? row.titleHash),
    title,
    description,
    url: cleanString(row.url ?? row.link ?? row.sourceUrl),
    source: cleanString(row.source ?? row.publisher ?? row.feedName ?? row.domain),
    publishedAt: toFiniteMs(row.publishedAt ?? row.pubDate ?? row.lastSeen ?? row.lastSeenAt ?? row.firstSeen),
    severity: cleanString(row.severity),
    currentScore: toFiniteNumber(row.currentScore ?? row.score),
  });
}

function judgedQueryTokens(entry) {
  const spec = entry?.spec || entry?.resolution || {};
  const text = [
    entry?.title,
    entry?.domain,
    entry?.region,
    spec.question,
  ].filter(Boolean).join(' ');
  const rawTokens = text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  return [...new Set(rawTokens
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 4)
    .filter((token) => !JUDGED_TOKEN_STOPWORDS.has(token)))];
}

function scoreArchiveItem(item, tokenPatterns) {
  if (!tokenPatterns.length) return 0;
  const title = `${item.title || ''}`.toLowerCase();
  const description = `${item.description || ''}`.toLowerCase();
  const source = `${item.source || ''}`.toLowerCase();
  let score = 0;
  for (const pattern of tokenPatterns) {
    if (textHasToken(title, pattern)) score += 3;
    if (textHasToken(description, pattern)) score += 1;
    if (textHasToken(source, pattern)) score += 0.25;
  }
  return score;
}

function archiveCoversEntryWindow(entry, archiveInput, nowMs) {
  if (archiveInput.truncated) return false;
  const coverageStartMs = Number(archiveInput.coverageStartMs);
  const coverageEndMs = Number(archiveInput.coverageEndMs);
  if (!Number.isFinite(coverageStartMs) && !Number.isFinite(coverageEndMs)) return true;
  const { startMs, endMs } = judgedArchiveWindowForEntry(entry, nowMs);
  return (!Number.isFinite(coverageStartMs) || coverageStartMs <= startMs)
    && (!Number.isFinite(coverageEndMs) || coverageEndMs >= endMs);
}

function judgedArchiveWindowForEntry(entry, nowMs) {
  const deadline = Number(entry?.deadline ?? entry?.spec?.deadline);
  const candidates = [entry?.generatedAt, entry?.firstSeenAt, deadline, nowMs]
    .map(Number)
    .filter(Number.isFinite);
  const anchor = candidates.length ? Math.min(...candidates) : nowMs;
  return {
    startMs: Math.max(0, anchor - JUDGED_ARCHIVE_LOOKBACK_PAD_MS),
    endMs: nowMs,
  };
}

function buildTokenPattern(token) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, 'i');
}

function textHasToken(text, pattern) {
  return pattern.test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createLiveJudgeModels(options = {}) {
  const stageBudgetMs = envPositiveInt('FORECAST_RESOLUTION_JUDGE_STAGE_BUDGET_MS', 35_000);
  const common = {
    temperature: 0.1,
    maxTokens: envPositiveInt('FORECAST_RESOLUTION_JUDGE_MAX_TOKENS', 700),
    maxRetries: 0,
    returnFailureReason: true,
    stageBudgetMs: options.judgeStageBudgetMs ?? stageBudgetMs,
  };
  return [
    (entry, archiveItems, nowMs) => callLiveJudgedModel(entry, archiveItems, nowMs, {
      ...common,
      stage: 'forecast_resolution_judge_openrouter',
      providerOrder: ['openrouter'],
      modelOverrides: {
        openrouter: process.env.FORECAST_RESOLUTION_JUDGE_MODEL_OPENROUTER
          || process.env.FORECAST_LLM_MODEL_OPENROUTER
          || 'deepseek/deepseek-v4-flash',
      },
    }),
    (entry, archiveItems, nowMs) => callLiveJudgedModel(entry, archiveItems, nowMs, {
      ...common,
      stage: 'forecast_resolution_judge_groq',
      providerOrder: ['groq'],
      modelOverrides: {
        groq: process.env.FORECAST_RESOLUTION_JUDGE_MODEL_GROQ || 'llama-3.3-70b-versatile',
      },
    }),
  ];
}

async function callLiveJudgedModel(entry, archiveItems, nowMs, options) {
  const { systemPrompt, userPrompt } = buildJudgedResolutionPrompt(entry, archiveItems, nowMs);
  const result = await callForecastLLM(systemPrompt, userPrompt, options);
  if (!result?.text) return null;
  return {
    text: result.text,
    provider: result.provider,
    model: result.model,
  };
}

function buildJudgedResolutionPrompt(entry, archiveItems, nowMs) {
  const spec = entry?.spec || entry?.resolution || {};
  const systemPrompt = [
    'You resolve forecasts using only the provided news archive.',
    'Return JSON only: {"outcome":"YES|NO|VOID","citations":[{"id":"N1","quote":"short evidence"}],"rationale":"short reason"}.',
    'YES means the archive proves the forecast happened by the deadline.',
    'NO means the archive proves it did not happen by the deadline.',
    'VOID means the archive is insufficient, ambiguous, contradictory, or unrelated.',
    'YES and NO require at least one valid citation id and quote/excerpt copied from that archive item. Never use outside knowledge.',
  ].join('\n');
  const archiveText = archiveItems.map((item) => [
    `[${item.id}] ${new Date(item.publishedAt || nowMs).toISOString()}`,
    item.source ? `source=${item.source}` : '',
    item.title || '',
    item.url ? `url=${item.url}` : '',
    item.description ? `summary=${truncateText(item.description, 420)}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
  const userPrompt = [
    `Forecast: ${entry?.title || entry?.id || 'untitled forecast'}`,
    `Domain: ${entry?.domain || 'unknown'}`,
    `Region: ${entry?.region || 'global'}`,
    `Question: ${spec.question || entry?.title || ''}`,
    `Deadline: ${Number.isFinite(Number(spec.deadline ?? entry?.deadline)) ? new Date(Number(spec.deadline ?? entry?.deadline)).toISOString() : 'unknown'}`,
    '',
    'News archive:',
    archiveText,
  ].join('\n');
  return { systemPrompt, userPrompt };
}

function normalizeJudgment(value, archiveItems) {
  const raw = parseJudgmentPayload(value);
  if (!raw || typeof raw !== 'object') return null;
  const outcome = cleanString(raw.outcome ?? raw.result ?? raw.resolution).toUpperCase();
  if (!['YES', 'NO', 'VOID'].includes(outcome)) return null;
  const rawCitations = raw.citations ?? raw.evidence ?? raw.sources ?? [];
  const citationRows = normalizeCitationRows(rawCitations);
  const citations = normalizeJudgmentCitations(citationRows, archiveItems);
  const base = pruneUndefined({
    provider: cleanString(raw.provider),
    model: cleanString(raw.model),
    outcome,
    citations,
    rationale: truncateText(cleanString(raw.rationale ?? raw.reason ?? raw.explanation), 420),
    reason: cleanString(raw.reasonCode ?? raw.reason),
  });
  if ((outcome === 'YES' || outcome === 'NO') && citations.length === 0) {
    return { ...base, outcome: 'VOID', reason: citationRows.length ? 'invalid_citations' : 'missing_citations' };
  }
  return base;
}

function parseJudgmentPayload(value) {
  if (!value) return null;
  if (typeof value === 'object' && !value.text) return value;
  const text = typeof value === 'string' ? value : value.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  if (typeof value === 'object') {
    return {
      ...parsed,
      provider: parsed.provider ?? value.provider,
      model: parsed.model ?? value.model,
    };
  }
  return parsed;
}

function parseJsonObject(text) {
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  try {
    return JSON.parse(cleanJudgmentJson(trimmed));
  } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {}
  try {
    return JSON.parse(cleanJudgmentJson(trimmed.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function cleanJudgmentJson(text) {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function normalizeCitationRows(rawCitations) {
  return Array.isArray(rawCitations) ? rawCitations : [rawCitations].filter(Boolean);
}

function normalizeJudgmentCitations(citationRows, archiveItems) {
  const byId = new Map(archiveItems.map((item) => [item.id, item]));
  const citations = [];
  const seen = new Set();
  for (const citation of citationRows) {
    const rawId = typeof citation === 'object'
      ? citation.id ?? citation.sourceId ?? citation.articleId ?? citation.citationId ?? citation.n
      : citation;
    const id = normalizeCitationId(rawId);
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    const quote = truncateText(cleanString(citation?.quote ?? citation?.excerpt), 240);
    if (!quote || !citationQuoteMatchesItem(quote, item)) continue;
    seen.add(id);
    citations.push(pruneUndefined({
      id,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      quote,
    }));
  }
  return citations;
}

function citationQuoteMatchesItem(quote, item) {
  const quoteText = normalizeCitationText(quote);
  const itemText = normalizeCitationText([item.title, item.description].filter(Boolean).join(' '));
  if (!quoteText || !itemText) return false;
  if (itemText.includes(quoteText)) return true;
  const quoteTokens = quoteText.match(/[a-z0-9]{4,}/g) || [];
  if (quoteTokens.length < 3) return false;
  const matched = quoteTokens.filter((token) => itemText.includes(token)).length;
  return matched / quoteTokens.length >= 0.8;
}

function normalizeCitationText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeCitationId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return `N${Math.floor(value)}`;
  const text = cleanString(value);
  if (/^\d+$/.test(text)) return `N${text}`;
  const match = text.match(/^N?\s*(\d+)$/i);
  if (match) return `N${match[1]}`;
  return text;
}

function resolvedJudgedResult(outcome, reason, entry, judgments, archiveItems, nowMs) {
  const spec = entry?.spec || entry?.resolution || {};
  return {
    status: 'resolved',
    outcome,
    evidence: pruneUndefined({
      kind: 'judged',
      reason,
      resolvedAt: nowMs,
      question: spec.question,
      deadline: Number.isFinite(Number(spec.deadline ?? entry?.deadline)) ? Number(spec.deadline ?? entry?.deadline) : undefined,
      judgedBy: judgments.map((judgment) => pruneUndefined({
        provider: judgment.provider,
        model: judgment.model,
        outcome: judgment.outcome,
        reason: judgment.reason,
      })),
      judgments: judgments.map((judgment) => pruneUndefined({
        provider: judgment.provider,
        model: judgment.model,
        outcome: judgment.outcome,
        reason: judgment.reason,
        rationale: judgment.rationale,
        citations: judgment.citations,
      })),
      citations: mergeJudgmentCitations(judgments),
      archive: archiveItems.map((item) => pruneUndefined({
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt,
      })),
    }),
  };
}

function mergeJudgmentCitations(judgments) {
  const merged = [];
  const seen = new Set();
  for (const judgment of judgments) {
    for (const citation of judgment.citations || []) {
      if (seen.has(citation.id)) continue;
      seen.add(citation.id);
      merged.push(citation);
    }
  }
  return merged;
}

function cleanString(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function truncateText(value, maxLength) {
  const text = cleanString(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function toFiniteMs(value) {
  if (value == null || value === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function envPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Terminal entries whose receipt is safely in R2 and that have aged past the
// retention window are removed from the hot working ledger; everything else
// (pending, pending-judge, within-window resolved, un-archived resolved, or
// resolved-without-a-timestamp) is retained. Pure: returns a new object and
// never mutates the input.
export function pruneArchivedTerminalEntries(ledger, nowMs, options = {}) {
  const retentionDays = options.retentionWindowDays ?? LEDGER_RETENTION_WINDOW_DAYS;
  const minResolvedAt = nowMs - retentionDays * DAY_MS;
  const kept = {};
  for (const [key, entry] of Object.entries(normalizeLedger(ledger))) {
    if (isPrunableTerminalEntry(entry, minResolvedAt)) continue;
    kept[key] = entry;
  }
  return kept;
}

function isPrunableTerminalEntry(entry, minResolvedAt) {
  if (!entry || entry.status !== 'resolved') return false;
  if (!entry.receiptArchivedAt) return false;
  const resolvedAt = Number(entry.resolvedAt);
  if (!Number.isFinite(resolvedAt)) return false;
  return resolvedAt < minResolvedAt;
}

export function ingestHistory(existingLedger, historySnapshots, nowMs = Date.now()) {
  const ledger = cloneJson(normalizeLedger(existingLedger));
  migratePendingCountFeedKeys(ledger);
  const snapshots = [...(historySnapshots || [])]
    .filter(Boolean)
    .sort((a, b) => Number(a.generatedAt || 0) - Number(b.generatedAt || 0));

  for (const snapshot of snapshots) {
    const snapshotAt = Number(snapshot.generatedAt || nowMs);
    for (const forecast of snapshot.predictions || []) {
      const spec = forecast.resolution;
      if (!spec || typeof spec !== 'object') continue;
      const id = forecast.id;
      const deadline = Number(spec.deadline);
      const generatedAt = Number(forecast.generatedAt || forecast.createdAt || snapshotAt);
      if (!id || !Number.isFinite(deadline) || !Number.isFinite(generatedAt)) continue;

      const openKey = findOpenWindowKey(ledger, id, generatedAt);
      if (openKey) {
        updateOpenWindow(ledger[openKey], forecast, generatedAt, snapshotAt);
        continue;
      }

      const key = `${id}@${deadline}`;
      if (ledger[key]) {
        updateOpenWindow(ledger[key], forecast, generatedAt, snapshotAt);
        continue;
      }
      ledger[key] = createEntry(id, forecast, spec, generatedAt, snapshotAt, deadline);
    }
  }

  migratePendingCountFeedKeys(ledger);
  return sortLedger(ledger);
}

function migratePendingCountFeedKeys(ledger) {
  for (const entry of Object.values(ledger)) {
    if (entry?.status !== 'pending' || entry.spec?.kind !== 'hard') continue;
    const replacement = STALE_COUNT_FEED_REPLACEMENTS.get(entry.spec.sourceFeed);
    if (replacement) {
      const parsed = parseMetricKey(entry.spec.metricKey);
      entry.spec.sourceFeed = replacement;
      if (parsed?.feedKey && STALE_COUNT_FEED_REPLACEMENTS.get(parsed.feedKey) === replacement) {
        entry.spec.metricKey = `${replacement}|${entry.spec.metricKey.slice(parsed.feedKey.length + 1)}`;
      }
    }
    migratePendingCountEntryToJudged(entry);
  }
}

// Families whose count-resolution feed is unavailable (empty without ACLED
// credentials) — existing pending hard-count ledger entries are reclassified to
// judged so they resolve via the LLM judge instead of pending/VOID forever.
// Mirrors the generator-side flag gates in _forecast-resolution.mjs.
// #5136 (conflict), #5091 (unrest).
const UNAVAILABLE_COUNT_FEED_MIGRATIONS = [
  { feed: CONFLICT_COUNT_SOURCE_FEED, available: () => CONFLICT_COUNT_FEED_AVAILABLE, buildQuestion: buildConflictJudgedQuestionForEntry },
  { feed: UNREST_COUNT_SOURCE_FEED, available: () => UNREST_COUNT_FEED_AVAILABLE, buildQuestion: buildUnrestJudgedQuestionForEntry },
];

function migratePendingCountEntryToJudged(entry) {
  if (entry?.status !== 'pending' || entry.spec?.kind !== 'hard') return;
  const migration = UNAVAILABLE_COUNT_FEED_MIGRATIONS.find(
    (m) => m.feed === entry.spec.sourceFeed && !m.available(),
  );
  if (!migration) return;
  const parsed = parseMetricKey(entry.spec.metricKey);
  if (parsed?.fn !== 'count') return;

  const deadline = toFiniteNumber(entry.deadline ?? entry.spec.deadline);
  entry.spec = {
    kind: 'judged',
    metricKey: null,
    operator: null,
    threshold: null,
    baselineValue: null,
    window: null,
    deadline: deadline ?? entry.spec.deadline,
    sourceFeed: null,
    question: migration.buildQuestion(entry),
  };
  entry.status = 'pending-judge';
  entry.samples = { count: 0, recent: [] };
}

function buildConflictJudgedQuestionForEntry(entry) {
  const title = entry.title || '(untitled forecast)';
  const region = entry.region || 'unspecified region';
  const horizon = entry.timeHorizon || 'unspecified horizon';
  return `Within the ${horizon} horizon, did ${region} experience a materially escalated level of armed conflict versus its recent baseline, consistent with "${title}"?`;
}

function buildUnrestJudgedQuestionForEntry(entry) {
  const title = entry.title || '(untitled forecast)';
  const region = entry.region || 'unspecified region';
  const horizon = entry.timeHorizon || 'unspecified horizon';
  return `Within the ${horizon} horizon, did ${region} experience a materially elevated level of civil unrest or political instability versus its recent baseline, consistent with "${title}"?`;
}

export function samplePendingEntries(ledger, feedsByKey, nowMs) {
  for (const entry of Object.values(ledger)) {
    if (entry.status !== 'pending') continue;
    const parsed = parseMetricKey(entry.spec?.metricKey);
    if (!parsed || parsed.fn === 'count') continue;
    const deadline = Number(entry.deadline ?? entry.spec?.deadline);
    const isPointWindow = entry.spec?.window === 'at-deadline' || entry.spec?.window === 'at-endDate';
    if (!isPointWindow && nowMs > deadline) continue;
    if (isPointWindow && nowMs > deadline && hasSampleAtOrAfterDeadline(entry.samples, deadline)) continue;
    const feedData = feedsByKey?.[entry.spec.sourceFeed] ?? feedsByKey?.[parsed.feedKey];
    if (feedData == null) {
      entry.samples = appendSample(entry.samples, { ts: nowMs, error: `missing_feed:${entry.spec.sourceFeed || parsed.feedKey}` });
      continue;
    }
    const value = extractMetricValue(parsed, feedData);
    entry.samples = Number.isFinite(value)
      ? appendSample(entry.samples, { ts: nowMs, value })
      : appendSample(entry.samples, { ts: nowMs, error: 'metric_not_found' });
  }
}

export function resolveDueEntries(ledger, feedsByKey, nowMs) {
  const receipts = [];
  for (const [key, entry] of Object.entries(ledger)) {
    if (entry.status !== 'pending') continue;
    const parsed = parseMetricKey(entry.spec?.metricKey);
    const feedData = feedsByKey?.[entry.spec?.sourceFeed] ?? feedsByKey?.[parsed?.feedKey];
    const result = resolveHardSpec(entry, feedData, entry.samples, nowMs);
    if (result.status !== 'resolved') continue;

    entry.status = 'resolved';
    entry.outcome = result.outcome;
    entry.resolvedAt = nowMs;
    entry.sealedAt = nowMs;
    entry.evidence = result.evidence;
    receipts.push({ key, entry: cloneJson(entry), resolvedAt: nowMs });
  }
  return receipts;
}

export function collectUnarchivedReceipts(ledger) {
  return Object.entries(normalizeLedger(ledger))
    .filter(([, entry]) => entry?.status === 'resolved')
    .filter(([, entry]) => !entry.receiptArchivedAt)
    .map(([key, entry]) => ({
      key,
      entry: cloneJson(entry),
      resolvedAt: Number(entry.resolvedAt || entry.sealedAt || Date.now()),
    }));
}

export function markReceiptsArchived(ledger, archivedReceipts, archivedAt) {
  for (const archived of archivedReceipts || []) {
    const entry = ledger?.[archived.key];
    if (!entry || entry.status !== 'resolved') continue;
    entry.receiptArchivedAt = archivedAt;
    if (archived.objectKey) entry.receiptArchiveKey = archived.objectKey;
  }
  return ledger;
}

export function appendSample(samples, sample) {
  const current = samples && typeof samples === 'object'
    ? { ...samples, recent: [...(samples.recent || [])] }
    : { count: 0, recent: [] };
  if (current.recent.at(-1)?.ts === sample.ts) return current;

  current.count = Number(current.count || 0) + 1;
  current.last = sample;
  if (!current.first) current.first = sample;
  if (Number.isFinite(sample.value)) {
    current.min = Number.isFinite(current.min) ? Math.min(current.min, sample.value) : sample.value;
    current.max = Number.isFinite(current.max) ? Math.max(current.max, sample.value) : sample.value;
  }
  current.recent.push(sample);
  if (current.recent.length > MAX_RECENT_SAMPLES) {
    current.recent = current.recent.slice(-MAX_RECENT_SAMPLES);
  }
  return current;
}

function hasSampleAtOrAfterDeadline(samples, deadline) {
  if (!Number.isFinite(deadline)) return false;
  return Array.isArray(samples?.recent)
    && samples.recent.some((sample) => Number(sample?.ts) >= deadline && Number.isFinite(Number(sample?.value)));
}

function createEntry(id, forecast, spec, generatedAt, snapshotAt, deadline) {
  const status = spec.kind === 'judged' ? 'pending-judge' : 'pending';
  return pruneUndefined({
    id,
    key: `${id}@${deadline}`,
    domain: forecast.domain || 'unknown',
    region: forecast.region || '',
    title: forecast.title || '',
    timeHorizon: forecast.timeHorizon || '',
    generationOrigin: forecast.generationOrigin || forecast.origin || 'unknown',
    spec: cloneJson(spec),
    probability: Number(forecast.probability),
    firstSeenProbability: Number(forecast.probability),
    calibration: forecast.calibration ? cloneJson(forecast.calibration) : undefined,
    generatedAt,
    deadline,
    firstSeenAt: snapshotAt,
    lastSeenAt: snapshotAt,
    status,
    samples: { count: 0, recent: [] },
  });
}

function updateOpenWindow(entry, forecast, generatedAt, snapshotAt) {
  if (entry.status !== 'pending' && entry.status !== 'pending-judge') return;
  if (generatedAt >= entry.deadline) return;
  const probability = Number(forecast.probability);
  if (Number.isFinite(probability)) entry.probability = probability;
  entry.lastSeenAt = Math.max(Number(entry.lastSeenAt || 0), snapshotAt);
}

function findOpenWindowKey(ledger, id, generatedAt) {
  return Object.keys(ledger)
    .filter((key) => ledger[key]?.id === id)
    .filter((key) => ledger[key].status === 'pending' || ledger[key].status === 'pending-judge')
    .filter((key) => generatedAt < Number(ledger[key].deadline))
    .sort((a, b) => Number(ledger[a].deadline) - Number(ledger[b].deadline))[0] || null;
}

function normalizeLedger(ledger) {
  const data = unwrapEnvelope(ledger).data;
  if (!data) return {};
  if (Array.isArray(data)) return Object.fromEntries(data.filter(Boolean).map((entry) => [entry.key || `${entry.id}@${entry.deadline}`, entry]));
  if (typeof data === 'object') return data;
  return {};
}

function sortLedger(ledger) {
  return Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

async function readRedisJson(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis GET ${key} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload.result == null) return null;
  return JSON.parse(payload.result);
}

async function readForecastHistory(limit = 200) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(['LRANGE', HISTORY_KEY, 0, Math.max(0, limit - 1)]),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis LRANGE ${HISTORY_KEY} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  return (Array.isArray(payload.result) ? payload.result : [])
    .map((row) => {
      try { return JSON.parse(row); } catch { return null; }
    })
    .filter(Boolean);
}

async function readResolutionFeeds(ledger) {
  const keys = [...new Set(Object.values(ledger)
    .filter((entry) => entry.status === 'pending')
    .map((entry) => entry.spec?.sourceFeed)
    .filter(Boolean))];
  const results = await Promise.allSettled(keys.map(async (key) => [key, await readRedisJson(key)]));
  const pairs = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      pairs.push(result.value);
    } else {
      console.warn(`  [forecast-resolutions] feed ${keys[index]} unavailable: ${result.reason?.message || result.reason}`);
    }
  }
  return Object.fromEntries(pairs);
}

async function readJudgedNewsArchiveForLedger(ledger, nowMs, options = {}) {
  const dueEntries = Object.values(normalizeLedger(ledger))
    .filter((entry) => entry?.status === 'pending-judge')
    .filter((entry) => Number(entry.deadline ?? entry.spec?.deadline) <= nowMs);
  if (!dueEntries.length) return { items: [], available: false };

  const windowStartMs = Math.min(...dueEntries.map((entry) => judgedArchiveWindowForEntry(entry, nowMs).startMs));
  try {
    return await readDigestAccumulatorArchive(windowStartMs, nowMs, options);
  } catch (err) {
    console.warn(`  [forecast-resolutions] judged archive unavailable: ${err?.message || err}`);
    return { items: [], available: false };
  }
}

export async function readDigestAccumulatorArchive(windowStartMs, nowMs, options = {}) {
  const { url, token } = getArchiveRedisCredentials(options);
  const coverageStartMs = Math.max(windowStartMs, nowMs - JUDGED_ARCHIVE_RETENTION_MS);
  const maxHashes = Number.isFinite(options.maxHashes)
    ? Math.max(1, Math.floor(options.maxHashes))
    : envPositiveInt('FORECAST_RESOLUTION_JUDGE_ARCHIVE_HASH_LIMIT', DEFAULT_JUDGED_ARCHIVE_HASH_LIMIT);
  const base = {
    requestedStartMs: windowStartMs,
    requestedEndMs: nowMs,
    coverageStartMs,
    coverageEndMs: nowMs,
  };
  const zsetResp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify([
      'ZREVRANGEBYSCORE',
      JUDGED_ARCHIVE_KEY,
      String(nowMs),
      String(coverageStartMs),
      'LIMIT',
      '0',
      String(maxHashes),
    ]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!zsetResp.ok) throw new Error(`Redis ZREVRANGEBYSCORE ${JUDGED_ARCHIVE_KEY} failed: HTTP ${zsetResp.status}`);
  const zsetPayload = await zsetResp.json();
  const hashes = Array.isArray(zsetPayload.result) ? zsetPayload.result.filter(Boolean) : [];
  if (!hashes.length) return { ...base, items: [], available: true };

  const selectedHashes = hashes.slice(0, maxHashes);
  const truncated = hashes.length >= maxHashes;
  if (truncated) {
    console.warn(`  [forecast-resolutions] judged archive hash cap reached (${selectedHashes.length}/${maxHashes}) for ${new Date(coverageStartMs).toISOString()}..${new Date(nowMs).toISOString()}; increase FORECAST_RESOLUTION_JUDGE_ARCHIVE_HASH_LIMIT or page the archive scan`);
  }
  const pipelineResp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(selectedHashes.map((hash) => ['HGETALL', `story:track:v1:${hash}`])),
    signal: AbortSignal.timeout(options.archiveTimeoutMs ?? 15_000),
  });
  if (!pipelineResp.ok) throw new Error(`Redis story-track pipeline failed: HTTP ${pipelineResp.status}`);
  const pipelinePayload = await pipelineResp.json();
  if (!Array.isArray(pipelinePayload) || pipelinePayload.length !== selectedHashes.length) {
    throw new Error(`Redis story-track pipeline returned ${Array.isArray(pipelinePayload) ? pipelinePayload.length : 'non-array'} of ${selectedHashes.length}`);
  }
  const rows = pipelinePayload;
  const items = [];
  let missingRows = 0;
  for (let index = 0; index < selectedHashes.length; index += 1) {
    if (rows[index]?.error) {
      throw new Error(`Redis story-track pipeline row ${index} failed: ${rows[index].error}`);
    }
    const raw = rows[index]?.result;
    const flat = normalizeRedisHashResult(raw);
    if (!flat) {
      throw new Error(`Redis story-track pipeline row ${index} returned invalid HGETALL result`);
    }
    if (flat.length === 0) {
      missingRows += 1;
      continue;
    }
    const track = flatArrayToObject(flat);
    items.push(pruneUndefined({
      id: `N${items.length + 1}`,
      hash: selectedHashes[index],
      title: track.title,
      description: track.description,
      url: track.link || track.url,
      source: track.source || track.publisher || track.domain,
      publishedAt: toFiniteMs(track.publishedAt ?? track.lastSeen ?? track.firstSeen),
      severity: track.severity,
      currentScore: toFiniteNumber(track.currentScore ?? track.score),
    }));
  }
  return { ...base, items: normalizeJudgedArchiveItems(items), available: true, truncated: truncated || missingRows > 0, missingRows };
}

function getArchiveRedisCredentials(options = {}) {
  const env = options.env || process.env;
  const url = options.redisUrl || env.UPSTASH_REDIS_REST_URL;
  const token = options.redisToken || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  return { url, token };
}

function normalizeRedisHashResult(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.entries(raw).flat();
  return null;
}

function flatArrayToObject(flat) {
  const obj = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

function buildLiveJudgedOptions(nowMs = Date.now()) {
  return {
    maxJudgedEntries: envPositiveInt('FORECAST_RESOLUTION_JUDGE_MAX_PER_RUN', DEFAULT_JUDGED_MAX_PER_RUN),
    maxArchiveItems: envPositiveInt('FORECAST_RESOLUTION_JUDGE_ARCHIVE_ITEMS', DEFAULT_JUDGED_ARCHIVE_ITEMS),
    judgeStageBudgetMs: envPositiveInt('FORECAST_RESOLUTION_JUDGE_STAGE_BUDGET_MS', 35_000),
    deadlineMs: nowMs + envPositiveInt('FORECAST_RESOLUTION_JUDGE_RUN_BUDGET_MS', DEFAULT_JUDGED_RUN_BUDGET_MS),
  };
}

async function buildLedgerForRun() {
  const nowMs = Date.now();
  const [existingLedger, history] = await Promise.all([
    readRedisJson(RESOLUTIONS_KEY),
    readForecastHistory(200),
  ]);
  const preLedger = ingestHistory(existingLedger || {}, history, nowMs);
  const feeds = await readResolutionFeeds(preLedger);
  const judgedOptions = buildLiveJudgedOptions(nowMs);
  const judgedArchive = await readJudgedNewsArchiveForLedger(preLedger, nowMs, judgedOptions);
  const result = await processResolutionCycleWithJudges(preLedger, [], feeds, judgedArchive, nowMs, judgedOptions);
  const receiptsForArchive = collectUnarchivedReceipts(result.ledger);
  const archivedReceipts = await appendR2Receipts(receiptsForArchive);
  markReceiptsArchived(result.ledger, archivedReceipts, Date.now());
  console.log(`  Resolution ledger entries: ${Object.keys(result.ledger).length}`);
  console.log(`  Terminal receipts resolved this cycle: ${result.receipts.length}`);
  console.log(`  Terminal receipts queued for R2: ${receiptsForArchive.length}`);
  console.log(`  R2 receipts archived: ${archivedReceipts.length}`);
  return result.ledger;
}

async function dryRun() {
  const nowMs = Date.now();
  const [existingLedger, history] = await Promise.all([
    readRedisJson(RESOLUTIONS_KEY).catch(() => null),
    readForecastHistory(200),
  ]);
  const preLedger = ingestHistory(existingLedger || {}, history, nowMs);
  const feeds = await readResolutionFeeds(preLedger);
  const judgedOptions = buildLiveJudgedOptions(nowMs);
  const judgedArchive = await readJudgedNewsArchiveForLedger(preLedger, nowMs, judgedOptions);
  const dryRunJudgeModels = [
    async () => null,
    async () => null,
  ];
  const result = await processResolutionCycleWithJudges(preLedger, [], feeds, judgedArchive, nowMs, {
    ...judgedOptions,
    judgeModels: dryRunJudgeModels,
  });
  const entries = Object.values(result.ledger);
  const summary = {
    dryRun: true,
    judgedMode: 'no-llm',
    historySnapshots: history.length,
    ledgerEntries: entries.length,
    pending: entries.filter((entry) => entry.status === 'pending').length,
    pendingJudge: entries.filter((entry) => entry.status === 'pending-judge').length,
    resolved: entries.filter((entry) => entry.status === 'resolved').length,
    newReceipts: result.receipts.length,
    scorecardTotals: result.scorecard.totals,
  };
  console.log(JSON.stringify(summary, null, 2));
}

export async function appendR2Receipts(receipts, options = {}) {
  if (!receipts.length) return [];
  const putObject = options.putObject || putR2JsonObject;
  const config = resolveR2StorageConfig(options.env || process.env, { prefixEnv: 'CLOUDFLARE_R2_FORECAST_RESOLUTION_PREFIX' });
  if (!config) {
    console.warn(`  [forecast-resolutions] R2 not configured; skipped ${receipts.length} receipt append(s)`);
    return [];
  }
  const archived = [];
  for (const receipt of receipts) {
    try {
      const day = new Date(receipt.resolvedAt).toISOString().slice(0, 10);
      const safeKey = receipt.key.replace(/[^a-zA-Z0-9@._-]+/g, '_');
      const key = `${config.basePrefix}/forecast-resolutions/${day}/${safeKey}-${receipt.resolvedAt}.json`;
      await putObject(config, key, receipt, {
        kind: 'forecast-resolution',
        outcome: receipt.entry?.outcome || 'unknown',
      });
      archived.push({ key: receipt.key, objectKey: key });
      console.log(`  [forecast-resolutions] R2 receipt: ${key}`);
    } catch (err) {
      console.warn(`  [forecast-resolutions] R2 receipt failed for ${receipt.key}: ${err?.message || err}`);
    }
  }
  return archived;
}

if (DIRECT_RUN && process.argv.includes('--dry-run')) {
  await dryRun();
} else if (DIRECT_RUN) {
  await runSeed('forecast', 'resolutions', RESOLUTIONS_KEY, buildLedgerForRun, {
    // Persistent working ledger: no ttlSeconds by design (#5007 R11).
    validateFn: (ledger) => ledger && typeof ledger === 'object' && !Array.isArray(ledger),
    declareRecords,
    sourceVersion: RESOLUTION_SOURCE_VERSION,
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    zeroIsValid: true,
    maxStaleMin: 2160,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 150_000,
    extraKeys: [{
      key: SCORECARD_KEY,
      ttl: SCORECARD_TTL_SECONDS,
      transform: (ledger) => computeScorecard(ledger, Date.now()),
      declareRecords: declareScorecardRecords,
      metaKey: SCORECARD_META_KEY,
      metaCritical: true,
    }],
  });
}
