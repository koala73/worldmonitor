import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOCATION_TEST_FILES = Object.freeze([
  'src/data/focusAllocations.test.mjs',
  'src/overlays/worldOverlayAllocation.test.mjs',
]);

/** Whether this runtime matches the one the allocation budgets were calibrated on. */
export function isCalibratedAllocationRuntime(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10) === 24;
}

/** Require the runtime on which allocation budgets were calibrated. */
export function assertNode24AllocationRuntime(version = process.versions.node) {
  if (!isCalibratedAllocationRuntime(version)) {
    throw new Error(`Allocation budgets require the calibrated Node 24 runtime; received ${version}`);
  }
  return version;
}

/** Discover repository unit tests in stable path order. */
export function discoverUnitTestFiles(root = process.cwd()) {
  const sourceRoot = path.join(root, 'src');
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(sourceRoot);
  return files.sort();
}

/** Partition ordinary parallel tests from the two GC-bracketed probes. */
export function buildUnitTestPlan(files) {
  const known = new Set(files);
  const missingAllocationTests = ALLOCATION_TEST_FILES.filter((file) => !known.has(file));
  if (missingAllocationTests.length) {
    throw new Error(`Missing allocation microbenchmarks: ${missingAllocationTests.join(', ')}`);
  }
  const allocationSet = new Set(ALLOCATION_TEST_FILES);
  return {
    parallel: files.filter((file) => !allocationSet.has(file)).sort(),
    serializedAllocations: [...ALLOCATION_TEST_FILES],
  };
}

/** Build the isolated Node invocation for one GC-bracketed allocation probe. */
export function allocationTestArgs(file) {
  if (!ALLOCATION_TEST_FILES.includes(file)) {
    throw new Error(`Not an allocation microbenchmark: ${file}`);
  }
  return ['--expose-gc', '--test', '--test-concurrency=1', file];
}

function runTests(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runUnitTests() {
  const plan = buildUnitTestPlan(discoverUnitTestFiles());
  const parallelStatus = runTests(['--test', ...plan.parallel]);
  if (parallelStatus !== 0) return parallelStatus;

  // The GC-bracketed budgets are calibrated on Node 24 and are meaningless on
  // other allocators. A contributor's suite must stay green on any supported
  // engine (package.json permits >=24), so uncalibrated runtimes skip the
  // probes with a warning. Set GEV_REQUIRE_ALLOCATION_GATE=1 (pinned CI /
  // release batteries) to make an uncalibrated runtime a hard failure.
  if (!isCalibratedAllocationRuntime()) {
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1') {
      assertNode24AllocationRuntime();
    }
    console.warn(
      `[unit] SKIPPED ${ALLOCATION_TEST_FILES.length} allocation microbenchmarks: `
      + `budgets are calibrated for Node 24, running ${process.versions.node}. `
      + 'Run under Node 24 (or set GEV_REQUIRE_ALLOCATION_GATE=1 to fail instead).',
    );
    return 0;
  }
  for (const file of plan.serializedAllocations) {
    const status = runTests(allocationTestArgs(file));
    if (status !== 0) return status;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exitCode = runUnitTests();
