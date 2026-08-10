import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = resolve(root, '.github/workflows');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const deployGateWorkflow = read(resolve(workflowsDir, 'deploy-gate.yml'));
const securityAuditWorkflow = read(resolve(workflowsDir, 'security-audit.yml'));
const securityAuditScript = read(resolve(root, '.github/scripts/audit-production-dependencies.mjs'));
const testWorkflow = read(resolve(workflowsDir, 'test.yml'));
const desktopBuildWorkflow = read(resolve(workflowsDir, 'build-desktop.yml'));
const desktopCanaryWorkflow = read(resolve(workflowsDir, 'test-linux-app.yml'));
const lintCodeWorkflow = read(resolve(workflowsDir, 'lint-code.yml'));
const protoCheckWorkflow = read(resolve(workflowsDir, 'proto-check.yml'));
const workflowText = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => read(resolve(workflowsDir, name)))
  .join('\n');

const REQUIRED_PR_SCRIPTS = [
  'test:data',
  'test:sidecar',
  'test:convex',
  'test:e2e:ci-smoke',
  'test:resilience-validation-smoke',
] as const;

// Every spec the combined ci-smoke invocation must keep exercising. The three
// specs used to be three separate workflow steps; now that one script carries
// them, dropping a spec from its command line is the new way a guard can stop
// being invoked while CI stays green — so the spec list is pinned here.
const REQUIRED_CI_SMOKE_SPECS = [
  'e2e/variant-live-smoke.spec.ts',
  'e2e/mcp-grant-consent.spec.ts',
  'e2e/dashboard-news-request-budget.spec.ts',
] as const;

const REQUIRED_TEST_JOBS = [
  'unit',
  'sidecar',
  'convex-tests',
  'variant-smoke-full',
  'resilience-validation-smoke',
  'desktop-config',
  'desktop-rust',
] as const;

const TIMEOUT_CAPPED_TEST_JOBS = [
  'consumer-prices',
  'sidecar',
  'convex-tests',
  'variant-smoke-full',
  'resilience-validation-smoke',
  'desktop-config',
  'desktop-rust',
] as const;

const REQUIRED_GATE_WORKFLOWS = ['Test', 'Typecheck', 'Lint Code', 'Security Audit'] as const;

const REQUIRED_NON_TEST_GATE_CHECKS = [
  'typecheck',
  'biome',
  'public-docs',
  'security-audit',
] as const;

// Jobs the deploy gate cannot require under their own name, and the check that
// blocks on their behalf instead. A matrix job publishes one check run per
// matrix entry (`audit-lockfile (root)`, `audit-lockfile (scripts)`, …) and
// never the bare job id, so listing the id in `required` would leave the gate
// waiting on a check run that is never published — pending forever, which
// deadlocks every PR. The `if: always()` aggregate job publishes the single
// blocking check for the whole matrix instead.
//
// An entry here is honoured only when both halves still hold: the job's `name:`
// is a template expression (so it structurally cannot be matched by id), and
// the covering check is itself a required gate check. That keeps this table
// from becoming a way to quietly drop a job out of the gate.
const GATE_CHECK_EXEMPTIONS: Record<string, { workflow: string; coveredBy: string }> = {
  'audit-lockfile': { workflow: 'Security Audit', coveredBy: 'security-audit' },
};

const REQUIRED_RESILIENCE_VALIDATION_INPUTS = [
  'Dockerfile.seed-bundle-resilience-validation',
  'docs/methodology/country-resilience-index/validation/',
  'scripts/benchmark-resilience-external.mjs',
  'scripts/backtest-resilience-outcomes.mjs',
  'scripts/validate-resilience-sensitivity.mjs',
  'scripts/seed-bundle-resilience-validation.mjs',
  'scripts/_bundle-runner.mjs',
] as const;

// Desktop drift gates (#5902): the literal awk patterns each change filter
// must keep, so a filter refactor cannot silently un-gate a desktop-breaking
// path class (the exact drift class #5902 exists to close).
const REQUIRED_DESKTOP_CONFIG_INPUTS = [
  'src-tauri/',
  'package.json',
  'scripts/repack-linux-appimage.sh',
  'scripts/sync-desktop-version.mjs',
  'scripts/check-desktop-build-env.mjs',
  'scripts/check-rust-security-floors.mjs',
] as const;

const REQUIRED_DESKTOP_RUST_INPUTS = [
  'src-tauri/sidecar/',
  'src-tauri/',
  '.github/workflows/test.yml',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workflowRegexNeedle(path: string): string {
  return path.replaceAll('/', '\\/').replaceAll('.', '\\.');
}

function shellAwkAssignmentBlock(variable: string): string {
  const start = `${variable}=$(echo "$FILES" | awk '`;
  const startIndex = testWorkflow.indexOf(start);
  assert.notEqual(startIndex, -1, `test.yml must define ${variable}`);
  const end = "\n          ')";
  const endIndex = testWorkflow.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `test.yml must terminate ${variable}`);
  return testWorkflow.slice(startIndex, endIndex + end.length);
}

function testJobBlock(job: string): string {
  const match = testWorkflow.match(new RegExp(`\\n  ${escapeRegExp(job)}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|\\n$)`));
  assert.ok(match, `test.yml must define ${job}`);
  return match[0];
}

