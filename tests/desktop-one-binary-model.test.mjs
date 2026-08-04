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
//
// This file is a verification mechanism, so it is written to fail loudly rather
// than silently cover less than it claims: every lookup that could return
// `undefined` after a rename is asserted to have found something, and the
// release-publisher scan walks ALL workflows rather than trusting a filename.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (relPath) => readFileSync(resolve(root, relPath), 'utf8');

const pkg = JSON.parse(readRepoFile('package.json'));
const workflowsDir = resolve(root, '.github/workflows');
const workflowFiles = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));

const workflows = new Map(
  workflowFiles.map((f) => [f, loadYaml(readFileSync(resolve(workflowsDir, f), 'utf8'))])
);

const allJobSteps = (doc) =>
  Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? []);

/** Every Tauri build across every workflow — release legs and the canary alike. */
function tauriBuilders() {
  const builders = [];
  for (const [file, doc] of workflows) {
    for (const step of allJobSteps(doc)) {
      if (String(step?.uses ?? '').startsWith('tauri-apps/tauri-action')) {
        builders.push({ file, step });
      }
    }
  }
  return builders;
}

/**
 * Builds that actually cut a release. tauri-action publishes only when given a
 * `tagName`, so a build without one (the Linux canary) ships nothing.
 */
function releasePublishers() {
  return tauriBuilders().filter(({ step }) => step.with?.tagName);
}

const desktopWorkflow = workflows.get('build-desktop.yml');
// `on:` is parsed as the boolean `true` by YAML 1.1, which js-yaml implements.
const workflowTriggers = desktopWorkflow.on ?? desktopWorkflow[true];
const buildSteps = desktopWorkflow.jobs['build-tauri'].steps;

/** Find exactly one step by name, so a duplicate decoy cannot satisfy the lookup. */
function theStepNamed(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(
    matches.length,
    1,
    `expected exactly one step named "${name}" — 0 means this guard silently stopped checking anything, >1 means a decoy can satisfy it`
  );
  return matches[0];
}

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

test('only build-desktop.yml publishes a desktop release', () => {
  const publishers = releasePublishers();
  assert.ok(
    publishers.length > 0,
    'no tauri-action release publisher found in any workflow — this whole file would be checking nothing'
  );
  assert.deepEqual(
    [...new Set(publishers.map((p) => p.file))],
    ['build-desktop.yml'],
    'A second workflow publishing desktop releases reintroduces the multi-release-line model this gate exists to forbid.'
  );
  // A run-script release would sidestep the tauri-action scan entirely.
  for (const [file, doc] of workflows) {
    for (const step of allJobSteps(doc)) {
      assert.doesNotMatch(
        String(step?.run ?? ''),
        /gh release create/,
        `${file} :: ${step?.name ?? '(unnamed)'} creates a release outside the single publishing path`
      );
    }
  }
});

test('every release publisher targets the same single tag', () => {
  assert.deepEqual(
    [...new Set(releasePublishers().map((p) => p.step.with.tagName))],
    ['v__VERSION__'],
    'A second tag line cannot be served: /api/version and /api/download read /releases/latest, which resolves at most one release.'
  );
});

test('every Tauri build produces the full switching binary', () => {
  // Applies to ALL builds, not just publishers: tag uniqueness does not prove
  // the artifact is the switching binary, and the Linux canary must exercise
  // the shipped configuration rather than a drifted per-variant one.
  const builders = tauriBuilders();
  assert.ok(builders.length > 0, 'no tauri-action build found — this guard would be vacuous');
  for (const { file, step } of builders) {
    const where = `${file} :: ${step.name}`;
    assert.equal(step.env?.VITE_VARIANT, 'full', `${where} must build the full switching binary`);
    assert.doesNotMatch(
      String(step.with?.args ?? ''),
      /--config/,
      `${where} must not pass a per-variant Tauri config`
    );
  }
});

test('release publishing is atomic — legs upload to a draft, one step publishes', () => {
  for (const { file, step } of releasePublishers()) {
    assert.equal(
      step.with?.releaseDraft,
      true,
      `${file} :: ${step.name} must upload into a draft — with fail-fast:false, a non-draft leg makes the release "latest" before the other platforms finish, offering an update whose asset is missing`
    );
  }
  const publish = theStepNamed(desktopWorkflow.jobs['update-release-notes'].steps, 'Publish the release');
  assert.match(publish.run, /gh release edit "\$TAG" --draft=false/);
  assert.match(publish.run, /KEEP_DRAFT/, 'the draft input must still be honorable');
  assert.match(publish.run, /Refusing to publish/, 'publishing must verify every platform asset exists first');

  // A rebuild of an already-published tag would upload into the live release.
  const rebuildGuard = theStepNamed(buildSteps, 'Refuse to rebuild an already-published release (#5908)');
  assert.match(rebuildGuard.run, /isDraft/);
  assert.match(rebuildGuard.run, /exit 1/);

  // A dispatch can run from any ref while the tag comes from package.json.
  assert.match(publish.run, /PUBLISHABLE_REF/, 'auto-publish must be limited to a release tag or the default branch');
});

