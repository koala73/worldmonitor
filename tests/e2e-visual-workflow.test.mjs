import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const visualWorkflowSource = read('.github/workflows/e2e-visual.yml');
const publishWorkflowSource = read('.github/workflows/publish-e2e-screenshots.yml');
const deployGateSource = read('.github/workflows/deploy-gate.yml');
const packageJson = JSON.parse(read('package.json'));
const visual = YAML.parse(visualWorkflowSource);
const publish = YAML.parse(publishWorkflowSource);

const GATED_WORKFLOW_NAMES = new Set(['Test', 'Typecheck', 'Lint Code', 'Security Audit']);

function jobSteps(job) {
  return job.steps ?? [];
}

function stepUses(step) {
  return typeof step.uses === 'string' ? step.uses : '';
}

describe('E2E visual workflow contract', () => {
  it('is a standalone workflow so deploy-gate cannot make pixels a merge check', () => {
    assert.equal(visual.name, 'E2E Visual');
    assert.ok(!GATED_WORKFLOW_NAMES.has(visual.name));
    assert.equal(publish.name, 'Publish E2E Screenshots');
    assert.ok(!GATED_WORKFLOW_NAMES.has(publish.name));

    const required = deployGateSource.match(/required='(\[[^\n]+])'/);
    assert.ok(required, 'deploy-gate.yml must still declare required checks');
    const requiredChecks = JSON.parse(required[1]);
    for (const jobId of Object.keys(visual.jobs)) {
      assert.ok(
        !requiredChecks.includes(jobId),
        `deploy-gate must not require ${jobId} — visual evidence is not a merge gate`,
      );
    }
  });

  it('defines the chrome and visual npm scripts and actually invokes them', () => {
    assert.equal(typeof packageJson.scripts['test:e2e:visual'], 'string');
    assert.equal(typeof packageJson.scripts['test:e2e:chrome'], 'string');
    assert.match(packageJson.scripts['test:e2e:chrome'], /e2e\/visual-chrome\.spec\.ts/);
    assert.match(visualWorkflowSource, /npm run test:e2e:chrome/);
    assert.match(visualWorkflowSource, /npm run test:e2e:visual:full/);
    assert.match(visualWorkflowSource, /npm run test:e2e:visual:tech/);
  });

  it('path-filters pull requests so unrelated PRs do not boot Playwright', () => {
    const paths = visual.on?.pull_request?.paths ?? [];
    for (const required of [
      'e2e/map-harness.spec.ts',
      'e2e/map-harness.spec.ts-snapshots/**',
      'e2e/visual-chrome.spec.ts',
      'src/e2e/map-harness.ts',
      '.github/workflows/e2e-visual.yml',
    ]) {
      assert.ok(paths.includes(required), `pull_request.paths must include ${required}`);
    }
  });

  it('keeps goldens off the main-push hot path and on nightly / map PRs', () => {
    const goldens = visual.jobs['visual-goldens'];
    assert.ok(goldens, 'visual-goldens job must exist');
    assert.match(
      String(goldens.if),
      /github\.event_name != 'push'/,
      'visual-goldens must skip ordinary main pushes',
    );
    assert.ok(visual.on.schedule, 'nightly schedule must exist');
    assert.ok(visual.on.workflow_dispatch, 'manual dispatch must exist');
  });

  it('uploads each Playwright run immediately with the #6496 artifact contract', () => {
    for (const [jobId, job] of Object.entries(visual.jobs)) {
      const playwrightRuns = jobSteps(job).filter((step) =>
        /npm run test:e2e:/.test(String(step.run ?? '')),
      );
      assert.ok(playwrightRuns.length > 0, `${jobId} must invoke playwright`);

      const uploads = jobSteps(job).filter((step) => stepUses(step).startsWith('actions/upload-artifact@'));
      assert.ok(uploads.length >= playwrightRuns.length, `${jobId} must upload after each playwright run`);

      for (const upload of uploads) {
        assert.match(String(upload.if), /!cancelled\(\)|always\(\)/);
        assert.match(String(upload.with.name), /github\.run_attempt/);
        const path = upload.with.path;
        const flattened = Array.isArray(path)
          ? path
          : String(path)
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
        assert.ok(
          flattened.some((entry) => entry === 'test-results' || entry === 'test-results/' || entry === 'gallery/'),
          `${jobId} upload must include test-results or gallery, got ${JSON.stringify(path)}`,
        );
        assert.match(stepUses(upload), /@[0-9a-f]{40}$/i);
      }
    }
  });

  it('publishes to object storage only when the screenshot bucket is configured', () => {
    assert.deepEqual(publish.on.workflow_run.workflows, ['E2E Visual']);
    const job = publish.jobs.publish;
    assert.match(String(job.if), /head_branch == 'main'/);
    assert.match(String(job.if), /event != 'pull_request'/);
    assert.match(String(job.if), /conclusion != 'cancelled'/);
    const sync = jobSteps(job).find((step) => step.id === 'sync' || /aws s3 sync/.test(String(step.run ?? '')));
    assert.ok(sync, 'publish job must define an S3 sync step');
    // secrets.* is forbidden in step `if:` — gate on the public bucket var only.
    assert.match(String(sync.if), /E2E_SCREENSHOT_BUCKET/);
    assert.doesNotMatch(String(sync.if), /secrets\./);
    for (const step of jobSteps(job)) {
      assert.doesNotMatch(
        String(step.if ?? ''),
        /secrets\./,
        'publish steps must not reference secrets in if: (GitHub context restriction)',
      );
    }
    assert.match(String(sync.run), /E2E_SCREENSHOT_S3_ACCESS_KEY_ID is unset/);
    assert.match(String(sync.run), /E2E_SCREENSHOT_ENDPOINT is unset/);
    assert.match(String(sync.run), /exit 1/);
    assert.match(String(sync.run), /no PNG captures/);
    assert.match(String(sync.run), /--merge-history/);
    assert.match(String(sync.run), /chrome-gallery succeeded but the gallery artifact is missing/);
  });

  it('apt-groups visual scene enables cyberThreats so the lazy layer can mount', () => {
    const harness = read('src/e2e/map-harness.ts');
    const scene = harness.match(/id: 'apt-groups-z5',[\s\S]*?enabledLayers: \[([^\]]*)\]/);
    assert.ok(scene, 'apt-groups-z5 scenario must exist');
    assert.match(
      scene[1],
      /cyberThreats/,
      'apt-groups-layer is only created when cyberThreats is on',
    );
  });

  it('commits a full/tech/finance golden for every visual scenario the e2e suite will run', () => {
    const harness = read('src/e2e/map-harness.ts');
    const snapDir = resolve(root, 'e2e/map-harness.spec.ts-snapshots');
    const skipped = new Set(['commodity', 'happy']);
    const scenes = [...harness.matchAll(/id: '([^']+)',\s*variant: '([^']+)'/g)];
    assert.ok(scenes.length > 0, 'expected visual scenarios in the harness');
    const missing = [];
    for (const [, id, variant] of scenes) {
      if (skipped.has(variant)) continue;
      const screenshotVariants =
        variant === 'both' ? ['full', 'tech'] : variant === 'energy' ? ['full'] : [variant];
      for (const screenshotVariant of screenshotVariants) {
        const name = `layer-${screenshotVariant}-${id}.png`;
        if (!existsSync(resolve(snapDir, name))) missing.push(name);
      }
    }
    assert.deepEqual(missing, [], `missing committed goldens: ${missing.join(', ')}`);
  });
});
