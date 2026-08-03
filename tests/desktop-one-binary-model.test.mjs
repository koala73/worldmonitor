import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { SUPPORTED_VARIANTS } from '../api/download.js';
import { SITE_VARIANTS } from '../src/config/variant.ts';

// #5908 was not one bug — it was five surfaces disagreeing about whether the
// desktop app ships one binary or one binary per variant. The endpoints, the
// workflow, the packager, the switcher, and the docs each encoded a different
// answer, and nothing failed when they drifted. These assertions are the
// agreement itself: the model is "one published binary, variants switch
// in-app", and every surface has to keep saying so.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (relPath) => readFileSync(resolve(root, relPath), 'utf8');

const pkg = JSON.parse(readRepoFile('package.json'));
const desktopWorkflow = loadYaml(readRepoFile('.github/workflows/build-desktop.yml'));
// `on:` is parsed as the boolean `true` by YAML 1.1, which js-yaml implements.
const workflowTriggers = desktopWorkflow.on ?? desktopWorkflow[true];
const buildSteps = desktopWorkflow.jobs['build-tauri'].steps;

test('/api/download accepts exactly the variants the in-app switcher offers', () => {
  // `world` is a legacy alias for `full` kept for existing download links; it is
  // deliberately not a switcher target.
  const expected = new Set([...SITE_VARIANTS, 'world']);
  assert.deepEqual(
    [...SUPPORTED_VARIANTS].sort(),
    [...expected].sort(),
    'A variant the switcher offers but /api/download rejects gives that user a 302 to the releases page instead of a download; the reverse advertises a variant the product does not have.'
  );
});

test('the desktop workflow publishes exactly one release line', () => {
  const publishedTags = buildSteps
    .filter((step) => step.with?.tagName)
    .map((step) => step.with.tagName);

  assert.ok(publishedTags.length > 0, 'no build step publishes a release — the tagName assertion would be vacuous');
  assert.deepEqual(
    [...new Set(publishedTags)],
    ['v__VERSION__'],
    'A second tag line cannot be served: /api/version and /api/download read /releases/latest, which resolves at most one release.'
  );
});

test('the AppImage re-upload targets the same tag the build steps publish', () => {
  // These two halves of the workflow disagreed: the build legs tagged
  // `v__VERSION__-tech` while the re-upload computed `v${VERSION}` from a
  // BUILD_VARIANT branch ~90 lines apart.
  const appImageStep = buildSteps.find((step) => step.name === 'Strip GPU libraries from AppImage');
  assert.ok(appImageStep, 'AppImage post-processing step not found — this guard would silently pass');
  assert.match(appImageStep.run, /TAG_NAME="v\$\{VERSION\}"/);
  assert.doesNotMatch(appImageStep.run, /BUILD_VARIANT|-tech/);
});

test('the release-notes job edits that same single tag', () => {
  const notesStep = desktopWorkflow.jobs['update-release-notes'].steps.find((step) =>
    (step.run ?? '').includes('gh release edit')
  );
  assert.ok(notesStep, 'release-notes step not found — this guard would silently pass');
  assert.match(notesStep.run, /TAG="v\$\{VERSION\}"/);
  assert.doesNotMatch(notesStep.run, /BUILD_VARIANT|-tech/);
});

test('the desktop workflow exposes no per-variant build selector', () => {
  assert.deepEqual(
    Object.keys(workflowTriggers.workflow_dispatch.inputs),
    ['draft'],
    'A variant input implies per-variant binaries; a tag push would still build full regardless (the v* trigger matches v*-tech).'
  );
});

test('a manually dispatched build defaults to a served release', () => {
  assert.equal(
    workflowTriggers.workflow_dispatch.inputs.draft.default,
    false,
    'A draft release is invisible to /releases/latest, so the build looks shipped while /api/version and /api/download still serve the previous one.'
  );
});

test('exactly one Tauri bundle config exists', () => {
  const confs = readdirSync(resolve(root, 'src-tauri')).filter((f) => /^tauri.*\.conf\.json$/.test(f));
  assert.deepEqual(
    confs,
    ['tauri.conf.json'],
    'A per-variant Tauri config is a binary nothing publishes — exactly the orphaned state #5908 removed.'
  );
});

test('no npm script builds or packages a per-variant desktop binary', () => {
  const offenders = Object.entries(pkg.scripts)
    .filter(([name, body]) =>
      name.startsWith('desktop:')
      && (/tauri\.(tech|finance)\.conf\.json/.test(body) || /--variant/.test(body))
    )
    .map(([name]) => name);
  assert.deepEqual(offenders, [], 'desktop packaging is variant-agnostic under the one-binary model');
});

test('the desktop updater does not request a per-variant download asset', () => {
  const updater = readRepoFile('src/app/desktop-updater.ts');
  assert.doesNotMatch(
    updater,
    /variant=/,
    'Asking /api/download for a per-variant asset can only ever 302 to the releases page.'
  );
  assert.match(updater, /api\/download\?platform=\$\{platform\}/);
});