test('the publish gate requires exactly the platforms /api/download can serve', () => {
  // The workflow comment claims it "mirrors PLATFORM_PATTERNS". Nothing enforced
  // that, so dropping a suffix from the bash loop would let a release publish
  // without an artifact for a platform the endpoint and README advertise — and
  // the gate asserting only the error string would have stayed green.
  const publish = theStepNamed(desktopWorkflow.jobs['update-release-notes'].steps, 'Publish the release');

  const handler = readRepoFile('api/download.js');
  const endpointSuffixes = [...handler.matchAll(/endsWith\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.ok(endpointSuffixes.length > 0, 'no PLATFORM_PATTERNS suffixes parsed — this guard would be vacuous');

  const loop = publish.run.match(/for suffix in ([^\n]+); do/);
  assert.ok(loop, "publish step must iterate an explicit suffix list");
  const gateSuffixes = [...loop[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1].replace(/\\/g, '').replace(/\$$/, ''))
    .sort();

  assert.deepEqual(
    gateSuffixes,
    endpointSuffixes,
    'the publish completeness gate and /api/download must advertise the same platform set — a suffix in one and not the other means a release can go live that the endpoint cannot serve, or a build blocked on an artifact nobody asks for'
  );
});

test('the publish gate applies the same identity filter the endpoint does', () => {
  // Checking the platform suffix alone would let a stray branded artifact
  // satisfy the gate for a platform /api/download would then refuse to serve.
  const publish = theStepNamed(desktopWorkflow.jobs['update-release-notes'].steps, 'Publish the release');
  assert.match(publish.run, /worldmonitor/, 'publish must require the World Monitor identity, not just a platform suffix');
  assert.match(publish.run, /SERVABLE/);
  assert.doesNotMatch(
    publish.run,
    /printf '%s\\n' "\$ASSETS" \| grep -qE "\$suffix"/,
    'the suffix check must run against identity-filtered assets, not the raw asset list'
  );
});

test('the AppImage re-upload targets the same tag the build steps publish', () => {
  // These two halves of the workflow disagreed: the build legs tagged
  // `v__VERSION__-tech` while the re-upload computed `v${VERSION}` from a
  // BUILD_VARIANT branch ~90 lines apart.
  const appImageStep = theStepNamed(buildSteps, 'Strip GPU libraries from AppImage');
  assert.match(appImageStep.run, /TAG_NAME="v\$\{VERSION\}"/);
  assert.doesNotMatch(appImageStep.run, /BUILD_VARIANT|-tech/);
});

test('the release-notes job edits that same single tag', () => {
  const notesStep = theStepNamed(
    desktopWorkflow.jobs['update-release-notes'].steps,
    'Generate and update release notes'
  );
  assert.match(notesStep.run, /TAG="v\$\{VERSION\}"/);
  assert.doesNotMatch(notesStep.run, /BUILD_VARIANT|-tech/);
});

test('a pushed tag must match the version actually being built', () => {
  // tagName comes from package.json, not the pushed ref, while the trigger
  // matches any `v*` — so a stray tag would overwrite the live release.
  assert.deepEqual(workflowTriggers.push.tags, ['v*']);
  const guard = theStepNamed(buildSteps, 'Pushed tag matches the version being built (#5908)');
  assert.equal(guard.if, "github.event_name == 'push'");
  assert.match(guard.run, /GITHUB_REF_NAME/);
  assert.match(guard.run, /exit 1/);
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

test('exactly one Tauri bundle config exists, anywhere under src-tauri', () => {
  const confs = readdirSync(resolve(root, 'src-tauri'), { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((f) => !f.startsWith('target/') && /(^|\/)tauri.*\.conf\.json$/.test(f));
  assert.deepEqual(
    confs,
    ['tauri.conf.json'],
    'A per-variant Tauri config is a binary nothing publishes — exactly the orphaned state #5908 removed. The scan is recursive so a nested config cannot hide.'
  );
});

test('no npm script builds or packages a per-variant desktop binary', () => {
  const offenders = Object.entries(pkg.scripts)
    .filter(([name, body]) => {
      if (!name.startsWith('desktop:')) return false;
      // Any variant other than full, any variant flag, any alternate config —
      // matched by shape rather than by the tech/finance names that happened to
      // exist when this was written.
      const variantEnv = body.match(/VITE_VARIANT=(\w+)/);
      return (
        (variantEnv && variantEnv[1] !== 'full')
        || /--variant/.test(body)
        || /--config\s+src-tauri\//.test(body)
      );
    })
    .map(([name]) => name);
  assert.deepEqual(offenders, [], 'desktop packaging is variant-agnostic under the one-binary model');
});

test('the desktop updater does not request a per-variant download asset', () => {
  const updater = readRepoFile('src/app/desktop-updater.ts');
  assert.match(
    updater,
    /api\/download\?platform=\$\{platform\}`/,
    'the download URL must be exactly the platform query'
  );
  assert.doesNotMatch(
    updater,
    /[?&]variant=/,
    'Asking /api/download for a per-variant asset can only ever 302 to the releases page.'
  );
  // A query built via URLSearchParams would carry no literal `variant=`, so the
  // regex above would miss it.
  assert.doesNotMatch(updater, /URLSearchParams|searchParams\.(set|append)/);
});

test('/api/download applies the binary-identity filter on every path', () => {
  // The updater sends no variant, so a variant-gated filter would leave the
  // app's own download unfiltered.
  const handler = readRepoFile('api/download.js');
  assert.match(handler, /const asset = findDesktopAsset\(assets, matcher\);/);
  assert.doesNotMatch(
    handler,
    /variant\s*\?\s*findDesktopAsset/,
    'the identity filter must not be conditional on variant'
  );
});