function workflowJobBlock(workflow: string, job: string): string {
  const match = workflow.match(new RegExp(`\\n  ${escapeRegExp(job)}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|\\n$)`));
  assert.ok(match, `workflow must define ${job}`);
  return match[0];
}

function workflowStepBlock(workflow: string, stepName: string): string {
  const marker = `\n      - name: ${stepName}\n`;
  const startIndex = workflow.indexOf(marker);
  assert.notEqual(startIndex, -1, `workflow must define step ${stepName}`);
  const nextStepIndex = workflow.indexOf('\n      - ', startIndex + marker.length);
  return workflow.slice(startIndex, nextStepIndex === -1 ? workflow.length : nextStepIndex);
}

function workflowStepBlocksByUses(workflow: string, action: string): string[] {
  const marker = new RegExp(`\\n      - uses: ${escapeRegExp(action)}@[^\\n]+\\n`, 'g');
  const blocks: string[] = [];
  for (const match of workflow.matchAll(marker)) {
    const startIndex = match.index ?? -1;
    assert.notEqual(startIndex, -1, `workflow must define ${action}`);
    const nextStepIndex = workflow.indexOf('\n      - ', startIndex + match[0].length);
    blocks.push(workflow.slice(startIndex, nextStepIndex === -1 ? workflow.length : nextStepIndex));
  }
  assert.ok(blocks.length > 0, `workflow must define ${action}`);
  return blocks;
}

function workflowRunScript(stepBlock: string): string {
  const marker = '\n        run: |\n';
  const startIndex = stepBlock.indexOf(marker);
  assert.notEqual(startIndex, -1, 'workflow step must have a block run script');
  return stepBlock
    .slice(startIndex + marker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

function runReleasePreflight(stepBlock: string, eventName: string, draft: string, value: string): void {
  const script = workflowRunScript(stepBlock)
    .replaceAll('${{ github.event_name }}', eventName)
    .replaceAll('${{ github.event.inputs.draft }}', draft);
  const names = [
    'VITE_CLERK_PUBLISHABLE_KEY',
    'VITE_WS_RELAY_URL',
    'VITE_PMTILES_URL_PUBLIC',
    'CONVEX_URL',
  ];
  const env = Object.fromEntries(names.map((name) => [name, value]));
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { env, encoding: 'utf8' });
}

function evaluateDesktopConfigFilter(filter: string, files: string[]): string {
  const fileArgs = files.map((file) => JSON.stringify(file)).join(' ');
  const script = `FILES=$(printf '%s\\n' ${fileArgs}); ${filter}; printf '%s' "$DESKTOP_CONFIG"`;
  return execFileSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8' }).trim();
}

function workflowJobNames(workflow: string, label: string): string[] {
  const jobs: string[] = [];
  let inJobs = false;

  for (const line of workflow.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S[^:]*:\s*$/.test(line)) {
      break;
    }
    const match = inJobs ? line.match(/^ {2}([A-Za-z0-9_-]+):(?:\s|$)/) : null;
    if (match?.[1]) {
      jobs.push(match[1]);
    }
  }

  assert.ok(jobs.length > 0, `${label} must define at least one job under jobs:`);
  return jobs;
}

// Maps a workflow's display name (`name:` at column 0) to its source, so the
// gate checks below key off the same names deploy-gate.yml's `workflow_run`
// trigger uses rather than a hand-maintained name-to-filename table.
//
// Two workflows sharing a display name would make this map silently keep one
// and drop the other, so the checks below could pass while the dropped
// workflow's jobs gate nothing. `workflow_run` matches by name too, so the
// ambiguity is real for the gate, not just for this test — fail on it here.
function gatedWorkflowSources(): Map<string, string> {
  const byName = new Map<string, string>();
  const filesByName = new Map<string, string>();

  for (const file of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    const source = read(resolve(workflowsDir, file));
    const name = source.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (!name) continue;

    assert.ok(
      !filesByName.has(name),
      `workflows must have unique names; ${filesByName.get(name)} and ${file} are both named "${name}", so workflow_run and the deploy gate cannot tell them apart`,
    );
    filesByName.set(name, file);
    byName.set(name, source);
  }

  return byName;
}

