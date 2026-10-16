import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// build-desktop.yml publishes the release with GITHUB_TOKEN, and events that
// token creates never start other workflows. So docker-publish.yml's
// `release: published` trigger never fired for an automated release, and no
// release ever produced a versioned image or `latest`. The publisher has to
// dispatch the image build itself (workflow_dispatch is exempt from that rule).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loadWorkflow = (name) =>
  loadYaml(readFileSync(resolve(root, '.github/workflows', name), 'utf8'));

const desktop = loadWorkflow('build-desktop.yml');
const docker = loadWorkflow('docker-publish.yml');
const notesJob = desktop.jobs['update-release-notes'];
// `on:` is parsed as the boolean `true` by YAML 1.1, which js-yaml implements.
const dockerTriggers = docker.on ?? docker[true];

function theStepNamed(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `expected exactly one step named "${name}"`);
  return matches[0];
}

test('the release publisher dispatches the Docker image build for the published tag', () => {
  const publish = theStepNamed(notesJob.steps, 'Publish the release');
  const dispatch = theStepNamed(notesJob.steps, 'Publish the Docker image');

  assert.ok(publish.id, 'the publish step needs an id so later steps can read whether it published');
  assert.match(
    publish.run,
    /gh release edit "\$TAG" --draft=false\s*\n(?:.*\n)*?.*published=true.*>>\s*"\$GITHUB_OUTPUT"/,
    'published=true must be written only after the release actually goes live'
  );
  assert.ok(
    notesJob.steps.indexOf(dispatch) > notesJob.steps.indexOf(publish),
    'the image must be dispatched after the release is published'
  );
  assert.equal(
    dispatch.if,
    `steps.${publish.id}.outputs.published == 'true'`,
    'a draft-kept or refused release must not publish an image'
  );
  assert.match(dispatch.run, /gh workflow run docker-publish\.yml --ref "\$TAG"/);
  assert.match(publish.run, /echo "tag=\$TAG" >> "\$GITHUB_OUTPUT"/, 'the publish step must hand the tag on');
  assert.equal(dispatch.env?.TAG, `\${{ steps.${publish.id}.outputs.tag }}`, 'the dispatch must target the tag that was published');
  assert.equal(dispatch.env?.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}', 'gh workflow run needs a token');
  assert.equal(notesJob.permissions?.actions, 'write', 'gh workflow run needs actions: write');
});

test('docker-publish accepts the dispatch and tags latest for a release tag either way', () => {
  assert.ok(dockerTriggers.workflow_dispatch !== undefined, 'the dispatch target must accept workflow_dispatch');
  assert.ok(dockerTriggers.release, 'a release a person publishes by hand still triggers the build');

  const meta = docker.jobs.docker.steps.find((s) => String(s.uses ?? '').startsWith('docker/metadata-action'));
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
