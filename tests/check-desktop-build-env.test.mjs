import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  EXCLUDED_DESKTOP_BUILD_ENV,
  REQUIRED_DESKTOP_BUILD_ENV,
  checkDesktopBuildEnv,
  discoverDesktopBuildWorkflows,
  extractTauriBuildSteps,
} from '../scripts/check-desktop-build-env.mjs';

const ENV_LINES = REQUIRED_DESKTOP_BUILD_ENV.map((k) => `          ${k}: x`).join('\n');
const FIXTURE_WORKFLOWS = ['.github/workflows/build-desktop.yml', '.github/workflows/test-linux-app.yml'];

function buildWorkflow(envLines = ENV_LINES, { stepCount = 4, removeKeyFromStep = -1 } = {}) {
  const steps = Array.from({ length: stepCount }, (_, index) => {
    const stepEnvLines =
      index === removeKeyFromStep
        ? envLines
            .split('\n')
            .filter((line) => !line.includes('VITE_ENABLE_CYBER_LAYER:'))
            .join('\n')
        : envLines;
    return [
      `      - name: Build Tauri app fixture-${index + 1}`,
      '        uses: tauri-apps/tauri-action@abc',
      '        env:',
      stepEnvLines,
      '        with:',
      '          args: ""',
    ].join('\n');
  }).join('\n');
  return [
    'name: Fixture',
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@abc',
    steps,
    '',
  ].join('\n');
}

function makeFixtureRoot({ workflowSource, spaSource } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop-env-fixture-'));
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const wf of FIXTURE_WORKFLOWS) {
    writeFileSync(path.join(root, wf), workflowSource ?? buildWorkflow());
  }
  writeFileSync(
    path.join(root, 'src/app.ts'),
    spaSource ?? `const a = import.meta.env.${REQUIRED_DESKTOP_BUILD_ENV[0]};\n`,
  );
  return root;
}