// The check-run name GitHub publishes for a job: its `name:` override when it
// has one, otherwise the job id. A `name:` containing a `${{ … }}` expression
// (matrix fan-out) resolves per matrix entry, so no single literal name exists
// for the gate to match.
function effectiveCheckName(workflow: string, job: string): { name: string; templated: boolean } {
  const nameOverride = workflowJobBlock(workflow, job).match(/^ {4}name:\s*(.+)$/m)?.[1];
  if (!nameOverride) {
    return { name: job, templated: false };
  }

  const value = nameOverride.trim().replace(/^['"]|['"]$/g, '');
  return { name: value, templated: value.includes('${{') };
}

function parseJsonArrayLiteral(source: string, regex: RegExp, label: string): string[] {
  const match = source.match(regex);
  assert.ok(match?.[1], `deploy-gate.yml must define ${label}`);
  const parsed = JSON.parse(match[1]);
  assert.ok(Array.isArray(parsed), `${label} must be a JSON array`);
  for (const value of parsed) {
    assert.equal(typeof value, 'string', `${label} entries must be strings`);
  }
  return parsed;
}

function deployGateRequiredChecks(): string[] {
  return parseJsonArrayLiteral(deployGateWorkflow, /\n\s*required='(\[[^\n]+])'/, 'required checks');
}

function deployGateWorkflowRunNames(): string[] {
  return parseJsonArrayLiteral(deployGateWorkflow, /workflows:\s*(\[[^\n]+])/, 'workflow_run workflows');
}

function collectPackageLockfiles(): string[] {
  return execFileSync('git', ['ls-files', '*package-lock.json'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

function collectDockerfiles(): string[] {
  return execFileSync('git', ['ls-files', '*Dockerfile*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /(^|\/)Dockerfile(\.|$)/.test(file))
    .sort();
}

function securityAuditMatrixLockfiles(): string[] {
  return Array.from(securityAuditWorkflow.matchAll(/^\s+lockfile:\s+(.+)$/gm), ([, value]) =>
    value.trim().replace(/^['"]|['"]$/g, ''),
  ).sort();
}

describe('CI workflow coverage', () => {
  it('runs the proto breaking check against the full main history (#6114)', () => {
    const breakingJob = workflowJobBlock(protoCheckWorkflow, 'proto-breaking');
    assert.doesNotMatch(breakingJob, /^\s+if:/m, 'proto-breaking must run for fork pull requests');
    const [checkoutStep] = workflowStepBlocksByUses(breakingJob, 'actions/checkout');
    assert.match(
      checkoutStep,
      /\n\s+with:\n\s+fetch-depth: 0\n/,
      'proto-breaking must fetch full history so the main baseline is available',
    );
    const breakingStep = workflowStepBlock(protoCheckWorkflow, 'Check for breaking proto changes');
    assert.match(
      breakingStep,
      /^\s+run: make breaking\s*$/m,
      'proto-check.yml must run the canonical buf breaking target against the fetched origin/main proto baseline',
    );
    assert.doesNotMatch(breakingStep, /^\s+continue-on-error:/m);

    // Pin the shared Makefile baseline. `run: make breaking` alone stays green if the
    // recipe regresses to proto/.git#branch=main (no repo) or loses origin/main.
    const makefile = read(resolve(root, 'Makefile'));
    assert.match(
      makefile,
      /^breaking:[^\n]*\n\tcd \$\(PROTO_DIR\) && buf breaking --against '\.\.\/\.git#branch=origin\/main,subdir=proto'\s*$/m,
      "make breaking must use '../.git#branch=origin/main,subdir=proto' from PROTO_DIR",
    );

    // Pin the documented FILE/PACKAGE/WIRE_JSON policy (binary WIRE intentionally off).
    const bufYaml = read(resolve(root, 'proto/buf.yaml'));
    const breakingUse = bufYaml.match(/\nbreaking:\n(?:[^\n]*\n)*?[ \t]+use:\n((?:[ \t]+-[^\n]*\n)+)/);
    assert.ok(breakingUse, 'proto/buf.yaml must declare breaking.use');
    const rules = [...breakingUse[1].matchAll(/^[ \t]+-[ \t]+(\S+)\s*$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(
      rules,
      ['FILE', 'PACKAGE', 'WIRE_JSON'].sort(),
      'breaking.use must be exactly FILE, PACKAGE, WIRE_JSON (binary WIRE intentionally omitted)',
    );

    // Path-filtered Proto Generation Check is outside deploy-gate's aggregated
    // workflows (#5402). A red `proto-breaking` check-run does not fail the
    // required `gate` context until it is wired into deploy-gate (with a
    // path-safe always-run/skip pattern) or listed in branch-protection/rulesets.
  });

  it('runs the public documentation boundary on docs-only pull requests', () => {
    const publicDocsJob = workflowJobBlock(lintCodeWorkflow, 'public-docs');

    assert.match(publicDocsJob, /npm run lint:public-docs/);
    assert.doesNotMatch(publicDocsJob, /needs: changes/);
  });

  it('keeps required PR smoke scripts defined and wired into workflows', () => {
    for (const script of REQUIRED_PR_SCRIPTS) {
      assert.equal(typeof packageScripts[script], 'string', `package.json must define ${script}`);
      assert.match(
        workflowText,
        new RegExp(`npm\\s+run\\s+${escapeRegExp(script)}(?:\\s|$)`),
        `A workflow must run npm run ${script}`,
      );
    }
  });

  it('keeps every smoke spec on the combined ci-smoke command line', () => {
    const ciSmoke = packageScripts['test:e2e:ci-smoke'] ?? '';
    // Tokenize as the shell would, and stop at the first comment token: npm
    // scripts run under `sh -c`, where a word-initial `#` comments out the
    // rest of the line. A substring check would stay green with the spec
    // paths sitting in the commented-out tail while playwright never runs
    // them — the argv-token check is what gives this guard teeth.
    const argvTokens: string[] = [];
    for (const token of ciSmoke.trim().split(/\s+/)) {
      if (token.startsWith('#')) break;
      argvTokens.push(token);
    }
    for (const spec of REQUIRED_CI_SMOKE_SPECS) {
      assert.ok(
        argvTokens.includes(spec),
        `test:e2e:ci-smoke must pass ${spec} as a live argv token — a spec dropped ` +
          '(or commented out) from this command has no other CI invocation',
      );
    }
    assert.ok(
      argvTokens.includes('VITE_VARIANT=full'),
      'test:e2e:ci-smoke must pin VITE_VARIANT=full — variant-live-smoke asserts the full-variant panel set',
    );
  });

  it('keeps the main Test workflow jobs for defensibility smoke gates', () => {
    for (const job of REQUIRED_TEST_JOBS) {
      assert.match(testWorkflow, new RegExp(`\\n  ${escapeRegExp(job)}:\\n`), `test.yml must define ${job}`);
    }
  });

  it('keeps required smoke jobs capped with explicit timeouts', () => {
    for (const job of TIMEOUT_CAPPED_TEST_JOBS) {
      assert.match(testJobBlock(job), /\n {4}timeout-minutes: \d+\n/, `${job} must set timeout-minutes`);
    }
  });

  it('keeps the deploy gate wired to every Test workflow check job', () => {
    const workflowRunNames = deployGateWorkflowRunNames();
    const requiredChecks = deployGateRequiredChecks();

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      assert.ok(
        workflowRunNames.includes(workflowName),
        `deploy-gate.yml must run after ${workflowName} completes`,
      );
    }
    for (const job of workflowJobNames(testWorkflow, 'test.yml')) {
      assert.ok(
        requiredChecks.includes(job),
        `deploy-gate.yml must require every test.yml job; missing ${job}`,
      );
    }
    for (const check of REQUIRED_NON_TEST_GATE_CHECKS) {
      assert.ok(requiredChecks.includes(check), `deploy-gate.yml must require ${check}`);
    }
    assert.match(
      deployGateWorkflow,
      /All required PR gates passed/,
      'deploy-gate.yml success status must describe the full gate set',
    );
    assert.doesNotMatch(
      deployGateWorkflow,
      /unit \+ typecheck/i,
      'deploy-gate.yml must not regress to the old unit+typecheck-only gate',
    );
  });

  // #5402: `sidecar` runs in CI but is not one of branch protection's four
  // required contexts (biome, typecheck, unit, gate). It blocks merge anyway,
  // because the required `gate` context aggregates it — but only because
  // someone remembered to list it. Nothing forced that, and the same omission
  // is invisible for every other job: a job absent from `required` is simply
  // never inspected, so it reports red on the PR and the gate still goes green.
  // The check below covers every workflow the gate aggregates, not just
  // test.yml, so a new job cannot land in an advisory-only state.
  it('requires every job of every workflow the deploy gate aggregates', () => {
    const requiredChecks = deployGateRequiredChecks();
    const sources = gatedWorkflowSources();
    const advisoryOnly: string[] = [];

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      const source = sources.get(workflowName);
      assert.ok(source, `a workflow named ${workflowName} must exist for the deploy gate to aggregate it`);

      for (const job of workflowJobNames(source, workflowName)) {
        const { name, templated } = effectiveCheckName(source, job);
        const exemption = GATE_CHECK_EXEMPTIONS[job];

        if (exemption && exemption.workflow === workflowName) {
          assert.ok(
            templated,
            `${workflowName}/${job} is exempt from the gate only because its check-run name is templated, but it publishes the literal name ${name} — require it directly instead`,
          );
          assert.ok(
            requiredChecks.includes(exemption.coveredBy),
            `${workflowName}/${job} is exempt because ${exemption.coveredBy} blocks on its behalf, so ${exemption.coveredBy} must itself be a required gate check`,
          );
          continue;
        }

        assert.ok(
          !templated,
          `${workflowName}/${job} publishes a per-matrix check-run name (${name}) that the gate cannot match, and has no GATE_CHECK_EXEMPTIONS entry naming the aggregate that covers it`,
        );

        if (!requiredChecks.includes(name)) {
          advisoryOnly.push(`${workflowName}/${name}`);
        }
      }
    }

    assert.deepEqual(
      advisoryOnly,
      [],
      `deploy-gate.yml must require every job of every workflow it aggregates. These run in CI but a red result does not block merge (#5402): ${advisoryOnly.join(', ')}`,
    );
  });

  // The mirror-image failure of the check above, and the more disruptive one:
  // a `required` entry that no job publishes never resolves, so the gate holds
  // at "Waiting for required PR gates" on every PR until someone edits the
  // workflow. Renaming or deleting a gated job must fail here, not in the queue.
  it('keeps the deploy gate required list free of checks no gated workflow publishes', () => {
    const sources = gatedWorkflowSources();
    const published = new Set<string>();

    for (const workflowName of REQUIRED_GATE_WORKFLOWS) {
      const source = sources.get(workflowName);
      assert.ok(source, `a workflow named ${workflowName} must exist for the deploy gate to aggregate it`);

      for (const job of workflowJobNames(source, workflowName)) {
        const { name, templated } = effectiveCheckName(source, job);
        if (!templated) {
          published.add(name);
        }
      }
    }

    const phantom = deployGateRequiredChecks().filter((check) => !published.has(check));

    assert.deepEqual(
      phantom,
      [],
      `deploy-gate.yml requires checks no gated workflow publishes, so the gate can never leave "pending": ${phantom.join(', ')}`,
    );
  });

  // #5822: the gate matches check runs by name alone, then keeps only the one
  // that finished last. Two jobs publishing the same name — in different
  // workflows or the same one — collapse to that single run and the others'
  // conclusions are discarded, so a failure in any of them is invisible.
  //
  // For a `changes`-style filter job that is fail-open twice over: its
  // dependents are `if: needs.changes.outputs.code == 'true'`, so when it fails
  // they are *skipped* rather than failed, and the gate deliberately counts
  // `skipped` as passing (docs-only PRs). A masked `changes` failure therefore
  // takes an entire required suite green with it.
  //
  // Scan every workflow, not just the four the gate aggregates: the gate reads
  // all check runs on the SHA regardless of which workflow published them, and
  // it evaluates main pushes too, where a push- or schedule-triggered workflow
  // lands its check runs on the very same commit.
  it('keeps every gate-required check-run name published by exactly one job', () => {
    const publishers = new Map<string, string[]>();

    for (const file of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
      const source = read(resolve(workflowsDir, file));

      for (const job of workflowJobNames(source, file)) {
        const { name, templated } = effectiveCheckName(source, job);
        if (templated) {
          continue;
        }
        publishers.set(name, [...(publishers.get(name) ?? []), `${file}:${job}`]);
      }
    }

    // Every gated job's effective name has to be in `required` (asserted
    // above), so keying off `required` still covers all four gated workflows
    // while leaving harmless duplicates alone — two cron-only workflows may
    // both call a job `monitor` without the gate ever reading either.
    //
    // Exactly one, not at-least-one: a zero-publisher name hangs the gate at
    // "pending" forever, and checking both directions means an empty or
    // mis-parsed scan above fails here instead of vacuously passing.
    const misrouted = deployGateRequiredChecks()
      .map((check) => ({ check, sites: publishers.get(check) ?? [] }))
      .filter(({ sites }) => sites.length !== 1)
      .map(({ check, sites }) => `${check} <- ${sites.length > 0 ? sites.join(', ') : 'no job publishes it'}`);

    assert.deepEqual(
      misrouted,
      [],
      `deploy-gate.yml keys on the check-run name only and keeps just the last-completed run, so a required name published by more than one job masks every other publisher's failure, and one published by none never leaves "pending" (#5822). Give each job a distinct name: ${misrouted.join('; ')}`,
    );
  });

  it('paginates gate status history during the scheduled self-healing sweep', () => {
    const deployGateJob = workflowJobBlock(deployGateWorkflow, 'gate');

    assert.match(deployGateJob, /gh api --paginate --slurp/);
    assert.match(deployGateJob, /commits\/\$s\/statuses\?per_page=100/);
    assert.match(
      deployGateJob,
      /flatten \| map\(select\(\.context == "gate"\)\) \| first/,
    );
    assert.doesNotMatch(deployGateJob, /sort_by\(\.updated_at\)/);
    assert.doesNotMatch(
      deployGateJob,
      /commits\/\$s\/status"/,
      'the combined status endpoint silently truncates large commit-status histories',
    );
  });

  it('treats sidecar changes as code for PR smoke gating', () => {
    assert.ok(
      testWorkflow.includes('^src-tauri\\/sidecar\\/'),
      'test.yml must not classify src-tauri/sidecar changes as docs-only changes',
    );
  });

  it('routes Tauri config edits into the job that runs the one-binary gate (#5908)', () => {
    // Executes the real awk from test.yml rather than string-matching it: a
    // regex typo in the carve-out would silently exempt Tauri-config changes
    // from CI while a source-text assertion stayed green — the same drift class
    // #5908 was filed to fix. tests/desktop-one-binary-model.test.mjs runs in
    // `unit`, which is gated on this `code` output.
    const awkBlock = shellAwkAssignmentBlock('CODE');
    const program = awkBlock.slice(awkBlock.indexOf("awk '") + 5, awkBlock.lastIndexOf("'"));
    const codeFilterSays = (path: string) => {
      const out = execFileSync('awk', [program], { input: `${path}\n`, encoding: 'utf8' });
      return Number(out.trim()) > 0;
    };

    for (const path of [
      'src-tauri/tauri.conf.json',
      'src-tauri/tauri.tech.conf.json',
      'src-tauri/profiles/commodity.json',
      'api/download.js',
      'src/config/variant.ts',
      'scripts/desktop-package.mjs',
      'package.json',
      '.github/workflows/build-desktop.yml',
    ]) {
      assert.ok(codeFilterSays(path), `${path} must set code=true so the one-binary gate runs`);
    }

    // The carve-out must stay a carve-out: Rust and capability edits are still
    // covered by desktop-config/desktop-rust, not by the full unit suite.
    for (const path of ['src-tauri/Cargo.toml', 'src-tauri/src/main.rs', 'README.md', 'docs/desktop-app.mdx']) {
      assert.ok(!codeFilterSays(path), `${path} must not set code=true`);
    }
  });

  it('keeps resilience validation bundle inputs in the CI change filter', () => {
    assert.ok(
      testWorkflow.includes('validation: ${{ steps.diff.outputs.validation }}'),
      'test.yml must expose a validation change output',
    );
    for (const input of REQUIRED_RESILIENCE_VALIDATION_INPUTS) {
      assert.ok(testWorkflow.includes(workflowRegexNeedle(input)), `test.yml must cover ${input}`);
    }
  });

  it('keeps desktop drift-gate inputs in the CI change filter (#5902)', () => {
    assert.ok(
      testWorkflow.includes('desktop_config: ${{ steps.diff.outputs.desktop_config }}'),
      'test.yml must expose a desktop_config change output',
    );
    assert.ok(
      testWorkflow.includes('desktop_rust: ${{ steps.diff.outputs.desktop_rust }}'),
      'test.yml must expose a desktop_rust change output',
    );
    const desktopConfigFilter = shellAwkAssignmentBlock('DESKTOP_CONFIG');
    const desktopRustFilter = shellAwkAssignmentBlock('DESKTOP_RUST');
    for (const input of REQUIRED_DESKTOP_CONFIG_INPUTS) {
      assert.ok(
        desktopConfigFilter.includes(workflowRegexNeedle(input)),
        `test.yml desktop_config filter must cover ${input}`,
      );
    }
    assert.ok(
      desktopConfigFilter.includes('/^\\.github\\/workflows\\/.*\\.ya?ml$/'),
      'test.yml desktop_config filter must cover every workflow file for dynamic Tauri inventory',
    );
    assert.equal(
      evaluateDesktopConfigFilter(desktopConfigFilter, ['.github/workflows/nightly.yaml']),
      '1',
      'desktop_config must trigger for a newly added workflow file',
    );
    assert.equal(
      evaluateDesktopConfigFilter(desktopConfigFilter, ['src/app.ts']),
      '0',
      'desktop_config must not trigger for an unrelated source file',
    );
    for (const input of REQUIRED_DESKTOP_RUST_INPUTS) {
      assert.ok(
        desktopRustFilter.includes(workflowRegexNeedle(input)),
        `test.yml desktop_rust filter must cover ${input}`,
      );
    }
    assert.match(
      testJobBlock('desktop-config'),
      /if: needs\.changes\.outputs\.desktop_config == 'true'/,
      'desktop-config job must use the desktop_config change output',
    );
    // Cargo.lock is the only thing that decides which crate versions ship, and
    // no other job inspects it (security-audit covers npm lockfiles only), so
    // dropping this step would let a cargo update silently reintroduce a known
    // advisory — CVE-2026-42184 / #5518 is the case that motivated it.
    const floorStep = workflowStepBlock(testWorkflow, 'Rust dependency security floors (#5518)');
    assert.match(
      floorStep,
      /^\s+run: node scripts\/check-rust-security-floors\.mjs\s*$/m,
      'desktop-config job must run the Rust dependency security-floor check',
    );
    // A presence-only assertion would stay green with the step neutered, so
    // pin that it still fails the job (same guard the AppImage step carries).
    assert.doesNotMatch(floorStep, /^\s+continue-on-error:/m);
    const releaseFloorStep = workflowStepBlock(desktopBuildWorkflow, 'Rust dependency security floors (#5518)');
    assert.match(
      releaseFloorStep,
      /^\s+run: node scripts\/check-rust-security-floors\.mjs\s*$/m,
      'release workflow must verify the security floors of the lockfile it ships',
    );
    assert.doesNotMatch(releaseFloorStep, /^\s+continue-on-error:/m);
    assert.match(
      testJobBlock('desktop-rust'),
      /if: needs\.changes\.outputs\.desktop_rust == 'true'/,
      'desktop-rust job must use the desktop_rust change output',
    );
    // The sidecar handler bundle build must live in the `unit` job: its
    // esbuild input graph spans src/ and server/ via the @/ alias, and only
    // the `code` filter tracks that whole surface (#5902). A refactor moving
    // it back to a narrower path-gated job would silently re-open the
    // "bundle-breaking change with green PR CI" gap.
    assert.match(
      testJobBlock('unit'),
      /^\s+node scripts\/build-sidecar-handlers\.mjs\s*$/m,
      'unit job must run the sidecar handler bundle build',
    );
    // Desktop build env parity (#5905) runs in BOTH legs deliberately:
    // desktop-config fires on workflow edits (build-desktop.yml is excluded
    // from the `code` filter), while unit fires when src/ gains a new
    // import.meta.env.VITE_ read. Dropping either leg reopens half the gap.
    assert.match(
      testJobBlock('desktop-config'),
      /^\s+run: node scripts\/check-desktop-build-env\.mjs\s*$/m,
      'desktop-config job must run the desktop build env parity check',
    );
    assert.match(
      testJobBlock('unit'),
      /^\s+run: node scripts\/check-desktop-build-env\.mjs\s*$/m,
      'unit job must run the desktop build env parity check',
    );
    const releasePreflight = workflowStepBlock(desktopBuildWorkflow, 'Release client-env preflight (#5905)');
    assert.match(releasePreflight, /\[ "\$\{\{ github\.event_name \}\}" = "push" \] \|\|/);
    assert.match(releasePreflight, /\[ "\$\{\{ github\.event_name \}\}" = "workflow_dispatch" \]/);
    assert.match(releasePreflight, /\[ "\$\{\{ github\.event\.inputs\.draft \}\}" != "true" \]/);
    assert.doesNotMatch(releasePreflight, /VITE_VAPID_PUBLIC_KEY/);
    const canaryPreflight = workflowStepBlock(desktopCanaryWorkflow, 'Client env preflight (#5905)');
    assert.match(canaryPreflight, /requires non-empty client env/);
    assert.match(canaryPreflight, /VITE_CLERK_PUBLISHABLE_KEY/);
    assert.match(canaryPreflight, /VITE_CONVEX_URL/);
    assert.doesNotMatch(canaryPreflight, /VITE_VAPID_PUBLIC_KEY/);
    assert.throws(
      () => runReleasePreflight(releasePreflight, 'push', '', ''),
      (error) => error.status === 1,
      'tag pushes must fail when client env secrets are empty',
    );
    assert.throws(
      () => runReleasePreflight(releasePreflight, 'workflow_dispatch', 'false', ''),
      (error) => error.status === 1,
      'published manual dispatches must fail when client env secrets are empty',
    );
    assert.doesNotThrow(
      () => runReleasePreflight(releasePreflight, 'workflow_dispatch', 'true', ''),
      'draft manual dispatches may run with empty client env secrets',
    );
    assert.doesNotThrow(
      () => runReleasePreflight(releasePreflight, 'push', '', 'configured'),
      'populated tag releases must pass the client env preflight',
    );
    // #5908: one published desktop binary means exactly one local build script,
    // so the env gate has one place to live. Asserting the absence of the
    // per-variant scripts keeps this from silently covering less than it did —
    // a reintroduced `desktop:build:tech` would otherwise never be gate-checked.
    assert.match(
      packageScripts['desktop:tauri:build'] ?? '',
      /npm run desktop:check-env/,
      'desktop:tauri:build must run the local desktop env gate',
    );
    assert.deepEqual(
      Object.keys(packageScripts).filter((name) => /^desktop:(tauri:)?build:/.test(name)),
      [],
      'per-variant desktop build scripts were retired with the one-binary model (#5908)',
    );
    const releasePostProcess = workflowStepBlock(desktopBuildWorkflow, 'Strip GPU libraries from AppImage');
    assert.match(
      releasePostProcess,
      /^\s+bash scripts\/repack-linux-appimage\.sh "\$APPIMAGE" "\$TOOL_ARCH"\s*$/m,
      'release workflow must apply the shared AppImage post-processing',
    );
    assert.match(releasePostProcess, /^\s+if: contains\(matrix\.platform, 'ubuntu'\)\s*$/m);
    assert.doesNotMatch(releasePostProcess, /^\s+continue-on-error:/m);
    const canaryPostProcess = workflowStepBlock(
      desktopCanaryWorkflow,
      'Apply release AppImage post-processing',
    );
    assert.match(
      canaryPostProcess,
      /^\s+bash scripts\/repack-linux-appimage\.sh "\$\{IMAGES\[0]}" x86_64\s*$/m,
      'desktop canary must smoke-test the release-processed AppImage',
    );
    assert.doesNotMatch(canaryPostProcess, /^\s+(?:if|continue-on-error):/m);
    const desktopCanarySmoke = workflowStepBlock(desktopCanaryWorkflow, 'Smoke-test AppImage');
    assert.doesNotMatch(desktopCanarySmoke, /^\s+continue-on-error:/m);
    assert.match(
      desktopCanarySmoke,
      /if CODE=\$\(curl[\s\S]{0,200}\[\[ "\$CODE" =~ \^\[1-5]\[0-9]\[0-9]\$ \]\]; then/,
      'desktop canary readiness must require curl success and a real HTTP status',
    );
    assert.match(
      desktopCanarySmoke,
      /if FINAL_CODE=\$\(curl[\s\S]{0,200}\[\[ "\$FINAL_CODE" =~ \^\[1-5]\[0-9]\[0-9]\$ \]\]; then/,
      'desktop canary must re-probe sidecar liveness after the observation window',
    );
    assert.ok(
      desktopCanarySmoke.indexOf('if kill -0 "$APP_PID"') >
        desktopCanarySmoke.indexOf('if FINAL_CODE=$(curl'),
      'desktop canary must check app liveness after the final sidecar probe',
    );
    assert.match(
      desktopCanarySmoke,
      /^\s+if grep -q "SIDECAR_FINAL_STATUS=alive" \/tmp\/display-server\.log 2>\/dev\/null; then\s*$/m,
      'desktop canary must gate success on final sidecar liveness',
    );
  });

  it('runs workflow coverage when the release workflow changes', () => {
    const codeFilter = shellAwkAssignmentBlock('CODE');
    assert.doesNotMatch(
      codeFilter,
      /build-desktop\.yml/,
      'build-desktop.yml changes must run the unit workflow-coverage assertions',
    );
  });

  it('runs scheduled and per-PR production dependency audits for every package lockfile', () => {
    const packageLockfiles = collectPackageLockfiles();

    assert.match(securityAuditWorkflow, /\n {2}pull_request:\n/, 'security-audit.yml must run on PRs');
    assert.match(securityAuditWorkflow, /\n {2}push:\n {4}branches: \[main\]\n/, 'security-audit.yml must run on main pushes');
    assert.match(securityAuditWorkflow, /\n {2}schedule:\n/, 'security-audit.yml must run on a schedule');
    assert.match(securityAuditWorkflow, /\n {2}security-audit:\n/, 'security-audit.yml must define the aggregate security-audit check');
    assert.match(securityAuditWorkflow, /\n {4}name: security-audit\n/, 'security-audit.yml must publish a security-audit check run');
    assert.match(
      securityAuditWorkflow,
      /if:\s*\$\{\{\s*always\(\)\s*\}\}/,
      'security-audit.yml must always publish the aggregate check',
    );
    assert.match(
      securityAuditWorkflow,
      /AUDIT_RESULT"\s*=\s*"cancelled"/,
      'security-audit.yml must publish a failing aggregate check when the audit matrix is cancelled',
    );
    assert.match(
      securityAuditWorkflow,
      /--package-json "\$\{\{ matrix\.package_json \}\}"/,
      'security-audit.yml must pass nonstandard package manifests to the audit gate',
    );
    assert.match(
      securityAuditWorkflow,
      /node \.github\/scripts\/audit-production-dependencies\.mjs/,
      'security-audit.yml must run the production dependency audit gate',
    );
    assert.match(
      securityAuditScript,
      /npm['"],\s*\[\s*['"]audit['"],\s*['"]--omit=dev['"],\s*['"]--json['"]/,
      'the production dependency audit gate must run npm audit --omit=dev --json',
    );
    assert.match(
      securityAuditScript,
      /collectUnbaselinedFindings/,
      'the production dependency audit gate must fail on unbaselined high-severity production advisories',
    );
    assert.deepEqual(
      securityAuditMatrixLockfiles(),
      packageLockfiles,
      'security-audit.yml must cover exactly the repo package-lock.json files',
    );

    for (const lockfile of packageLockfiles) {
      assert.match(
        securityAuditWorkflow,
        new RegExp(`\\n\\s+lockfile:\\s+${escapeRegExp(lockfile)}\\n`),
        `security-audit.yml must cover ${lockfile}`,
      );
    }
  });

  it('keeps the aggregate verdict list in step with the audit matrix', () => {
    // The aggregate decides pass/fail by looking for one verdict file per matrix
    // entry. If the two lists drift, a lockfile that never ran silently stops
    // being counted and the aggregate reports success — a fail-open. Pin them
    // to each other.
    const matrixNames = Array.from(
      securityAuditWorkflow.matchAll(/^\s+- name: (\S+)\n\s+path:/gm),
      ([, value]) => value.trim(),
    ).sort();
    const aggregateNames = (securityAuditWorkflow.match(/^\s+AUDIT_NAMES:\s*'([^']+)'/m)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .sort();

    assert.ok(matrixNames.length > 0, 'security-audit.yml must define audit matrix entries');
    assert.deepEqual(
      aggregateNames,
      matrixNames,
      'the security-audit aggregate must require a verdict from exactly the audit-lockfile matrix entries',
    );
  });

  it('separates an unaudited lockfile from a real dependency finding', () => {
    // A GitHub Actions outage (2026-08-06: "Failed to resolve action download
    // info") kills the matrix job before it audits anything. The aggregate must
    // report that as an incomplete run, not as "audits failed".
    assert.match(
      securityAuditWorkflow,
      /if-no-files-found: ignore/,
      'security-audit.yml must upload a per-lockfile verdict artifact',
    );
    assert.match(
      securityAuditWorkflow,
      /uses: actions\/download-artifact@[0-9a-f]{40}/,
      'the security-audit aggregate must download the per-lockfile verdicts',
    );
    assert.match(
      securityAuditWorkflow,
      /No audit verdict was produced for/,
      'the aggregate must name the lockfiles that produced no verdict',
    );
  });

  it('gives the audit gate the base ref it needs to attribute new advisories', () => {
    // Without a base ref every finding is "inherited", so a PR that genuinely
    // introduces a vulnerable dependency would only warn.
    assert.match(
      securityAuditWorkflow,
      /AUDIT_BASE_REF: \$\{\{ github\.event_name == 'pull_request'/,
      'security-audit.yml must pass the PR base sha to the audit gate',
    );
    assert.match(
      securityAuditWorkflow,
      /git fetch --no-tags --depth=1 origin \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
      'security-audit.yml must fetch the base commit so the base lockfile is readable',
    );
    assert.match(
      securityAuditScript,
      /collectIntroducedIds/,
      'the audit gate must compute which advisories the change introduced',
    );
  });

  it('keeps Docker base images pinned to immutable digests', () => {
    const failures: string[] = [];

    for (const dockerfile of collectDockerfiles()) {
      const aliases = new Set<string>();
      const source = readFileSync(resolve(root, dockerfile), 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        const match = line.match(/^FROM\s+(.+)$/i);
        if (!match) return;

        const parts = match[1].trim().split(/\s+/);
        while (parts[0]?.startsWith('--')) {
          parts.shift();
        }

        const image = parts[0];
        const asIndex = parts.findIndex((part) => part.toUpperCase() === 'AS');
        const alias = asIndex >= 0 ? parts[asIndex + 1] : undefined;
        const isKnownStage = image ? aliases.has(image) : false;
        if (alias) {
          aliases.add(alias);
        }

        if (!image || image === 'scratch' || isKnownStage) return;

        if (!/@sha256:[0-9a-f]{64}$/i.test(image)) {
          failures.push(`${dockerfile}:${index + 1} ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      failures,
      [],
      `Docker FROM images must be pinned with full @sha256:<64 hex> digests:\n${failures.join('\n')}`,
    );
  });

  it('keeps GitHub Actions external uses pinned to commit SHAs', () => {
    const failures: string[] = [];
    const workflowFiles = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort();

    for (const workflowFile of workflowFiles) {
      const source = readFileSync(resolve(workflowsDir, workflowFile), 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        const match = line.match(/^\s*uses:\s*([^@\s#]+)@([^\s#]+)/);
        if (!match) return;

        const [, action, ref] = match;
        if (action.startsWith('./') || action.startsWith('docker://')) return;

        if (!/^[0-9a-f]{40}$/i.test(ref)) {
          failures.push(`${workflowFile}:${index + 1} ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      failures,
      [],
      `GitHub Actions uses refs must be 40-character commit SHAs:\n${failures.join('\n')}`,
    );
  });
});
