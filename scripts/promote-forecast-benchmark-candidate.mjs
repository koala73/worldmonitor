#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './_seed-utils.mjs';
import {
  readForecastHistory,
  selectBenchmarkCandidates,
} from './extract-forecast-benchmark-candidates.mjs';
import {
  HISTORY_KEY,
  makePrediction,
  computeTrends,
  buildForecastCase,
  buildPriorForecastSnapshot,
  annotateForecastChanges,
  scoreForecastReadiness,
  computeAnalysisPriority,
} from './seed-forecasts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = join(__dirname, 'data', 'forecast-historical-benchmark.json');
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) loadEnvFile(import.meta.url);

function roundPct(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

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

function buildSummaryExpectation(pred, priorForecast) {
  if (!priorForecast) return `new in the current run, entering at ${roundPct(pred.probability)}`;

  const delta = pred.probability - priorForecast.probability;
  if (Math.abs(delta) >= 0.05) {
    return `${delta > 0 ? 'rose' : 'fell'} from ${roundPct(priorForecast.probability)} to ${roundPct(pred.probability)}`;
  }
  return `holding near ${roundPct(pred.probability)} versus ${roundPct(priorForecast.probability)}`;
}

function buildItemExpectations(pred) {
  return (pred.caseFile?.changeItems || [])
    .filter(item => item && !item.startsWith('Evidence mix is broadly unchanged'))
    .slice(0, 3);
}

function deriveThresholds(candidate, options = {}) {
  const readinessSlack = options.readinessSlack ?? 0.06;
  const prioritySlack = options.prioritySlack ?? 0.08;
  const pred = materializeForecast(candidate.forecast);
  let prior = null;

  if (candidate.priorForecast) {
    const priorPred = materializeForecast(candidate.priorForecast);
    prior = { predictions: [buildPriorForecastSnapshot(priorPred)] };
    computeTrends([pred], prior);
    buildForecastCase(pred);
    annotateForecastChanges([pred], prior);
  }

  const readiness = scoreForecastReadiness(pred);
  const priority = computeAnalysisPriority(pred);
  const thresholds = {
    overallMin: +Math.max(0, readiness.overall - readinessSlack).toFixed(3),
    overallMax: +Math.min(1, readiness.overall + readinessSlack).toFixed(3),
    groundingMin: +Math.max(0, readiness.groundingScore - readinessSlack).toFixed(3),
    priorityMin: +Math.max(0, priority - prioritySlack).toFixed(3),
    priorityMax: +Math.min(1, priority + prioritySlack).toFixed(3),
    trend: pred.trend,
    changeSummaryIncludes: [buildSummaryExpectation(pred, candidate.priorForecast || null)],
  };

  const itemExpectations = buildItemExpectations(pred);
  if (itemExpectations.length > 0) thresholds.changeItemsInclude = itemExpectations;

  return thresholds;
}

function toHistoricalBenchmarkEntry(candidate, options = {}) {
  return {
    name: candidate.name,
    eventDate: candidate.eventDate,
    description: candidate.description,
    priorForecast: candidate.priorForecast,
    forecast: candidate.forecast,
    thresholds: deriveThresholds(candidate, options),
  };
}

function mergeHistoricalBenchmarks(existingEntries, nextEntry, options = {}) {
  const replace = options.replace ?? false;
  const index = existingEntries.findIndex(entry => entry.name === nextEntry.name);

  if (index >= 0 && !replace) {
    throw new Error(`Benchmark entry "${nextEntry.name}" already exists. Re-run with --replace to overwrite it.`);
  }

  const merged = [...existingEntries];
  if (index >= 0) {
    merged[index] = nextEntry;
  } else {
    merged.push(nextEntry);
  }

  merged.sort((a, b) => {
    const left = a.eventDate || '';
    const right = b.eventDate || '';
    return left.localeCompare(right) || a.name.localeCompare(b.name);
  });
  return merged;
}

function createJsonPatch(existingEntries, nextEntry, options = {}) {
  const index = existingEntries.findIndex(entry => entry.name === nextEntry.name);
  if (index >= 0) {
    if (!(options.replace ?? false)) {
      throw new Error(`Benchmark entry "${nextEntry.name}" already exists. Re-run with --replace to overwrite it.`);
    }
    return [{ op: 'replace', path: `/${index}`, value: nextEntry }];
  }
  return [{ op: 'add', path: `/${existingEntries.length}`, value: nextEntry }];
}

function renderUnifiedDiff(currentEntries, nextEntries, outputPath) {
  const tempDir = mkdtempSync(join(tmpdir(), 'forecast-benchmark-'));
  const currentPath = join(tempDir, `before-${basename(outputPath)}`);
  const nextPath = join(tempDir, `after-${basename(outputPath)}`);
  const currentText = `${JSON.stringify(currentEntries, null, 2)}\n`;
  const nextText = `${JSON.stringify(nextEntries, null, 2)}\n`;

  writeFileSync(currentPath, currentText, 'utf8');
  writeFileSync(nextPath, nextText, 'utf8');

  try {
    try {
      const rawDiff = execFileSync('git', ['diff', '--no-index', '--', currentPath, nextPath], { encoding: 'utf8' });
      return rawDiff
        .replaceAll(currentPath, `a/${outputPath}`)
        .replaceAll(nextPath, `b/${outputPath}`);
    } catch (error) {
      const output = `${error.stdout || ''}${error.stderr || ''}`.trim()
        .replaceAll(currentPath, `a/${outputPath}`)
        .replaceAll(nextPath, `b/${outputPath}`);
      if (output) return output;
      throw error;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {
    limit: 60,
    maxCandidates: 10,
    index: 0,
    output: DEFAULT_OUTPUT_PATH,
    write: false,
    replace: false,
    name: '',
    format: 'entry',
  };

  for (const arg of argv) {
    if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1] || 60);
    else if (arg.startsWith('--max-candidates=')) args.maxCandidates = Number(arg.split('=')[1] || 10);
    else if (arg.startsWith('--index=')) args.index = Number(arg.split('=')[1] || 0);
    else if (arg.startsWith('--output=')) args.output = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--name=')) args.name = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--format=')) args.format = arg.split('=').slice(1).join('=') || 'entry';
    else if (arg === '--write') args.write = true;
    else if (arg === '--replace') args.replace = true;
  }

  return args;
}