const roots = [];
const fixtureRoot = (opts) => {
  const root = makeFixtureRoot(opts);
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('check-desktop-build-env', () => {
  it('extracts only tauri-action steps with their env keys', () => {
    const steps = extractTauriBuildSteps(buildWorkflow());
    assert.equal(steps.length, 4);
    assert.equal(steps[0].name, 'Build Tauri app fixture-1');
    assert.deepEqual(steps.flatMap((step) => step.envKeys), Array(4).fill(REQUIRED_DESKTOP_BUILD_ENV).flat());
  });

  it('catches a tauri step declared uses-first with no name (parser-evasion guard)', () => {
    const usesFirst = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: tauri-apps/tauri-action@abc',
      '        env:',
      `          ${REQUIRED_DESKTOP_BUILD_ENV[0]}: x`,
      '',
    ].join('\n');
    const steps = extractTauriBuildSteps(usesFirst);
    assert.equal(steps.length, 1);
    assert.match(steps[0].name, /unnamed tauri step/);
    assert.deepEqual(steps[0].envKeys, [REQUIRED_DESKTOP_BUILD_ENV[0]]);
  });

  it('handles indentationless step sequences', () => {
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '    - uses: tauri-apps/tauri-action@abc',
      '      env:',
      `        ${REQUIRED_DESKTOP_BUILD_ENV[0]}: x`,
      '',
    ].join('\n');
    const steps = extractTauriBuildSteps(workflow);
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0].envKeys, [REQUIRED_DESKTOP_BUILD_ENV[0]]);
  });

  it('separates a named non-tauri step, an unnamed tauri step, and a named tauri step', () => {
    const mixed = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Checkout',
      '        uses: actions/checkout@abc',
      '      - uses: tauri-apps/tauri-action@abc',
      '        env:',
      '          A_KEY: 1',
      '      - name: Build Tauri app (named)',
      '        uses: tauri-apps/tauri-action@abc',
      '        env:',
      '          B_KEY: 2',
      '',
    ].join('\n');
    const steps = extractTauriBuildSteps(mixed);
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0].envKeys, ['A_KEY']);
    assert.equal(steps[1].name, 'Build Tauri app (named)');
    assert.deepEqual(steps[1].envKeys, ['B_KEY']);
  });

  it('collects bracket and type-cast env access shapes (fail-closed collector)', () => {
    const errors = checkDesktopBuildEnv(
      fixtureRoot({
        spaSource: [
          "const a = import.meta.env['VITE_BRACKET_READ'];",
          'const b = (import.meta.env as Record<string, string>).VITE_CAST_READ;',
          '',
        ].join('\n'),
      }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_BRACKET_READ/);
    assert.match(errors[0], /VITE_CAST_READ/);
  });

  it('collects cast-around-import.meta and env aliases', () => {
    const root = fixtureRoot({
      spaSource: [
        "const a = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CAST_RECEIVER;",
        'const b = clientEnv.VITE_ALIAS_READ;',
        '',
      ].join('\n'),
    });
    writeFileSync(path.join(root, 'src/env.ts'), 'export const clientEnv = import.meta.env;\n');
    const errors = checkDesktopBuildEnv(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_ALIAS_READ/);
    assert.match(errors[0], /VITE_CAST_RECEIVER/);
  });

  it('scans shared/ when present', () => {
    const root = fixtureRoot({ spaSource: 'export {};\n' });
    mkdirSync(path.join(root, 'shared'), { recursive: true });
    writeFileSync(path.join(root, 'shared/util.ts'), 'export const x = import.meta.env.VITE_SHARED_ONLY;\n');
    const errors = checkDesktopBuildEnv(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_SHARED_ONLY/);
  });

  it('fails closed on a broken entry in shared/', () => {
    const root = fixtureRoot({ spaSource: 'export {};\n' });
    mkdirSync(path.join(root, 'shared'), { recursive: true });
    symlinkSync('missing.ts', path.join(root, 'shared/broken.ts'));
    assert.throws(() => checkDesktopBuildEnv(root), /ENOENT/);
  });

  it('rethrows non-directory shared/ scan errors', () => {
    const root = fixtureRoot({ spaSource: 'export {};\n' });
    writeFileSync(path.join(root, 'shared'), 'not a directory');
    assert.throws(() => checkDesktopBuildEnv(root), (error) => error.code === 'ENOTDIR');
  });

  it('discovers every workflow containing a Tauri action', () => {
    const root = fixtureRoot();
    writeFileSync(path.join(root, '.github/workflows/nightly.yaml'), buildWorkflow());
    assert.deepEqual(discoverDesktopBuildWorkflows(root).sort(), [...FIXTURE_WORKFLOWS, '.github/workflows/nightly.yaml'].sort());
    assert.deepEqual(checkDesktopBuildEnv(root), []);
  });

  it('keeps parsing env keys across comment lines inside the env block', () => {
    const withComment = buildWorkflow(
      `          ${REQUIRED_DESKTOP_BUILD_ENV[0]}: x\n          # comment (#5905)\n          ${REQUIRED_DESKTOP_BUILD_ENV[1]}: y`,
    );
    const steps = extractTauriBuildSteps(withComment);
    assert.deepEqual(steps[0].envKeys, [REQUIRED_DESKTOP_BUILD_ENV[0], REQUIRED_DESKTOP_BUILD_ENV[1]]);
  });

  it('passes a fixture where every build step declares every required key', () => {
    assert.deepEqual(checkDesktopBuildEnv(fixtureRoot()), []);
  });

  it('fails when a required key is removed from a build step (mutation)', () => {
    const mutated = buildWorkflow(ENV_LINES, { removeKeyFromStep: 1 });
    const errors = checkDesktopBuildEnv(fixtureRoot({ workflowSource: mutated }));
    assert.equal(errors.length, 2);
    assert.ok(errors.every((e) => e.includes('VITE_ENABLE_CYBER_LAYER')));
    assert.ok(errors.some((e) => e.includes('fixture-2')));
  });

  it('rejects an explicitly excluded key in a Tauri build step', () => {
    const workflow = buildWorkflow(`${ENV_LINES}\n          VITE_ENABLE_IRAN_ATTACKS: true`);
    const errors = checkDesktopBuildEnv(fixtureRoot({ workflowSource: workflow }));
    assert.equal(errors.length, 8);
    assert.ok(errors.every((e) => e.includes('VITE_ENABLE_IRAN_ATTACKS')));
  });

  it('fails when the SPA reads an unclassified VITE_ var (mutation)', () => {
    const errors = checkDesktopBuildEnv(
      fixtureRoot({ spaSource: 'const x = import.meta.env.VITE_TOTALLY_NEW_FLAG;\n' }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_TOTALLY_NEW_FLAG/);
    assert.match(errors[0], /REQUIRED_DESKTOP_BUILD_ENV or EXCLUDED_DESKTOP_BUILD_ENV/);
  });

  it('ignores VITE tokens in comments and string literals', () => {
    const errors = checkDesktopBuildEnv(
      fixtureRoot({
        spaSource: [
          "const message = 'import.meta.env.VITE_FALSE_STRING';",
          '// import.meta.env.VITE_FALSE_COMMENT',
          '',
        ].join('\n'),
      }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no VITE_ property reads found/);
    assert.doesNotMatch(errors[0], /VITE_FALSE_/);
  });

  it('fails loudly when a workflow has no tauri-action steps (vacuous-pass guard)', () => {
    const errors = checkDesktopBuildEnv(
      fixtureRoot({
        workflowSource: 'name: Fixture\njobs:\n  noop:\n    steps:\n      - name: Nothing\n        run: true\n',
        spaSource: 'export {};\n',
      }),
    );
    assert.equal(errors.length, 2);
    assert.match(errors[0], /no workflow files with tauri-apps\/tauri-action steps found/);
    assert.match(errors[1], /no VITE_ property reads found/);
  });

  it('fails closed when the SPA VITE scan is empty', () => {
    const errors = checkDesktopBuildEnv(fixtureRoot({ spaSource: 'export {};\n' }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no VITE_ property reads found/);
  });

  it('keeps folded env values from hiding later keys', () => {
    const workflow = buildWorkflow(
      [
        `          ${REQUIRED_DESKTOP_BUILD_ENV[0]}: >-`,
        '            full',
        `          ${REQUIRED_DESKTOP_BUILD_ENV[1]}: x`,
        ...REQUIRED_DESKTOP_BUILD_ENV.slice(2).map((key) => `          ${key}: x`),
      ].join('\n'),
    );
    const steps = extractTauriBuildSteps(workflow);
    assert.deepEqual(steps[0].envKeys, [...REQUIRED_DESKTOP_BUILD_ENV]);
  });

  it('keeps required and excluded sets disjoint', () => {
    const overlap = REQUIRED_DESKTOP_BUILD_ENV.filter((k) => k in EXCLUDED_DESKTOP_BUILD_ENV);
    assert.deepEqual(overlap, []);
  });

  it('exercises the CLI success and failure paths', () => {
    const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../scripts/check-desktop-build-env.mjs');
    const validRoot = fixtureRoot();
    const output = execFileSync(process.execPath, [script, '--root', validRoot], { encoding: 'utf8' });
    assert.match(output, /desktop build env OK/);

    const invalidRoot = fixtureRoot({ spaSource: 'export {};\n', workflowSource: 'name: Fixture\njobs: {}\n' });
    assert.throws(
      () => execFileSync(process.execPath, [script, '--root', invalidRoot], { encoding: 'utf8' }),
      (error) => error.status === 1 && /desktop build env/.test(error.stderr.toString()),
    );
  });

  it('holds against the real workflows and SPA source', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    assert.deepEqual(checkDesktopBuildEnv(repoRoot), []);
  });
});
