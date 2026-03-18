#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makePrediction,
  computeTrends,
  buildForecastCase,
  buildPriorForecastSnapshot,
  annotateForecastChanges,
  scoreForecastReadiness,
  computeAnalysisPriority,
} from './seed-forecasts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchmarkPaths = [
  join(__dirname, 'data', 'forecast-evaluation-benchmark.json'),
  join(__dirname, 'data', 'forecast-historical-benchmark.json'),
];

function materializeForecast(input) {
  const pred = makePrediction(
    input.domain,
    input.region,
    input.title,
    input.probability,
    input.confidence,
    input.timeHorizon,
    input.signals || [],
  );
  pred.trend = input.trend || pred.trend;
  pred.newsContext = input.newsContext || [];
  pred.calibration = input.calibration || null;
  pred.cascades = input.cascades || [];
  buildForecastCase(pred);
  return pred;
}

function evaluateEntry(entry) {
  const pred = materializeForecast(entry.forecast);
  let priorPred = null;
  let prior = null;

  if (entry.priorForecast) {
    priorPred = materializeForecast(entry.priorForecast);
    prior = { predictions: [buildPriorForecastSnapshot(priorPred)] };
    computeTrends([pred], prior);
    buildForecastCase(pred);
    annotateForecastChanges([pred], prior);
  }

  const readiness = scoreForecastReadiness(pred);
  const priority = computeAnalysisPriority(pred);
  const failures = [];
  const thresholds = entry.thresholds || {};

  if (typeof thresholds.overallMin === 'number' && readiness.overall < thresholds.overallMin) {
    failures.push(`overall ${readiness.overall} < ${thresholds.overallMin}`);
  }
  if (typeof thresholds.overallMax === 'number' && readiness.overall > thresholds.overallMax) {
    failures.push(`overall ${readiness.overall} > ${thresholds.overallMax}`);
  }
  if (typeof thresholds.groundingMin === 'number' && readiness.groundingScore < thresholds.groundingMin) {
    failures.push(`grounding ${readiness.groundingScore} < ${thresholds.groundingMin}`);
  }
  if (typeof thresholds.priorityMin === 'number' && priority < thresholds.priorityMin) {
    failures.push(`priority ${priority} < ${thresholds.priorityMin}`);
  }
  if (typeof thresholds.priorityMax === 'number' && priority > thresholds.priorityMax) {
    failures.push(`priority ${priority} > ${thresholds.priorityMax}`);
  }
  if (typeof thresholds.trend === 'string' && pred.trend !== thresholds.trend) {
    failures.push(`trend ${pred.trend} !== ${thresholds.trend}`);
  }
  for (const fragment of thresholds.changeSummaryIncludes || []) {
    if (!pred.caseFile?.changeSummary?.includes(fragment)) {
      failures.push(`changeSummary missing "${fragment}"`);
    }
  }
  for (const fragment of thresholds.changeItemsInclude || []) {
    const found = (pred.caseFile?.changeItems || []).some(item => item.includes(fragment));
    if (!found) failures.push(`changeItems missing "${fragment}"`);
  }

  return {
    name: entry.name,
    eventDate: entry.eventDate || null,
    description: entry.description || '',
    readiness,
    priority,
    trend: pred.trend,
    changeSummary: pred.caseFile?.changeSummary || '',
    changeItems: pred.caseFile?.changeItems || [],
    pass: failures.length === 0,
    failures,
  };
}

const suites = benchmarkPaths.map(benchmarkPath => {
  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
  const results = benchmark.map(evaluateEntry);
  const passed = results.filter(result => result.pass).length;
  return {
    benchmark: benchmarkPath,
    cases: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
});

const summary = {
  cases: suites.reduce((sum, suite) => sum + suite.cases, 0),
  passed: suites.reduce((sum, suite) => sum + suite.passed, 0),
  failed: suites.reduce((sum, suite) => sum + suite.failed, 0),
  suites,
};

console.log(JSON.stringify(summary, null, 2));

if (summary.failed > 0) process.exit(1);
