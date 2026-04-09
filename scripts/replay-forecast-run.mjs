#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
import {
  buildForecastTraceArtifacts,
  evaluateDeepForecastPaths,
  extractImpactExpansionBundle,
  readForecastTraceArtifactsForRun,
} from './seed-forecasts.mjs';
import { getR2JsonObject } from './_r2-storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
    runId: values.get('run-id') || '',
    mode: values.get('mode') || 'deep',
    providerMode: values.get('provider-mode') || 'recorded',
    output: values.get('output') || '',
  };
}

function buildEmptyImpactExpansionBundle(snapshot, failureReason) {
  const candidatePackets = Array.isArray(snapshot?.impactExpansionCandidates) ? snapshot.impactExpansionCandidates : [];
  return {
    source: 'none',
    provider: '',
    model: '',
    parseStage: '',
    parseMode: '',
    rawPreview: '',
    failureReason,
    candidateCount: candidatePackets.length,
    extractedCandidateCount: 0,
    extractedHypothesisCount: 0,
    partialFailureCount: 0,
    successfulCandidateCount: 0,
    failedCandidatePreview: [],
    candidates: candidatePackets.map((packet) => ({
      candidateIndex: packet.candidateIndex,
      candidateStateId: packet.candidateStateId,
      label: packet.candidateStateLabel,
    })),
    candidatePackets,
    extractedCandidates: [],
  };
}

function buildReplayOutputPath(runId, mode, providerMode, explicitOutput = '') {
  if (explicitOutput) return explicitOutput;
  return join(__dirname, 'data', 'forecast-replays', `${runId}--${mode}--${providerMode}.json`);
}

function buildDeepReplayForecast(snapshot, evaluation) {
  return {
    ...(snapshot?.deepForecast || {}),
    status: evaluation?.status || 'completed_no_material_change',
    completedAt: new Date().toISOString(),
    selectedStateIds: (evaluation?.selectedPaths || [])
      .filter((path) => path.type === 'expanded')
      .map((path) => path.candidateStateId),
    selectedPathCount: (evaluation?.selectedPaths || []).filter((path) => path.type === 'expanded').length,
    replacedFastRun: evaluation?.status === 'completed',
    rejectedPathsPreview: (evaluation?.rejectedPaths || []).slice(0, 6).map((path) => ({
      pathId: path.pathId,
      candidateStateId: path.candidateStateId,
      acceptanceScore: Number(path.acceptanceScore || 0),
      pathScore: Number(path.pathScore || 0),
    })),
  };
}

async function resolveReplayBundle({ providerMode, artifacts, snapshot, priorWorldState }) {
  if (providerMode === 'recorded') {
    return artifacts.impactExpansionDebug?.impactExpansionBundle
      || buildEmptyImpactExpansionBundle(snapshot, 'recorded_bundle_missing');
  }
  if (providerMode === 'none') {
    return buildEmptyImpactExpansionBundle(snapshot, 'provider_mode_none');
  }
  return await extractImpactExpansionBundle({
    candidatePackets: snapshot.impactExpansionCandidates || [],
    priorWorldState,
  });
}

async function replayForecastRun({
  runId,
  mode = 'deep',
  providerMode = 'recorded',
  output = '',
} = {}) {
  if (!runId) throw new Error('Missing --run-id');
  const artifacts = await readForecastTraceArtifactsForRun(runId);
  if (!artifacts.snapshot) {
    throw new Error(`Missing deep snapshot for run ${runId}`);
  }
  const snapshot = artifacts.snapshot;
  const priorWorldState = snapshot.priorWorldStateKey
    ? await getR2JsonObject(artifacts.storageConfig, snapshot.priorWorldStateKey).catch(() => null)
    : null;

  let replayArtifacts;
  let bundle = null;
  let evaluation = null;

  if (mode === 'fast') {
    replayArtifacts = buildForecastTraceArtifacts({
      ...snapshot,
      priorWorldState,
      priorWorldStates: priorWorldState ? [priorWorldState] : [],
      forecastDepth: 'fast',
      deepForecast: snapshot.deepForecast || null,
      runStatusContext: {
        status: snapshot.deepForecast?.status || 'completed',
        stage: 'fast_replay',
        progressPercent: 100,
        providerMode,
        replaySourceRunId: runId,
      },
    }, {
      runId: `${runId}-replay-fast`,
    }, {
      basePrefix: 'seed-data/forecast-replays',
    });
  } else {
    bundle = await resolveReplayBundle({ providerMode, artifacts, snapshot, priorWorldState });
    evaluation = await evaluateDeepForecastPaths(
      snapshot,
      priorWorldState,
      snapshot.impactExpansionCandidates || [],
      bundle,
    );
    const deepForecast = buildDeepReplayForecast(snapshot, evaluation);
    replayArtifacts = buildForecastTraceArtifacts({
      ...snapshot,
      priorWorldState,
      priorWorldStates: priorWorldState ? [priorWorldState] : [],
      impactExpansionBundle: evaluation.impactExpansionBundle || bundle,
      deepPathEvaluation: evaluation,
      forecastDepth: 'deep',
      deepForecast,
      worldStateOverride: evaluation.deepWorldState || undefined,
      candidateWorldStateOverride: evaluation.deepWorldState || undefined,
      runStatusContext: {
        status: deepForecast.status,
        stage: 'deep_replay',
        progressPercent: 100,
        processedCandidateCount: evaluation.impactExpansionBundle?.successfulCandidateCount || 0,
        acceptedPathCount: deepForecast.selectedPathCount || 0,
        completedAt: deepForecast.completedAt,
        providerMode,
        replaySourceRunId: runId,
      },
    }, {
      runId: `${runId}-replay-deep`,
    }, {
      basePrefix: 'seed-data/forecast-replays',
    });
  }

  const payload = {
    sourceRunId: runId,
    mode,
    providerMode,
    replayedAt: new Date().toISOString(),
    snapshotKey: artifacts.snapshotKey,
    bundleSummary: bundle ? {
      source: bundle.source || '',
      parseMode: bundle.parseMode || '',
      parseStage: bundle.parseStage || '',
      successfulCandidateCount: Number(bundle.successfulCandidateCount || 0),
      extractedHypothesisCount: Number(bundle.extractedHypothesisCount || 0),
      failureReason: bundle.failureReason || '',
    } : null,
    evaluationSummary: evaluation ? {
      status: evaluation.status || '',
      selectedPathCount: (evaluation.selectedPaths || []).length,
      expandedPathCount: (evaluation.selectedPaths || []).filter((path) => path.type === 'expanded').length,
      rejectedPathCount: (evaluation.rejectedPaths || []).length,
      mappedSignalCount: Number(evaluation.deepWorldState?.impactExpansion?.mappedSignalCount || 0),
    } : null,
    artifacts: replayArtifacts,
  };

  const outputPath = buildReplayOutputPath(runId, mode, providerMode, output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    outputPath,
    payload,
  };
}

if (_isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  const result = await replayForecastRun(options);
  console.log(JSON.stringify({
    runId: options.runId,
    mode: options.mode,
    providerMode: options.providerMode,
    outputPath: result.outputPath,
    evaluationSummary: result.payload.evaluationSummary,
  }, null, 2));
}

export {
  parseArgs,
  buildEmptyImpactExpansionBundle,
  replayForecastRun,
};
