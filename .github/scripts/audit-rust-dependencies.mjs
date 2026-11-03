#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

function validateRustDecisions(decisions) {
  if (!Array.isArray(decisions)) throw new Error('Rust decisions must be an array');
  const seen = new Set();
  for (const d of decisions) {
    if (
      !/^RUSTSEC-\d{4}-\d{4}$/.test(d.id) ||
      seen.has(d.id) ||
      typeof d.reason !== 'string' ||
      d.reason.trim().length < 20 ||
      typeof d.owner !== 'string' ||
      !d.owner.trim() ||
      !Number.isFinite(Date.parse(d.expiresAt)) ||
      !['proposed', 'approved'].includes(d.status) ||
      (d.status === 'approved' &&
        (typeof d.approvedBy !== 'string' || !d.approvedBy.trim() || !Number.isFinite(Date.parse(d.approvedAt))))
    )
      throw new Error('Invalid Rust advisory decision');
    seen.add(d.id);
  }
}

export function classifyRustAudit(report, decisions, now = Date.now()) {
  if (
    !(report?.database?.['advisory-count'] > 0) ||
    !(report?.lockfile?.['dependency-count'] > 0) ||
    !Array.isArray(report?.vulnerabilities?.list) ||
    report.vulnerabilities.count !== report.vulnerabilities.list.length ||
    report.settings?.ignore?.length !== 0 ||
    report.settings?.target_arch?.length !== 0 ||
    report.settings?.target_os?.length !== 0 ||
    report.settings?.severity !== null ||
    report.vulnerabilities.found !== report.vulnerabilities.count > 0
  )
    throw new Error('Invalid or filtered cargo-audit report');
  validateRustDecisions(decisions);
  const result = {
    status: 'clean',
    blocking: [],
    noFix: [],
    approved: [],
    proposed: [],
    warnings: [],
    decisionErrors: [],
  };
  if (!report.warnings || typeof report.warnings !== 'object' || Array.isArray(report.warnings))
    throw new Error('Invalid Rust warnings');
  const findings = [...report.vulnerabilities.list];
  for (const [kind, items] of Object.entries(report.warnings)) {
    if (!Array.isArray(items)) throw new Error('Invalid Rust warning list');
    for (const item of items) {
      // RustSec encodes memory-unsoundness advisories as warnings, even when a patch exists.
      if (kind === 'unsound' || item.versions?.patched?.length) findings.push(item);
      else
        result.warnings.push({
          kind,
          id: item.advisory?.id,
          crate: item.package?.name,
          version: item.package?.version,
        });
    }
  }
  for (const item of findings) {
    if (
      !/^RUSTSEC-\d{4}-\d{4}$/.test(item.advisory?.id) ||
      !item.package?.name ||
      !item.package?.version ||
      !Array.isArray(item.versions?.patched) ||
      !item.versions.patched.every((v) => typeof v === 'string' && v.trim())
    ) {
      throw new Error('Malformed Rust advisory');
    }
    const entry = {
      id: item.advisory.id,
      crate: item.package.name,
      version: item.package.version,
      patched: item.versions.patched,
    };
    const decision = decisions.find((d) => d.id === entry.id);
    if (decision?.status === 'proposed') result.proposed.push({ ...entry, decision });
    if (decision?.status === 'approved' && Date.parse(decision.expiresAt) > now)
      result.approved.push({ ...entry, decision });
    else if (entry.patched.length) result.blocking.push(entry);
    else result.noFix.push(entry);
  }
  for (const d of decisions) {
    if (Date.parse(d.expiresAt) <= now)
      result.decisionErrors.push(`${d.id}: decision expired; ${d.owner} must re-review`);
    if (!findings.some((f) => f.advisory.id === d.id)) result.decisionErrors.push(`${d.id}: stale decision; remove it`);
  }
  if (result.blocking.length || result.decisionErrors.length) result.status = 'failed';
  else if (result.noFix.length || result.approved.length || result.warnings.length) result.status = 'warning';
  return result;
}

export function runRustAudit({ lockfile, decisions, failOnOutage = false, run = spawnSync, now = Date.now() }) {
  // A fresh database and neutral cwd prevent local cargo ignore/config state or a stale cache from producing a clean result.
  validateRustDecisions(decisions);
  const expired = decisions.filter((d) => Date.parse(d.expiresAt) <= now);
  if (expired.length) throw new Error(`Rust advisory decisions expired: ${expired.map((d) => d.id).join(', ')}`);
  const dir = mkdtempSync(join(tmpdir(), 'worldmonitor-rust-audit-'));
  try {
    readFileSync(lockfile); // Missing input is actor-fixable, never an upstream outage.
    const db = join(dir, 'db');
    const fetched = run('git', ['clone', '--depth=1', 'https://github.com/RustSec/advisory-db.git', db], {
      encoding: 'utf8',
      timeout: 120000,
      cwd: dir,
    });
    if (fetched.error?.code === 'ENOENT') throw fetched.error;
    if (fetched.status !== 0)
      return {
        status: 'unavailable',
        failed: failOnOutage,
        reason: `RustSec database could not be fetched: ${fetched.stderr || fetched.error?.message || fetched.status}`,
      };
    const audited = run(
      'cargo',
      ['audit', '--json', '--no-fetch', '--no-yanked', '--db', db, '--file', resolve(lockfile)],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, cwd: dir },
    );
    if (audited.error) throw audited.error;
    if (![0, 1].includes(audited.status)) throw new Error(`cargo audit failed: ${audited.stderr || audited.status}`);
    const report = JSON.parse(audited.stdout);
    if (audited.status === 1 && report.vulnerabilities?.count === 0)
      throw new Error('cargo audit failed without advisory findings');
    const result = classifyRustAudit(report, decisions, now);
    return { ...result, failed: result.status === 'failed' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  let result;
  try {
    result = runRustAudit({
      lockfile: resolve('src-tauri/Cargo.lock'),
      decisions: JSON.parse(readFileSync('.github/rust-advisory-decisions.json', 'utf8')),
      failOnOutage: process.env.AUDIT_FAIL_ON_OUTAGE === '1',
    });
  } catch (error) {
    result = { status: 'failed', failed: true, reason: error.message };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'clean')
    console.log(
      `::${result.failed ? 'error' : 'warning'}::Rust advisory audit: ${result.status}. See the report; this is not a clean result.`,
    );
  if (process.env.AUDIT_STATUS_FILE) writeFileSync(process.env.AUDIT_STATUS_FILE, `${result.status}\n`);
  process.exitCode = result.failed ? 1 : 0;
}
