import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { classifyRustAudit, runRustAudit } from '../.github/scripts/audit-rust-dependencies.mjs';
const now = Date.parse('2026-09-08');
const finding = (patched = ['>=1.1.0']) => ({
  advisory: { id: 'RUSTSEC-2026-0001' },
  package: { name: 'fixture', version: '1.0.0' },
  versions: { patched },
});
const report = (list = []) => ({
  database: { 'advisory-count': 1, 'last-commit': null },
  lockfile: { 'dependency-count': 1 },
  settings: { ignore: [], target_arch: [], target_os: [], severity: null },
  vulnerabilities: { found: list.length > 0, count: list.length, list },
  warnings: {},
});
const decision = {
  status: 'approved',
  approvedBy: 'synthetic fixture reviewer',
  approvedAt: '2026-09-01',
  id: 'RUSTSEC-2026-0001',
  owner: '#5935',
  reason: 'Fixture API does not receive untrusted data',
  expiresAt: '2026-10-01',
};
test('clean, fixable and no-fix results stay distinct', () => {
  assert.equal(classifyRustAudit(report(), [], now).status, 'clean');
  assert.equal(classifyRustAudit(report([finding()]), [], now).status, 'failed');
  const noFix = classifyRustAudit(report([finding([])]), [], now);
  assert.equal(noFix.status, 'warning');
  assert.equal(noFix.noFix.length, 1);
});
test('decisions require owner, reason, expiry and unique IDs', () => {
  for (const patch of [{ owner: '' }, { reason: '' }, { expiresAt: null }, { id: 'bad' }])
    assert.throws(() => classifyRustAudit(report(), [{ ...decision, ...patch }], now));
  assert.throws(() => classifyRustAudit(report(), [decision, decision], now));
});
test('a decision expires at its boundary and cannot silently become stale', () => {
  assert.equal(classifyRustAudit(report([finding()]), [decision], now).approved.length, 1);
  const expired = classifyRustAudit(report([finding([])]), [decision], Date.parse(decision.expiresAt));
  assert.equal(expired.status, 'failed');
  assert.match(expired.decisionErrors[0], /expired/);
  assert.equal(classifyRustAudit(report(), [decision], now).status, 'failed');
});
test('malformed and ignored reports cannot become clean', () => {
  for (const input of [
    {},
    { ...report(), lockfile: { 'dependency-count': 0 } },
    { ...report(), settings: { ignore: ['RUSTSEC-2026-0001'] } },
    { ...report(), vulnerabilities: { count: 0, list: [finding()] } },
    report([{ ...finding(), versions: {} }]),
  ])
    assert.throws(() => classifyRustAudit(input, [], now));
});
test('informational notices remain visible', () => {
  const input = report();
  input.warnings.unmaintained = [finding([])];
  const result = classifyRustAudit(input, [], now);
  assert.equal(result.status, 'warning');
  assert.equal(result.warnings[0].kind, 'unmaintained');
});
test('database outage never invokes the audit and strict sweep fails', () => {
  for (const strict of [false, true]) {
    let calls = 0;
    const result = runRustAudit({
      lockfile: 'src-tauri/Cargo.lock',
      decisions: [],
      failOnOutage: strict,
      run: (command) => {
        calls++;
        assert.equal(command, 'git');
        return { status: 128, stderr: 'Could not resolve host' };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.failed, strict);
  }
});
test('runner uses fresh DB, neutral cwd and exact lockfile then classifies real report', () => {
  let calls = 0;
  const result = runRustAudit({
    lockfile: 'src-tauri/Cargo.lock',
    decisions: [],
    run: (command, args, options) => {
      calls++;
      if (command === 'git') return { status: 0 };
      assert.equal(command, 'cargo');
      assert.ok(args.includes('--no-fetch'));
      assert.ok(args.includes('--no-yanked'));
      assert.ok(args.at(-1).endsWith('/src-tauri/Cargo.lock'));
      assert.notEqual(options.cwd, process.cwd());
      return { status: 1, stdout: JSON.stringify(report([finding()])) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.failed, true);
});
test('missing input, missing tool and invalid audit output hard-fail', () => {
  assert.throws(() => runRustAudit({ lockfile: '/nonexistent/Cargo.lock', decisions: [] }));
  assert.throws(() =>
    runRustAudit({
      lockfile: 'src-tauri/Cargo.lock',
      decisions: [],
      run: () => ({ error: Object.assign(new Error('missing git'), { code: 'ENOENT' }) }),
    }),
  );
  assert.throws(() =>
    runRustAudit({
      lockfile: 'src-tauri/Cargo.lock',
      decisions: [],
      run: (cmd) => (cmd === 'git' ? { status: 0 } : { status: 1, stdout: '{}' }),
    }),
  );
});

test('the actual aggregate shell preserves Rust verdicts and outage policy', () => {
  const workflow = YAML.parse(readFileSync('.github/workflows/security-audit.yml', 'utf8'));
  const job = workflow.jobs['security-audit'];
  assert.ok(job.needs.includes('audit-rust'));
  const step = job.steps.find((s) => s.run);
  const dir = mkdtempSync(join(tmpdir(), 'rust-aggregate-'));
  try {
    mkdirSync(join(dir, 'audit-status'));
    for (const name of step.env.AUDIT_NAMES.split(' '))
      writeFileSync(join(dir, 'audit-status', `${name}.txt`), 'passed\n');
    for (const [status, strict, expected] of [
      ['clean', false, 0],
      ['warning', true, 0],
      ['failed', false, 1],
      ['unavailable', false, 0],
      ['unavailable', true, 1],
      ['missing', false, 1],
      ['missing', true, 1],
      ['unexpected', false, 1],
    ]) {
      const file = join(dir, 'audit-status/rust.txt');
      if (status === 'missing') rmSync(file, { force: true });
      else writeFileSync(file, `${status}\n`);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          AUDIT_NAMES: step.env.AUDIT_NAMES,
          AUDIT_RESULT: 'success',
          RUST_RESULT: 'success',
          FAIL_ON_OUTAGE: strict ? '1' : '0',
        },
      });
      assert.equal(result.status, expected, `${status} strict=${strict}: ${result.stdout} ${result.stderr}`);
      if (status === 'unavailable') assert.match(result.stdout, /NOT audited/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('fixable unsoundness warnings block; no-fix unsoundness stays explicit', () => {
  const input = report();
  input.warnings.unsound = [finding()];
  assert.equal(classifyRustAudit(input, [], now).status, 'failed');
  input.warnings.unsound = [finding([])];
  assert.equal(classifyRustAudit(input, [], now).noFix.length, 1);
  assert.equal(classifyRustAudit(input, [decision], now).approved.length, 1);
});

test('CLI writes a failed verdict for findings and bad decisions through real subprocesses', () => {
  const script = resolve('.github/scripts/audit-rust-dependencies.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rust-cli-'));
  try {
    mkdirSync(join(dir, 'src-tauri'));
    mkdirSync(join(dir, '.github'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'src-tauri/Cargo.lock'), '# synthetic lock input');
    writeFileSync(join(dir, '.github/rust-advisory-decisions.json'), '[]');
    writeFileSync(join(dir, 'bin/git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'bin/cargo'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(report([finding()]))}'\nexit 1\n`, {
      mode: 0o755,
    });
    const status = join(dir, 'status.txt');
    const invoke = () =>
      spawnSync(process.execPath, [script], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, AUDIT_STATUS_FILE: status },
      });
    const findingResult = invoke();
    assert.equal(findingResult.status, 1, findingResult.stderr);
    assert.equal(readFileSync(status, 'utf8'), 'failed\n');
    assert.match(findingResult.stdout, /RUSTSEC-2026-0001/);
    writeFileSync(join(dir, '.github/rust-advisory-decisions.json'), '{}');
    const invalid = invoke();
    assert.equal(invalid.status, 1);
    assert.equal(readFileSync(status, 'utf8'), 'failed\n');
    assert.match(invalid.stdout, /decisions must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired decisions fail before a database outage can soften the result', () => {
  assert.throws(
    () =>
      runRustAudit({
        lockfile: 'src-tauri/Cargo.lock',
        decisions: [decision],
        now: Date.parse(decision.expiresAt),
        run: () => assert.fail('must reject the expired decision before fetching'),
      }),
    /decisions expired/,
  );
});

test('a proposed exception cannot suppress a fixable advisory', () => {
  const proposed = { ...decision, status: 'proposed' };
  const result = classifyRustAudit(report([finding()]), [proposed], now);
  assert.equal(result.status, 'failed');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.approved.length, 0);
  assert.equal(result.proposed.length, 1);
  assert.throws(() => classifyRustAudit(report([finding()]), [{ ...decision, approvedBy: '' }], now));
  assert.throws(() => classifyRustAudit(report([finding()]), [{ ...decision, approvedAt: null }], now));
});
