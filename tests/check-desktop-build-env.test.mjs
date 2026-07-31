import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DESKTOP_BUILD_WORKFLOWS,
  EXCLUDED_DESKTOP_BUILD_ENV,
  REQUIRED_DESKTOP_BUILD_ENV,
  checkDesktopBuildEnv,
  extractTauriBuildSteps,
} from '../scripts/check-desktop-build-env.mjs';

const ENV_LINES = REQUIRED_DESKTOP_BUILD_ENV.map((k) => `          ${k}: x`).join('\n');

function buildWorkflow(envLines = ENV_LINES) {
  return [
    'name: Fixture',
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@abc',
    '      - name: Build Tauri app (fixture)',
    '        uses: tauri-apps/tauri-action@abc',
    '        env:',
    envLines,
    '        with:',
    '          args: ""',
    '',
  ].join('\n');
}

function makeFixtureRoot({ workflowSource, spaSource } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop-env-fixture-'));
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const wf of DESKTOP_BUILD_WORKFLOWS) {
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
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'Build Tauri app (fixture)');
    assert.deepEqual(steps[0].envKeys, [...REQUIRED_DESKTOP_BUILD_ENV]);
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

  it('scans shared/ when present', () => {
    const root = fixtureRoot({ spaSource: 'export {};\n' });
    mkdirSync(path.join(root, 'shared'), { recursive: true });
    writeFileSync(path.join(root, 'shared/util.ts'), 'export const x = import.meta.env.VITE_SHARED_ONLY;\n');
    const errors = checkDesktopBuildEnv(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_SHARED_ONLY/);
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
    const mutated = buildWorkflow(
      REQUIRED_DESKTOP_BUILD_ENV.filter((k) => k !== 'VITE_ENABLE_CYBER_LAYER')
        .map((k) => `          ${k}: x`)
        .join('\n'),
    );
    const errors = checkDesktopBuildEnv(fixtureRoot({ workflowSource: mutated }));
    assert.ok(errors.length >= 1);
    assert.ok(
      errors.every((e) => e.includes('VITE_ENABLE_CYBER_LAYER')),
      `every error should name the missing key, got: ${errors.join(' | ')}`,
    );
  });

  it('fails when the SPA reads an unclassified VITE_ var (mutation)', () => {
    const errors = checkDesktopBuildEnv(
      fixtureRoot({ spaSource: 'const x = import.meta.env.VITE_TOTALLY_NEW_FLAG;\n' }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_TOTALLY_NEW_FLAG/);
    assert.match(errors[0], /REQUIRED_DESKTOP_BUILD_ENV or EXCLUDED_DESKTOP_BUILD_ENV/);
  });

  it('fails loudly when a workflow has no tauri-action steps (vacuous-pass guard)', () => {
    const errors = checkDesktopBuildEnv(
      fixtureRoot({ workflowSource: 'name: Fixture\njobs:\n  noop:\n    steps:\n      - name: Nothing\n        run: true\n' }),
    );
    assert.equal(errors.length, DESKTOP_BUILD_WORKFLOWS.length);
    for (const e of errors) assert.match(e, /no tauri-apps\/tauri-action steps found/);
  });

  it('keeps required and excluded sets disjoint', () => {
    const overlap = REQUIRED_DESKTOP_BUILD_ENV.filter((k) => k in EXCLUDED_DESKTOP_BUILD_ENV);
    assert.deepEqual(overlap, []);
  });

  it('holds against the real workflows and SPA source', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    assert.deepEqual(checkDesktopBuildEnv(repoRoot), []);
  });
});
