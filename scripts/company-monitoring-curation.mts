#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  CompanyMonitoringCurationError,
  auditCompanyMonitoringCurationSplit,
  compileCompanyMonitoringBlindCorpus,
  compileCompanyMonitoringGoldLabels,
  type CompanyMonitoringCurationManifest,
  type CompanyMonitoringGoldCurationManifest,
} from '../shared/company-monitoring-curation.ts';
import { canonicalJson } from '../shared/company-monitoring-evaluation.ts';

type Command = 'audit-manifest' | 'audit-split' | 'compile-corpus' | 'compile-gold';

class CompanyMonitoringCurationUsageError extends Error {}

function usage(): never {
  throw new CompanyMonitoringCurationUsageError([
    'usage:',
    '  company-monitoring:curation audit-manifest CURATION_FILE',
    '  company-monitoring:curation audit-split PILOT_FILE TRACER_FILE STAGE3_FILE',
    '  company-monitoring:curation compile-corpus CURATION_FILE',
    '  company-monitoring:curation compile-gold CURATION_FILE GOLD_CURATION_FILE',
  ].join('\n'));
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new CompanyMonitoringCurationError('curation_input_unreadable');
  }
}

function main(): void {
  const [commandValue, ...paths] = process.argv.slice(2);
  const command = commandValue as Command | undefined;
  if (!command) usage();

  if (command === 'audit-manifest') {
    if (paths.length !== 1) usage();
    const { manifestSha256, summary } = compileCompanyMonitoringBlindCorpus(
      readJson<CompanyMonitoringCurationManifest>(paths[0]!),
    );
    process.stdout.write(`${canonicalJson({ manifestSha256, summary })}\n`);
    return;
  }
  if (command === 'compile-corpus') {
    if (paths.length !== 1) usage();
    const { corpus } = compileCompanyMonitoringBlindCorpus(
      readJson<CompanyMonitoringCurationManifest>(paths[0]!),
    );
    process.stdout.write(`${canonicalJson(corpus)}\n`);
    return;
  }
  if (command === 'compile-gold') {
    if (paths.length !== 2) usage();
    const gold = compileCompanyMonitoringGoldLabels(
      readJson<CompanyMonitoringCurationManifest>(paths[0]!),
      readJson<CompanyMonitoringGoldCurationManifest>(paths[1]!),
    );
    process.stdout.write(`${canonicalJson(gold)}\n`);
    return;
  }
  if (command === 'audit-split') {
    if (paths.length !== 3) usage();
    const result = auditCompanyMonitoringCurationSplit({
      pilot: readJson<CompanyMonitoringCurationManifest>(paths[0]!),
      tracer: readJson<CompanyMonitoringCurationManifest>(paths[1]!),
      stage3: readJson<CompanyMonitoringCurationManifest>(paths[2]!),
    });
    process.stdout.write(`${canonicalJson(result)}\n`);
    return;
  }
  usage();
}

try {
  main();
} catch (error) {
  const message = error instanceof CompanyMonitoringCurationError
    ? error.code
    : error instanceof CompanyMonitoringCurationUsageError
      ? error.message
      : 'curation_unexpected_error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
