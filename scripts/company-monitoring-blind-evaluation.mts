#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  BlindEvaluationError,
  canonicalReportJson,
  computeBlindCorpusDigest,
  computeExpansionManifestDigest,
  computeForecastDigest,
  computeGoldLabelSetDigest,
  computePredictionSetDigest,
  forecastBlindEvaluation,
  scoreBlindEvaluation,
  type BlindCorpus,
  type BlindExample,
  type BlindForecast,
  type GoldLabelSet,
  type PredictionSet,
  type ScoreReport,
} from '../shared/company-monitoring-blind-evaluation.ts';
import { canonicalJson, type JsonObject } from '../shared/company-monitoring-evaluation.ts';

type Command = 'forecast' | 'score' | 'digest-corpus' | 'digest-gold'
  | 'digest-predictions' | 'digest-forecast' | 'digest-expansion';

function usage(): never {
  throw new Error([
    'usage:',
    '  company-monitoring:blind-evaluation forecast --protocol FILE --approved-threshold-digest SHA256 --pilot-corpus FILE --pilot-gold FILE --pilot-predictions FILE --target-corpus FILE --target-gold FILE',
    '  company-monitoring:blind-evaluation score --protocol FILE --approved-threshold-digest SHA256 --corpus FILE --expected-corpus-digest SHA256 --gold FILE --predictions FILE --forecast FILE [--previous-corpus FILE --previous-gold FILE --previous-predictions FILE --previous-report FILE]',
    '  company-monitoring:blind-evaluation digest-corpus|digest-gold|digest-predictions|digest-forecast|digest-expansion FILE',
  ].join('\n'));
}

function parseOptions(values: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) usage();
    const key = flag.slice(2);
    if (options.has(key)) throw new Error(`duplicate option: --${key}`);
    options.set(key, value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`missing required option: --${name}`);
  return value;
}

function exactOptions(options: Map<string, string>, allowed: string[]): void {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) throw new Error(`unknown option: --${key}`);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function digestCommand(command: Command, values: string[]): string {
  if (values.length !== 1) usage();
  const path = values[0]!;
  if (command === 'digest-corpus') {
    const value = readJson<BlindCorpus>(path);
    if (value.schemaVersion !== 'cm_blind_corpus_v1') throw new Error('digest-corpus input schema invalid');
    return computeBlindCorpusDigest(value);
  }
  if (command === 'digest-gold') {
    const value = readJson<GoldLabelSet>(path);
    if (value.schemaVersion !== 'cm_gold_labels_v1') throw new Error('digest-gold input schema invalid');
    return computeGoldLabelSetDigest(value);
  }
  if (command === 'digest-predictions') {
    const value = readJson<PredictionSet>(path);
    if (value.schemaVersion !== 'cm_predictions_v1') {
      throw new Error('digest-predictions input schema invalid');
    }
    return computePredictionSetDigest(value);
  }
  if (command === 'digest-forecast') {
    const value = readJson<BlindForecast>(path);
    if (value.schemaVersion !== 'cm_blind_forecast_v1') {
      throw new Error('digest-forecast input schema invalid');
    }
    return computeForecastDigest(value);
  }
  if (command === 'digest-expansion') {
    const value = readJson<BlindExample[]>(path);
    if (!Array.isArray(value)) throw new Error('digest-expansion input schema invalid');
    return computeExpansionManifestDigest(value);
  }
  usage();
}

function forecast(values: string[]): string {
  const options = parseOptions(values);
  exactOptions(options, [
    'protocol',
    'approved-threshold-digest',
    'pilot-corpus',
    'pilot-gold',
    'pilot-predictions',
    'target-corpus',
    'target-gold',
  ]);
  return canonicalJson(forecastBlindEvaluation({
    protocol: readJson<JsonObject>(required(options, 'protocol')),
    anchors: { approvedThresholdDigest: required(options, 'approved-threshold-digest') },
    pilotCorpus: readJson<BlindCorpus>(required(options, 'pilot-corpus')),
    pilotGoldLabels: readJson<GoldLabelSet>(required(options, 'pilot-gold')),
    pilotPredictions: readJson<PredictionSet>(required(options, 'pilot-predictions')),
    targetCorpus: readJson<BlindCorpus>(required(options, 'target-corpus')),
    targetGoldLabels: readJson<GoldLabelSet>(required(options, 'target-gold')),
  }));
}

function score(values: string[]): { json: string; outcome: ScoreReport['outcome'] } {
  const options = parseOptions(values);
  exactOptions(options, [
    'protocol',
    'approved-threshold-digest',
    'corpus',
    'expected-corpus-digest',
    'gold',
    'predictions',
    'forecast',
    'previous-corpus',
    'previous-gold',
    'previous-predictions',
    'previous-report',
  ]);
  const previousNames = [
    'previous-corpus',
    'previous-gold',
    'previous-predictions',
    'previous-report',
  ];
  const previousCount = previousNames.filter((name) => options.has(name)).length;
  if (previousCount !== 0 && previousCount !== previousNames.length) {
    throw new Error('continuation requires all four --previous-* inputs');
  }
  const previous = previousCount === 0 ? undefined : {
    corpus: readJson<BlindCorpus>(required(options, 'previous-corpus')),
    goldLabels: readJson<GoldLabelSet>(required(options, 'previous-gold')),
    predictions: readJson<PredictionSet>(required(options, 'previous-predictions')),
    report: readJson<ScoreReport>(required(options, 'previous-report')),
  };
  const report = scoreBlindEvaluation({
    protocol: readJson<JsonObject>(required(options, 'protocol')),
    anchors: { approvedThresholdDigest: required(options, 'approved-threshold-digest') },
    corpus: readJson<BlindCorpus>(required(options, 'corpus')),
    expectedCorpusSha256: required(options, 'expected-corpus-digest'),
    goldLabels: readJson<GoldLabelSet>(required(options, 'gold')),
    predictions: readJson<PredictionSet>(required(options, 'predictions')),
    forecast: readJson<BlindForecast>(required(options, 'forecast')),
    previous,
  });
  return { json: canonicalReportJson(report), outcome: report.outcome };
}

// Exit codes are a contract for anything that ever wraps this CLI:
//   0 = the gate passed
//   1 = the engine refused to score (bad input, tampered evidence, usage error)
//   2 = the engine scored and the gate did NOT pass (fail or incomplete)
// Collapsing 2 into 0 would let a wrapper read a rejected gate as success.
const EXIT_ENGINE_ERROR = 1;
const EXIT_GATE_NOT_PASSED = 2;

function main(): void {
  const [commandValue, ...values] = process.argv.slice(2);
  const command = commandValue as Command | undefined;
  if (!command) usage();
  if (command === 'forecast') process.stdout.write(`${forecast(values)}\n`);
  else if (command === 'score') {
    const { json, outcome } = score(values);
    process.stdout.write(`${json}\n`);
    if (outcome !== 'pass') process.exitCode = EXIT_GATE_NOT_PASSED;
  } else process.stdout.write(`${digestCommand(command, values)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof BlindEvaluationError
    ? error.code
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = EXIT_ENGINE_ERROR;
}
