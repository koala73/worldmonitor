#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  validateBlindCorpusArtifact,
  validateBlindForecastArtifact,
  validateExpansionManifestArtifact,
  validateGoldLabelSetArtifact,
  validatePredictionSetArtifact,
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
    '  company-monitoring:blind-evaluation forecast --protocol FILE --approved-threshold-digest SHA256 --pilot-corpus FILE --expected-pilot-corpus-digest SHA256 --pilot-gold FILE --pilot-predictions FILE --target-corpus FILE --target-gold FILE [--target-expansion FILE]',
    '  company-monitoring:blind-evaluation score --protocol FILE --approved-threshold-digest SHA256 --corpus FILE --expected-corpus-digest SHA256 --gold FILE --predictions FILE --forecast FILE [--previous-corpus FILE --expected-previous-corpus-digest SHA256 --previous-gold FILE --previous-predictions FILE --previous-report FILE]',
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

type ArtifactValidator<T> = (value: unknown) => asserts value is T;

function digestArtifact<T>(
  path: string,
  command: string,
  validate: ArtifactValidator<T>,
  digest: (value: T) => string,
): string {
  const value = readJson<unknown>(path);
  try {
    validate(value);
  } catch {
    throw new Error(`${command} input schema invalid`);
  }
  return digest(value);
}

function digestCommand(command: Command, values: string[]): string {
  if (values.length !== 1) usage();
  const path = values[0]!;
  if (command === 'digest-corpus') {
    return digestArtifact<BlindCorpus>(
      path, command, validateBlindCorpusArtifact, computeBlindCorpusDigest,
    );
  }
  if (command === 'digest-gold') {
    return digestArtifact<GoldLabelSet>(
      path, command, validateGoldLabelSetArtifact, computeGoldLabelSetDigest,
    );
  }
  if (command === 'digest-predictions') {
    return digestArtifact<PredictionSet>(
      path, command, validatePredictionSetArtifact, computePredictionSetDigest,
    );
  }
  if (command === 'digest-forecast') {
    return digestArtifact<BlindForecast>(
      path, command, validateBlindForecastArtifact, computeForecastDigest,
    );
  }
  if (command === 'digest-expansion') {
    return digestArtifact<BlindExample[]>(
      path, command, validateExpansionManifestArtifact, computeExpansionManifestDigest,
    );
  }
  usage();
}

function forecast(values: string[]): string {
  const options = parseOptions(values);
  exactOptions(options, [
    'protocol',
    'approved-threshold-digest',
    'pilot-corpus',
    'expected-pilot-corpus-digest',
    'pilot-gold',
    'pilot-predictions',
    'target-corpus',
    'target-gold',
    'target-expansion',
  ]);
  return canonicalJson(forecastBlindEvaluation({
    protocol: readJson<JsonObject>(required(options, 'protocol')),
    anchors: { approvedThresholdDigest: required(options, 'approved-threshold-digest') },
    expectedPilotCorpusSha256: required(options, 'expected-pilot-corpus-digest'),
    pilotCorpus: readJson<BlindCorpus>(required(options, 'pilot-corpus')),
    pilotGoldLabels: readJson<GoldLabelSet>(required(options, 'pilot-gold')),
    pilotPredictions: readJson<PredictionSet>(required(options, 'pilot-predictions')),
    targetCorpus: readJson<BlindCorpus>(required(options, 'target-corpus')),
    targetGoldLabels: readJson<GoldLabelSet>(required(options, 'target-gold')),
    targetExpansion: options.has('target-expansion')
      ? readJson<BlindExample[]>(required(options, 'target-expansion'))
      : undefined,
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
    'expected-previous-corpus-digest',
    'previous-gold',
    'previous-predictions',
    'previous-report',
  ]);
  const previousNames = [
    'previous-corpus',
    'expected-previous-corpus-digest',
    'previous-gold',
    'previous-predictions',
    'previous-report',
  ];
  const previousCount = previousNames.filter((name) => options.has(name)).length;
  if (previousCount !== 0 && previousCount !== previousNames.length) {
    throw new Error('continuation requires all five previous inputs including the retained digest');
  }
  const previous = previousCount === 0 ? undefined : {
    corpus: readJson<BlindCorpus>(required(options, 'previous-corpus')),
    expectedCorpusSha256: required(options, 'expected-previous-corpus-digest'),
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

export type BlindEvaluationCliResult = {
  stdout: string;
  stderr: string;
  exitCode: 0 | typeof EXIT_ENGINE_ERROR | typeof EXIT_GATE_NOT_PASSED;
};

export function runBlindEvaluationCli(args: string[]): BlindEvaluationCliResult {
  try {
    const [commandValue, ...values] = args;
    const command = commandValue as Command | undefined;
    if (!command) usage();
    if (command === 'forecast') {
      return { stdout: `${forecast(values)}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'score') {
      const { json, outcome } = score(values);
      return {
        stdout: `${json}\n`,
        stderr: '',
        exitCode: outcome === 'pass' ? 0 : EXIT_GATE_NOT_PASSED,
      };
    }
    return { stdout: `${digestCommand(command, values)}\n`, stderr: '', exitCode: 0 };
  } catch (error) {
    const message = error instanceof BlindEvaluationError
      ? error.code
      : error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `${message}\n`, exitCode: EXIT_ENGINE_ERROR };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = runBlindEvaluationCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
