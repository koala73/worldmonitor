import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// docker-compose.yml pulls three images that docker-publish.yml does not build.
// docker-publish-self-hosted.yml builds them, and like docker-publish.yml it
// never fires from a release build-desktop.yml publishes with GITHUB_TOKEN
// (that token raises no `release` event), so the publisher must dispatch it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(resolve(root, path), 'utf8');
const loadWorkflow = (name) => loadYaml(readText(`.github/workflows/${name}`));

const desktop = loadWorkflow('build-desktop.yml');
const selfHosted = loadWorkflow('docker-publish-self-hosted.yml');
const compose = loadYaml(readText('docker-compose.yml'));
const notesJob = desktop.jobs['update-release-notes'];
// `on:` is parsed as the boolean `true` by YAML 1.1, which js-yaml implements.
const selfHostedTriggers = selfHosted.on ?? selfHosted[true];

function theStepNamed(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `expected exactly one step named "${name}"`);
  return matches[0];
}

test('the release publisher dispatches the self-hosted image build for the published tag', () => {
  const publish = theStepNamed(notesJob.steps, 'Publish the release');
  const dispatch = theStepNamed(notesJob.steps, 'Publish the self-hosted Docker images');

  assert.ok(
    notesJob.steps.indexOf(dispatch) > notesJob.steps.indexOf(publish),
    'the images must be dispatched after the release is published'
  );
  assert.equal(
    dispatch.if,
    `\${{ !cancelled() && steps.${publish.id}.outputs.published == 'true' }}`,
    'a draft-kept or refused release must not publish images, and a failed frontend-image dispatch must not skip this one'
  );
  assert.match(dispatch.run, /gh workflow run docker-publish-self-hosted\.yml --ref "\$TAG"/);
  assert.equal(dispatch.env?.TAG, `\${{ steps.${publish.id}.outputs.tag }}`, 'the dispatch must target the tag that was published');
  assert.equal(dispatch.env?.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}', 'gh workflow run needs a token');
  assert.equal(notesJob.permissions?.actions, 'write', 'gh workflow run needs actions: write');
});

test('the self-hosted workflow accepts the dispatch and tags latest for a release tag either way', () => {
  assert.ok(selfHostedTriggers.workflow_dispatch !== undefined, 'the dispatch target must accept workflow_dispatch');
  assert.ok(selfHostedTriggers.release, 'a release a person publishes by hand still triggers the build');

  const meta = selfHosted.jobs.docker.steps.find((s) => String(s.uses ?? '').startsWith('docker/metadata-action'));
  assert.ok(meta, 'metadata-action step not found');
  const tagRules = meta.with.tags.split('\n').map((line) => line.trim()).filter(Boolean);
  // A `#` line inside the block scalar is not a YAML comment; metadata-action
  // would read it as a tag rule.
  assert.deepEqual(tagRules.filter((line) => !line.startsWith('type=')), [], 'every tags line must be a type= rule');
  const latest = tagRules.find((line) => line.includes('value=latest'));
  assert.ok(latest, 'no latest tag rule');
  assert.doesNotMatch(
    latest,
    /event_name == 'release'/,
    'gating latest on the release event leaves the dispatched release build without latest'
  );
  assert.match(latest, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(latest, /!contains\(github\.ref, '-'\)/, 'a pre-release tag must not move latest');
});

test('main-side runs move `main` and never `latest`, so a clone pulls images from its own tree', () => {
  const meta = selfHosted.jobs.docker.steps.find((s) => String(s.uses ?? '').startsWith('docker/metadata-action'));
  const rules = meta.with.tags.split('\n').map((line) => line.trim()).filter(Boolean);
  const main = rules.find((line) => line.includes('value=main'));
  assert.ok(main, 'no main tag rule');
  assert.match(main, /github\.ref == 'refs\/heads\/main'/);
  assert.equal(meta.with.flavor, 'latest=false', 'latest must be decided by the explicit rule alone');
  assert.ok(rules.some((line) => line.startsWith('type=sha')), 'every run publishes sha-<commit>');

  for (const [service, def] of Object.entries(compose.services)) {
    if (!def.build) continue;
    assert.match(def.image, /:\$\{WM_IMAGE_TAG:-main\}$/, `${service}: compose must default to the main tag`);
  }
});

test('the workflow keeps docker-publish.yml\'s safeguards for unattended publishes', () => {
  const t = selfHostedTriggers;
  assert.ok(t.schedule?.length, 'a daily rebuild backstops what the push filter misses');
  assert.ok(t.push?.paths?.includes('Dockerfile') && t.push.paths.includes('Dockerfile.relay') && t.push.paths.includes('docker/**'));
  const job = selfHosted.jobs.docker;
  assert.equal(typeof job['timeout-minutes'], 'number', 'a QEMU hang must not hold the slot for six hours');
  assert.equal(job.strategy['fail-fast'], false, 'one broken image must not block the other two');
  assert.match(job.if, /github\.event_name != 'schedule' \|\| github\.repository == 'koala73\/worldmonitor'/, 'forks must not run the cron');
  assert.equal(selfHosted.concurrency['cancel-in-progress'], false);

  const smoke = job.steps.find((s) => s.name?.startsWith('Smoke the app image'));
  assert.ok(smoke, 'the app image must be run before it is pushed');
  assert.equal(smoke.if, 'matrix.smoke');
  const smokeBuild = job.steps.find((s) => s.name?.startsWith('Build the amd64 image'));
  assert.ok(job.steps.indexOf(smokeBuild) < job.steps.indexOf(smoke));
  assert.ok(job.steps.indexOf(smoke) < job.steps.findIndex((s) => s.with?.push === true), 'smoke must precede the push');
  assert.equal(job.strategy.matrix.include.filter((l) => l.smoke).map((l) => l.image).join(), 'worldmonitor-selfhosted');

  const report = selfHosted.jobs['report-failure'];
  assert.equal(report.needs, 'docker');
  assert.equal(report.permissions?.issues, 'write');
});

test('the root Dockerfile builds its frontend on the build host, not under QEMU', () => {
  assert.match(readText('Dockerfile'), /^FROM --platform=\$BUILDPLATFORM node:\S+ AS builder$/m);
});

test('the build matrix covers every compose service with the context its Dockerfile needs', () => {
  const legs = selfHosted.jobs.docker.strategy.matrix.include;

  for (const [service, def] of Object.entries(compose.services)) {
    if (!def.build) continue;
    const [, name] = /^ghcr\.io\/koala73\/([\w-]+):/.exec(def.image) ?? [];
    assert.ok(name, `${service}: image must point at ghcr.io/koala73/<name>`);

    const leg = legs.find((l) => l.image === name);
    assert.ok(leg, `${service}: no matrix leg publishes ${name}`);
    // build-push-action's `file` is relative to the repo root; compose's
    // `dockerfile` is relative to its build context.
    assert.equal(resolve(root, leg.context), resolve(root, def.build.context), `${service}: wrong build context`);
    assert.equal(
      resolve(root, leg.dockerfile),
      resolve(root, def.build.context, def.build.dockerfile),
      `${service}: the matrix must build the Dockerfile docker-compose.yml builds`
    );
  }
});
