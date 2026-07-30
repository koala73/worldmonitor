// Smoke-tests for the fail-closed behaviour of
// `scripts/audit-resilience-cohorts.mjs`. Verifies:
//   (1) Missing cohort members produce a ⛔ banner at report top
//       and a dedicated "Fetch failures / missing members" section.
//   (2) STRICT=1 exits non-zero (code 3) when members are missing.
//   (3) Formula-mode detection correctly banners when pillar-combine
//       is active (Σ contributions ≠ overallScore for complete responses)
//       and correctly does NOT banner when contributions sum.
//
// The tests drive the script as a child process against synthetic
// fixtures so they exercise the full `main()` flow (report shape,
// exit codes, stderr logging) rather than just the pure helpers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-resilience-cohorts.mjs');

function writeFixture(name: string, fixture: unknown): string {
  const tmpFile = path.join(os.tmpdir(), `audit-fixture-${name}-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(fixture));
  return tmpFile;
}

function runAudit(env: Record<string, string>): { status: number | null; stdout: string; stderr: string; report: string } {
  const outFile = path.join(os.tmpdir(), `audit-out-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  const result = spawnSync('node', [SCRIPT], {
    env: { ...process.env, OUT: outFile, ...env },
    encoding: 'utf8',
  });
  let report = '';
  try { report = fs.readFileSync(outFile, 'utf8'); } catch { /* no report written */ }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    report,
  };
}

// Complete fixture: 57 cohort members so missing-member banner does NOT fire.
// Domain weights sum to 1.0 and coverage is 1.0 throughout.
// Σ contributions per country should land within CONTRIB_TOLERANCE of overall.
function buildCompleteFixture(options: { pillarMode?: boolean } = {}): unknown {
  const allCohortCodes = Array.from(new Set([
    'AE', 'SA', 'KW', 'QA', 'OM', 'BH',
    'FR', 'US', 'GB', 'JP', 'KR', 'DE', 'CA', 'FI', 'SE', 'BE',
    'SG', 'MY', 'TH', 'VN', 'ID', 'PH',
    'BR', 'MX', 'CO', 'VE', 'AR', 'EC',
    'NG', 'ZA', 'ET', 'KE', 'GH', 'CD', 'SD',
    'RU', 'KZ', 'AZ', 'UA', 'UZ', 'GE', 'AM',
    'LK', 'PK', 'LB', 'TR', 'EG', 'TN',
    'HK', 'NL', 'PA', 'LT',
    'NO',
    'YE', 'SY', 'SO', 'AF',
  ]));

  const buildDoc = (overallScore: number) => {
    const dimScore = overallScore;
    return {
      countryCode: 'XX',
      overallScore: options.pillarMode ? 10 : overallScore,
      // When pillarMode=true we deliberately set overallScore to a value
      // that won't match Σ contributions (penalizedPillarScore semantics)
      // so the detector fires. coverage=1.0 across all dims keeps the
      // eligibility gate satisfied.
      level: 'moderate',
      baselineScore: overallScore,
      stressScore: overallScore,
      stressFactor: 0.2,
      domains: [
        { id: 'economic', weight: 0.17, score: dimScore, dimensions: [
          { id: 'macroFiscal', score: dimScore, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
        ]},
        { id: 'infrastructure', weight: 0.15, score: dimScore, dimensions: [
          { id: 'infrastructure', score: dimScore, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
        ]},
        { id: 'energy', weight: 0.11, score: dimScore, dimensions: [
          { id: 'energy', score: dimScore, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
        ]},
        { id: 'social-governance', weight: 0.19, score: dimScore, dimensions: [
          { id: 'governanceInstitutional', score: dimScore, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
        ]},
        { id: 'health-food', weight: 0.13, score: dimScore, dimensions: [
          { id: 'healthPublicService', score: dimScore, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
        ]},
        { id: 'recovery', weight: 0.25, score: dimScore, dimensions: [
          { id: 'externalDebtCoverage', score: dimScore, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
        ]},
      ],
    };
  };

  const scores: Record<string, unknown> = {};
  for (const cc of allCohortCodes) {
    scores[cc] = { ...(buildDoc(70) as Record<string, unknown>), countryCode: cc };
  }
  const items = allCohortCodes.slice(0, 6).map((cc) => ({
    countryCode: cc, overallScore: 70, level: 'moderate', lowConfidence: false, overallCoverage: 1.0, rankStable: true,
  }));
  return { ranking: { items, greyedOut: [] }, scores };
}

describe('audit-resilience-cohorts fail-closed — missing cohort members', () => {
  it('banners the report when fixture omits cohort members AND exits 3 under STRICT=1', () => {
    // Minimal fixture intentionally omits almost every cohort member.
    const fixture = {
      ranking: { items: [
        { countryCode: 'AE', overallScore: 72.72, level: 'high', lowConfidence: false, overallCoverage: 0.88, rankStable: true },
      ], greyedOut: [] },
      scores: {
        AE: { countryCode: 'AE', overallScore: 72.72, level: 'high', baselineScore: 72, stressScore: 70, stressFactor: 0.15, domains: [
          { id: 'recovery', weight: 0.25, score: 50, dimensions: [
            { id: 'externalDebtCoverage', score: 100, coverage: 1.0, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
          ]},
        ]},
      },
    };
    const fixturePath = writeFixture('missing-members', fixture);
    try {
      const result = runAudit({ FIXTURE: fixturePath, STRICT: '1' });
      assert.equal(result.status, 3, `expected STRICT exit code 3 for missing members; got ${result.status}; stderr=${result.stderr}`);
      assert.match(result.report, /⛔ \*\*Fetch failures \/ missing cohort members/, 'expected missing-members banner at report top');
      assert.match(result.report, /## Fetch failures \/ missing members/, 'expected dedicated Fetch-failures section');
      assert.match(result.report, /Cohort members with no score data:/, 'expected missing-members list');
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });

  it('exits 0 under STRICT=1 when all cohort members present + formula matches', () => {
    const fixture = buildCompleteFixture({ pillarMode: false });
    const fixturePath = writeFixture('complete', fixture);
    try {
      const result = runAudit({ FIXTURE: fixturePath, STRICT: '1' });
      assert.equal(result.status, 0, `expected STRICT exit 0; got ${result.status}; stderr=${result.stderr}`);
      assert.doesNotMatch(result.report, /⛔ \*\*Fetch failures/, 'missing-members banner should NOT fire');
      assert.doesNotMatch(result.report, /⛔ \*\*Formula mode not supported/, 'formula-mode banner should NOT fire on legacy-formula response');
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });
});

describe('audit-resilience-cohorts fail-closed — formula mode', () => {
  it('banners the report when Σ contributions diverges from overallScore AND exits 4 under STRICT=1', () => {
    const fixture = buildCompleteFixture({ pillarMode: true });
    const fixturePath = writeFixture('pillar-mode', fixture);
    try {
      const result = runAudit({ FIXTURE: fixturePath, STRICT: '1' });
      assert.equal(result.status, 4, `expected STRICT exit code 4 for formula mismatch; got ${result.status}; stderr=${result.stderr}`);
      assert.match(result.report, /⛔ \*\*Formula mode not supported/, 'expected formula-mode banner at report top');
      assert.match(result.report, /PILLAR-COMBINE \(decomposition invalid\)/, 'expected formula-mode line in header');
      assert.match(result.report, /## Formula-mode diagnostic/, 'expected dedicated formula-mode diagnostic section');
    } finally {
      fs.unlinkSync(fixturePath);
    }
  });
});
