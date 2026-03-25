#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import { HISTORY_KEY } from './seed-forecasts.mjs';

const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) loadEnvFile(import.meta.url);

const NOISE_SIGNAL_TYPES = new Set(['news_corroboration']);

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function toBenchmarkForecast(entry) {
  return {
    domain: entry.domain,
    region: entry.region,
    title: entry.title,
    probability: entry.probability,
    confidence: entry.confidence,
    timeHorizon: entry.timeHorizon,
    trend: entry.trend,
    signals: entry.signals || [],
    newsContext: entry.newsContext || [],
    calibration: entry.calibration || null,
    cascades: entry.cascades || [],
  };
}

function summarizeObservedChange(current, prior) {
  const currentSignals = new Set((current.signals || [])
    .filter(signal => !NOISE_SIGNAL_TYPES.has(signal.type))
    .map(signal => signal.value));
  const priorSignals = new Set((prior.signals || [])
    .filter(signal => !NOISE_SIGNAL_TYPES.has(signal.type))
    .map(signal => signal.value));
  const currentHeadlines = new Set(current.newsContext || []);
  const priorHeadlines = new Set(prior.newsContext || []);
  const deltaProbability = +(current.probability - prior.probability).toFixed(3);
  const newSignals = [...currentSignals].filter(value => !priorSignals.has(value));
  const newHeadlines = [...currentHeadlines].filter(value => !priorHeadlines.has(value));
  const marketMove = current.calibration && prior.calibration
    && current.calibration.marketTitle === prior.calibration.marketTitle
    ? +((current.calibration.marketPrice || 0) - (prior.calibration.marketPrice || 0)).toFixed(3)
    : null;

  return {
    deltaProbability,
    trend: current.trend,
    newSignals,
    newHeadlines,
    marketMove,
  };
}

function buildBenchmarkCandidate(current, prior, snapshotAt) {
  const eventDate = new Date(snapshotAt).toISOString().slice(0, 10);
  const observedChange = summarizeObservedChange(current, prior);
  return {
    name: `${slugify(current.title)}_${eventDate.replace(/-/g, '_')}`,
    eventDate,
    description: `${current.title} moved from ${Math.round(prior.probability * 100)}% to ${Math.round(current.probability * 100)}% between consecutive forecast snapshots.`,
    priorForecast: toBenchmarkForecast(prior),
    forecast: toBenchmarkForecast(current),
    observedChange,
  };
}

function scoreCandidate(candidate) {
  const absDelta = Math.abs(candidate.observedChange.deltaProbability || 0);
  const signalBonus = Math.min(0.15, (candidate.observedChange.newSignals?.length || 0) * 0.05);
  const marketBonus = Math.min(0.15, Math.abs(candidate.observedChange.marketMove || 0) * 0.7);
  const hasStructuredChange = absDelta >= 0.03
    || (candidate.observedChange.newSignals?.length || 0) > 0
    || Math.abs(candidate.observedChange.marketMove || 0) >= 0.03;
  const headlineBonus = hasStructuredChange
    ? Math.min(0.04, (candidate.observedChange.newHeadlines?.length || 0) * 0.02)
    : 0;
  return +(absDelta + signalBonus + headlineBonus + marketBonus).toFixed(3);
}

function selectBenchmarkCandidates(historySnapshots, options = {}) {
  const minDelta = options.minDelta ?? 0.08;
  const minMarketMove = options.minMarketMove ?? 0.08;
  const maxCandidates = options.maxCandidates ?? 10;
  const minInterestingness = options.minInterestingness ?? 0.12;
  const candidates = [];

  for (let i = 0; i < historySnapshots.length - 1; i++) {
    const currentSnapshot = historySnapshots[i];
    const priorSnapshot = historySnapshots[i + 1];
    const priorMap = new Map((priorSnapshot?.predictions || []).map(pred => [pred.id, pred]));

    for (const current of currentSnapshot?.predictions || []) {
      const prior = priorMap.get(current.id);
      if (!prior) continue;
      const candidate = buildBenchmarkCandidate(current, prior, currentSnapshot.generatedAt);
      const interestingness = scoreCandidate(candidate);
      const hasMeaningfulStateChange =
        Math.abs(candidate.observedChange.deltaProbability) >= minDelta
        || Math.abs(candidate.observedChange.marketMove || 0) >= minMarketMove
        || (candidate.observedChange.newSignals?.length || 0) > 0;
      if (!hasMeaningfulStateChange && interestingness < minInterestingness) continue;
      if (!hasMeaningfulStateChange) continue;
      candidates.push({ ...candidate, interestingness });
    }
  }

  return candidates
    .sort((a, b) => b.interestingness - a.interestingness || b.eventDate.localeCompare(a.eventDate))
    .slice(0, maxCandidates);
}

async function readForecastHistory(key = HISTORY_KEY, limit = 60) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['LRANGE', key, 0, Math.max(0, limit - 1)]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis LRANGE failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  const rows = Array.isArray(payload?.result) ? payload.result : [];
  return rows.map(row => {
    try { return JSON.parse(row); } catch { return null; }
  }).filter(Boolean);
}

if (_isDirectRun) {
  const limitArg = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || 60);
  const maxArg = Number(process.argv.find(arg => arg.startsWith('--max-candidates='))?.split('=')[1] || 10);
  const history = await readForecastHistory(HISTORY_KEY, limitArg);
  const candidates = selectBenchmarkCandidates(history, { maxCandidates: maxArg });
  console.log(JSON.stringify({ key: HISTORY_KEY, snapshots: history.length, candidates }, null, 2));
}

export {
  toBenchmarkForecast,
  summarizeObservedChange,
  buildBenchmarkCandidate,
  scoreCandidate,
  selectBenchmarkCandidates,
  readForecastHistory,
};
