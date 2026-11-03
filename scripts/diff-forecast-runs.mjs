#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import { readForecastTraceArtifactsForRun } from './seed-forecasts.mjs';

const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) loadEnvFile(import.meta.url);

function parseArgs(argv = []) {
  const values = new Map();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    values.set(key, rest.length > 0 ? rest.join('=') : 'true');
  }
  return {
    baseline: values.get('baseline') || '',
    candidate: values.get('candidate') || '',
  };
}

function diffNumberMap(left = {}, right = {}) {
  const keys = [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].sort();
  const diff = {};
  for (const key of keys) {
    diff[key] = Number((right?.[key] || 0) - (left?.[key] || 0));
  }
  return diff;
}

function extractStateLabels(artifacts = {}) {
  const labels = Array.isArray(artifacts.snapshot?.fullRunStateUnits)
    ? artifacts.snapshot.fullRunStateUnits.map((item) => item?.label).filter(Boolean)
    : Array.isArray(artifacts.worldState?.stateUnits)
      ? artifacts.worldState.stateUnits.map((item) => item?.label).filter(Boolean)
      : [];
  return [...new Set(labels)].sort();
}

// A candidate's Brier can be compared with a baseline's only when both runs
// forecast from one frozen emission snapshot and are scored on the same
// id@deadline windows (#7072). No run archives the inputs it forecast from
// (#7073), and the ledger's recorded Brier scores the code that emitted each
// forecast, not the candidate, so the diff states the comparison is
// unavailable instead of reporting a number.
const CANDIDATE_BRIER_DELTA = Object.freeze({
  status: 'unavailable',
  reason: 'emission_snapshot_required',
  detail: 'Both runs must forecast from one frozen emission snapshot and be scored on the same id@deadline resolution windows; no run archives its emission inputs yet.',
});

function diffForecastRuns(baselineArtifacts = {}, candidateArtifacts = {}) {
  const baselineSummary = baselineArtifacts.summary || {};
  const candidateSummary = candidateArtifacts.summary || {};
  const baselineTopTitles = new Set((baselineSummary.topForecasts || []).map((item) => item.title));
  const candidateTopTitles = new Set((candidateSummary.topForecasts || []).map((item) => item.title));
  const baselineLabels = new Set(extractStateLabels(baselineArtifacts));
  const candidateLabels = new Set(extractStateLabels(candidateArtifacts));
  return {
    baselineRunId: baselineSummary.runId || '',
    candidateRunId: candidateSummary.runId || '',
    forecastDepth: {
      baseline: baselineSummary.forecastDepth || '',
      candidate: candidateSummary.forecastDepth || '',
    },
    deepForecastStatus: {
      baseline: baselineSummary.deepForecast?.status || '',
      candidate: candidateSummary.deepForecast?.status || '',
    },
    tracedForecastCountDelta: Number((candidateSummary.tracedForecastCount || 0) - (baselineSummary.tracedForecastCount || 0)),
    impactExpansionDelta: {
      candidateCount: Number((candidateSummary.worldStateSummary?.impactExpansionCandidateCount || 0) - (baselineSummary.worldStateSummary?.impactExpansionCandidateCount || 0)),
      mappedSignalCount: Number((candidateSummary.worldStateSummary?.impactExpansionMappedSignalCount || 0) - (baselineSummary.worldStateSummary?.impactExpansionMappedSignalCount || 0)),
    },
    interactionDelta: {
      simulation: Number((candidateSummary.worldStateSummary?.simulationInteractionCount || 0) - (baselineSummary.worldStateSummary?.simulationInteractionCount || 0)),
      reportable: Number((candidateSummary.worldStateSummary?.reportableInteractionCount || 0) - (baselineSummary.worldStateSummary?.reportableInteractionCount || 0)),
    },
    publishedDomainDelta: diffNumberMap(
      baselineSummary.quality?.traced?.domainCounts || {},
      candidateSummary.quality?.traced?.domainCounts || {},
    ),
    addedTopForecastTitles: [...candidateTopTitles].filter((title) => !baselineTopTitles.has(title)).sort(),
    removedTopForecastTitles: [...baselineTopTitles].filter((title) => !candidateTopTitles.has(title)).sort(),
    addedStateLabels: [...candidateLabels].filter((label) => !baselineLabels.has(label)).sort(),
    removedStateLabels: [...baselineLabels].filter((label) => !candidateLabels.has(label)).sort(),
    candidateBrierDelta: { ...CANDIDATE_BRIER_DELTA },
  };
}

async function diffForecastRunIds({ baseline, candidate }) {
  if (!baseline || !candidate) throw new Error('Missing --baseline or --candidate');
  const [baselineArtifacts, candidateArtifacts] = await Promise.all([
    readForecastTraceArtifactsForRun(baseline),
    readForecastTraceArtifactsForRun(candidate),
  ]);
  return diffForecastRuns(baselineArtifacts, candidateArtifacts);
}

if (_isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  const diff = await diffForecastRunIds(options);
  console.log(JSON.stringify(diff, null, 2));
}

export {
  CANDIDATE_BRIER_DELTA,
  parseArgs,
  diffNumberMap,
  diffForecastRuns,
  diffForecastRunIds,
};
