#!/usr/bin/env node
/**
 * Human-readable geographic coverage report (#5957).
 *
 *   node scripts/geo-coverage-report.mjs          # table, exit 1 on violations
 *   node scripts/geo-coverage-report.mjs --json   # machine-readable rows
 *
 * Audits strategic keyCountries (shared/geography.js) against the feed catalog
 * via shared/source-geography.json and the policy in
 * shared/geo-coverage-policy.json. CI gate: tests/geo-coverage-health.test.mts.
 */
import {
  computeGeoCoverage,
  evaluateGeoCoverage,
  formatGeoCoverageHuman,
  loadGeoCoverageInputs,
  validateGeoCoveragePolicy,
  validateSourceGeography,
} from './geo-coverage-health.mjs';

const asJson = process.argv.includes('--json');

const inputs = await loadGeoCoverageInputs();
try {
  const mapProblems = validateSourceGeography(inputs);
  const policyProblems = validateGeoCoveragePolicy(inputs);
  const rows = computeGeoCoverage(inputs);
  const { violations } = evaluateGeoCoverage(rows);
  const allViolations = [...mapProblems, ...policyProblems, ...violations];

  if (asJson) {
    process.stdout.write(JSON.stringify({
      catalogSize: inputs.catalogSize,
      defaultEnabledSize: inputs.defaultEnabledSize,
      violations: allViolations,
      rows,
    }, null, 2) + '\n');
  } else {
    for (const problem of mapProblems) process.stdout.write(`MAP PROBLEM: ${problem}\n`);
    for (const problem of policyProblems) {
      process.stdout.write(`POLICY PROBLEM: ${problem}\n`);
    }
    process.stdout.write(formatGeoCoverageHuman({
      rows,
      regions: inputs.regions,
      violations: allViolations,
      catalogSize: inputs.catalogSize,
      defaultEnabledSize: inputs.defaultEnabledSize,
      policy: inputs.policy,
    }) + '\n');
  }
  process.exitCode = allViolations.length > 0 ? 1 : 0;
} finally {
  inputs.cleanup();
}
