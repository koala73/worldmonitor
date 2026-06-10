#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERITY_RANK = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

export const BASELINE_ADVISORIES_BY_LOCKFILE = {
  'package-lock.json': ['GHSA-w7jw-789q-3m8p'],
  'consumer-prices-core/package-lock.json': ['GHSA-jx2c-rxcm-jvmq', 'GHSA-q3j6-qgpj-74h6', 'GHSA-v39h-62p7-jpjc'],
  'blog-site/package-lock.json': [],
  'pro-test/package-lock.json': ['GHSA-qjx8-664m-686j', 'GHSA-w24r-5266-9c3c', 'GHSA-w7jw-789q-3m8p'],
  'scripts/package-lock.json': [],
};

function severityRank(severity) {
  return SEVERITY_RANK.get(String(severity ?? '').toLowerCase()) ?? -1;
}

function advisoryId(advisory) {
  const urlId = String(advisory.url ?? '').match(/GHSA-[a-z0-9-]+/i)?.[0];
  if (urlId) return urlId;
  if (advisory.source) return String(advisory.source);
  return `${advisory.name ?? 'unknown'}:${advisory.title ?? 'untitled'}`;
}

export function collectAuditFindings(report, auditLevel = 'high') {
  const findings = new Map();

  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      if (!via || typeof via !== 'object') continue;

      const severity = via.severity ?? vulnerability.severity;
      if (severityRank(severity) < severityRank(auditLevel)) continue;

      const id = advisoryId(via);
      const name = via.name ?? vulnerability.name ?? 'unknown';
      const key = `${id}:${name}`;
      findings.set(key, {
        id,
        name,
        severity,
        title: via.title ?? 'Untitled advisory',
        url: via.url ?? '',
      });
    }
  }

  return [...findings.values()].sort((a, b) => `${a.id}:${a.name}`.localeCompare(`${b.id}:${b.name}`));
}

export function collectUnbaselinedFindings(report, lockfile, auditLevel = 'high') {
  const baseline = new Set(BASELINE_ADVISORIES_BY_LOCKFILE[lockfile] ?? []);
  return collectAuditFindings(report, auditLevel).filter((finding) => !baseline.has(finding.id));
}

function parseArgs(argv) {
  const args = {
    auditLevel: 'high',
    workspace: '.',
    lockfile: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--audit-level') args.auditLevel = argv[++i] ?? args.auditLevel;
    else if (arg === '--workspace') args.workspace = argv[++i] ?? args.workspace;
    else if (arg === '--lockfile') args.lockfile = argv[++i] ?? args.lockfile;
  }

  if (!args.lockfile) {
    throw new Error('Usage: audit-production-dependencies.mjs --workspace <path> --lockfile <package-lock.json>');
  }

  return args;
}

function readAuditReport(workspace) {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  const json = result.stdout.trim();

  if (!json) {
    process.stderr.write(result.stderr);
    throw new Error(`npm audit did not return JSON for ${workspace}`);
  }

  let report;
  try {
    report = JSON.parse(json);
  } catch (error) {
    process.stderr.write(result.stderr);
    throw new Error(`Could not parse npm audit JSON for ${workspace}: ${error.message}`);
  }

  if (report.error) {
    throw new Error(report.error.summary ?? report.error.detail ?? `npm audit failed for ${workspace}`);
  }

  return report;
}

function printFinding(prefix, finding) {
  const suffix = finding.url ? ` (${finding.url})` : '';
  console.log(`${prefix} ${finding.severity} ${finding.id} ${finding.name}: ${finding.title}${suffix}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolve(process.cwd(), args.workspace);
  const report = readAuditReport(workspace);
  const allFindings = collectAuditFindings(report, args.auditLevel);
  const unbaselined = collectUnbaselinedFindings(report, args.lockfile, args.auditLevel);
  const unbaselinedKeys = new Set(unbaselined.map((finding) => `${finding.id}:${finding.name}`));

  for (const finding of allFindings.filter((item) => !unbaselinedKeys.has(`${item.id}:${item.name}`))) {
    printFinding('::warning title=Baselined production advisory::', finding);
  }

  if (unbaselined.length > 0) {
    console.error(`Found ${unbaselined.length} unbaselined ${args.auditLevel}+ production advisories in ${args.lockfile}:`);
    for (const finding of unbaselined) {
      printFinding('::error title=Unbaselined production advisory::', finding);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Production audit OK for ${args.lockfile}: ${allFindings.length} ${args.auditLevel}+ advisories are baselined or absent.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
