#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import {
  findDuplicateStateUnitLabels,
  readForecastTraceArtifactsForRun,
} from './seed-forecasts.mjs';
import { putR2JsonObject } from './_r2-storage.mjs';

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
  };
}

function buildCheck(name, pass, severity = 'error', details = {}) {
  return { name, pass, severity, ...details };
}

function hasHighValueDeepCandidate(snapshot = null) {
  const candidates = Array.isArray(snapshot?.impactExpansionCandidates) ? snapshot.impactExpansionCandidates : [];
  return candidates.some((packet) => {
    const topBucket = String(packet?.marketContext?.topBucketId || '').toLowerCase();
    const stateKind = String(packet?.stateKind || '').toLowerCase();
    return Boolean(packet?.routeFacilityKey)
      || Boolean(packet?.commodityKey)
      || stateKind.includes('maritime')
      || stateKind.includes('transport')
      || ['energy', 'supply_chain', 'shipping', 'fx_stress', 'sovereign_risk'].includes(topBucket);
  });
}

function evaluateForecastRunArtifacts(artifacts = {}) {
  const summary = artifacts.summary || {};
  const worldState = artifacts.worldState || {};
  const runStatus = artifacts.runStatus || null;
  const snapshot = artifacts.snapshot || null;
  const fullRunStateUnits = Array.isArray(snapshot?.fullRunStateUnits) ? snapshot.fullRunStateUnits : [];
  const selectedStateIds = Array.isArray(summary?.deepForecast?.selectedStateIds)
    ? summary.deepForecast.selectedStateIds
    : Array.isArray(runStatus?.selectedDeepStateIds)
      ? runStatus.selectedDeepStateIds
      : [];
  const knownStateIds = new Set(fullRunStateUnits.map((unit) => unit?.id).filter(Boolean));
  const unresolvedSelectedStateIds = selectedStateIds.filter((id) => !knownStateIds.has(id));
  const duplicateLabels = findDuplicateStateUnitLabels(fullRunStateUnits);
  const simulationInteractionCount = Number(worldState?.simulationState?.interactionLedger?.length || summary?.worldStateSummary?.simulationInteractionCount || 0);
  const reportableInteractionCount = Number(worldState?.simulationState?.reportableInteractionLedger?.length || summary?.worldStateSummary?.reportableInteractionCount || 0);
  const candidateSupplyChainCount = Number(summary?.quality?.candidateRun?.domainCounts?.supply_chain || 0);
  const publishedSupplyChainCount = Number(summary?.quality?.traced?.domainCounts?.supply_chain || 0);
  const mappedSignalCount = Number(worldState?.impactExpansion?.mappedSignalCount || summary?.worldStateSummary?.impactExpansionMappedSignalCount || 0);
  const eligibleStateCount = Number(summary?.deepForecast?.eligibleStateCount || runStatus?.eligibleStateIds?.length || 0);
  const convergence = artifacts.impactExpansionDebug?.convergence || null;
  const convergenceQualityMet = convergence === null ? true : convergence.converged === true;
  const convergenceFinalComposite = convergence?.finalComposite ?? null;

  const checks = [
    buildCheck('run_status_present', !!runStatus, 'error'),
    buildCheck('deep_snapshot_present', !!snapshot, 'error'),
    buildCheck('selected_state_ids_resolve', unresolvedSelectedStateIds.length === 0, 'error', {
      unresolvedSelectedStateIds,
    }),
    buildCheck('duplicate_canonical_state_labels', duplicateLabels.length === 0, 'error', {
      duplicateLabels,
    }),
    buildCheck('reportable_interactions_are_subset', reportableInteractionCount < simulationInteractionCount || simulationInteractionCount === 0, 'error', {
      reportableInteractionCount,
      simulationInteractionCount,
    }),
    buildCheck('supply_chain_survives_when_candidate_present', candidateSupplyChainCount === 0 || publishedSupplyChainCount > 0, 'warn', {
      candidateSupplyChainCount,
      publishedSupplyChainCount,
    }),
    buildCheck('eligible_high_value_deep_run_materializes_mapped_signals', eligibleStateCount === 0 || !hasHighValueDeepCandidate(snapshot) || mappedSignalCount > 0, 'error', {
      eligibleStateCount,
      mappedSignalCount,
    }),
    buildCheck('convergence_quality_met', convergenceQualityMet, 'warn', {
      convergenceFinalComposite,
      convergenceThreshold: 0.80,
    }),
  ];

  const failures = checks.filter((check) => !check.pass && check.severity === 'error');
  const warnings = checks.filter((check) => !check.pass && check.severity !== 'error');
  return {
    runId: summary.runId || runStatus?.forecastRunId || '',
    generatedAt: summary.generatedAt || artifacts.generatedAt || 0,
    forecastDepth: summary.forecastDepth || worldState.forecastDepth || 'fast',
    deepForecastStatus: summary.deepForecast?.status || runStatus?.status || '',
    pass: failures.length === 0,
    status: failures.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    failureCount: failures.length,
    warningCount: warnings.length,
    metrics: {
      eligibleStateCount,
      mappedSignalCount,
      candidateSupplyChainCount,
      publishedSupplyChainCount,
      simulationInteractionCount,
      reportableInteractionCount,
    },
    checks,
  };
}

async function evaluateForecastRun({ runId }) {
  if (!runId) throw new Error('Missing --run-id');
  const artifacts = await readForecastTraceArtifactsForRun(runId);
  const evaluation = evaluateForecastRunArtifacts(artifacts);
  if (artifacts.storageConfig) {
    await putR2JsonObject(artifacts.storageConfig, artifacts.keys.forecastEvalKey, evaluation, {
      runid: String(runId || ''),
      kind: 'forecast_eval',
    });
  }
  return evaluation;
}

if (_isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  const evaluation = await evaluateForecastRun(options);
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.pass) process.exit(1);
}

export {
  parseArgs,
  hasHighValueDeepCandidate,
  evaluateForecastRunArtifacts,
  evaluateForecastRun,
};