function pickCandidate(candidates, options = {}) {
  if (options.name) {
    const named = candidates.find(candidate => candidate.name === options.name);
    if (!named) throw new Error(`No extracted candidate named "${options.name}" was found.`);
    return named;
  }

  if (!Number.isInteger(options.index) || options.index < 0 || options.index >= candidates.length) {
    throw new Error(`Candidate index ${options.index} is out of range for ${candidates.length} candidate(s).`);
  }
  return candidates[options.index];
}

function readBenchmarkFile(pathname) {
  return JSON.parse(readFileSync(pathname, 'utf8'));
}

function buildPreviewPayload(args, candidate, nextEntry, currentEntries) {
  const merged = mergeHistoricalBenchmarks(currentEntries, nextEntry, { replace: args.replace });

  if (args.format === 'json-patch') {
    return {
      mode: 'preview',
      format: 'json-patch',
      output: args.output,
      candidateCount: null,
      selected: candidate.name,
      patch: createJsonPatch(currentEntries, nextEntry, { replace: args.replace }),
    };
  }

  if (args.format === 'diff') {
    return {
      mode: 'preview',
      format: 'diff',
      output: args.output,
      selected: candidate.name,
      diff: renderUnifiedDiff(currentEntries, merged, args.output),
    };
  }

  return {
    mode: 'preview',
    format: 'entry',
    output: args.output,
    selected: candidate.name,
    entry: nextEntry,
  };
}

if (_isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  const history = await readForecastHistory(HISTORY_KEY, args.limit);
  const candidates = selectBenchmarkCandidates(history, { maxCandidates: args.maxCandidates });

  if (candidates.length === 0) {
    console.error('No promotable forecast benchmark candidates are available yet.');
    process.exit(1);
  }

  const candidate = pickCandidate(candidates, args);
  const nextEntry = toHistoricalBenchmarkEntry(candidate);
  const current = readBenchmarkFile(args.output);

  if (!args.write) {
    const preview = buildPreviewPayload(args, candidate, nextEntry, current);
    preview.candidateCount = candidates.length;
    console.log(JSON.stringify(preview, null, 2));
  } else {
    const merged = mergeHistoricalBenchmarks(current, nextEntry, { replace: args.replace });
    writeFileSync(args.output, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      mode: args.replace ? 'replaced' : 'appended',
      output: args.output,
      selected: candidate.name,
      totalEntries: merged.length,
    }, null, 2));
  }
}

export {
  materializeForecast,
  buildSummaryExpectation,
  buildItemExpectations,
  deriveThresholds,
  toHistoricalBenchmarkEntry,
  mergeHistoricalBenchmarks,
  createJsonPatch,
  renderUnifiedDiff,
  buildPreviewPayload,
  pickCandidate,
  parseArgs,
  DEFAULT_OUTPUT_PATH,
};
