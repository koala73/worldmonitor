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
    `steps.${publish.id}.outputs.published == 'true'`,
    'a draft-kept or refused release must not publish images'
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
