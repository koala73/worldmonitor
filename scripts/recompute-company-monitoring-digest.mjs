#!/usr/bin/env node
// Recompute the Company Monitoring approved-threshold digest.
//
// Changing a frozen threshold is permitted by viability.md's change-control section, but the new
// digest has to come from somewhere. Without this script the only way to obtain it is to edit the
// fixture, run the contract test, and scrape the value out of an AssertionError diff -- an
// accidental side-channel rather than a tool.
//
// Usage:
//   npm run company-monitoring:digest            print the digest for the committed fixture
//   npm run company-monitoring:digest -- --check verify the fixture and test literal agree (exit 1 if not)
//
// Deliberately does NOT write either location. The digest literal in the test source and the
// approval.approvedThresholdsSha256 field are the approval record; a script that rewrote them
// would turn a product-owner decision into a keystroke.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { thresholdDigest } from '../shared/company-monitoring-evaluation.ts';

const FIXTURE = new URL(
  '../tests/fixtures/company-monitoring-evaluation/protocol.json',
  import.meta.url,
);
const TEST_SOURCE = new URL('../tests/company-monitoring-evaluation.test.mts', import.meta.url);
const DIGEST_LITERAL = /const APPROVED_THRESHOLD_DIGEST = '([a-f0-9]{64})'/;

export function recomputeDigest() {
  const protocol = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const computed = thresholdDigest(protocol);
  const recorded = protocol?.approval?.approvedThresholdsSha256 ?? null;
  const source = readFileSync(TEST_SOURCE, 'utf8');
  const literal = (DIGEST_LITERAL.exec(source) ?? [])[1] ?? null;
  return { computed, recorded, literal };
}

function main() {
  const check = process.argv.includes('--check');
  const { computed, recorded, literal } = recomputeDigest();

  if (!check) {
    console.log(computed);
    console.log('');
    console.log('To adopt this digest, update BOTH approval sites:');
    console.log(`  1. tests/company-monitoring-evaluation.test.mts  APPROVED_THRESHOLD_DIGEST`);
    console.log(`  2. tests/fixtures/company-monitoring-evaluation/protocol.json  approval.approvedThresholdsSha256`);
    console.log('');
    console.log('Per viability.md change control, a threshold change also needs a new protocol');
    console.log('version and product-owner approval, and cannot rescue an in-flight score.');
    return 0;
  }

  const problems = [];
  if (recorded !== computed) {
    problems.push(`fixture approval.approvedThresholdsSha256 is ${recorded}, computed ${computed}`);
  }
  if (literal !== computed) {
    problems.push(`test APPROVED_THRESHOLD_DIGEST is ${literal}, computed ${computed}`);
  }
  if (problems.length > 0) {
    console.error('[company-monitoring:digest] MISMATCH');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`[company-monitoring:digest] OK. Fixture, test literal, and recomputation all agree.`);
  return 0;
}

// Realpath both sides: a symlinked invocation path (macOS /tmp -> /private/tmp) otherwise makes
// this guard silently no-op, which for a check script is a fail-open.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href
      === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(main());
}
