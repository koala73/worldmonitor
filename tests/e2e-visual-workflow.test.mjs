import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const visualWorkflowSource = read('.github/workflows/e2e-visual.yml');
const publishWorkflowSource = read('.github/workflows/publish-e2e-screenshots.yml');
const deployGateScript = read('.github/scripts/deploy-gate.sh');
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

    const required = deployGateScript.match(/required='(\[[^\n]+])'/);
    assert.ok(required, 'deploy-gate.sh must still declare required checks');
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

  it('runs on map PRs, nightly and manual dispatch, never on main pushes', () => {
    assert.ok(visual.jobs['visual-goldens'], 'visual-goldens job must exist');
    assert.ok(visual.jobs['chrome-gallery'], 'chrome-gallery job must exist');
    assert.equal('push' in visual.on, false, 'main gets the nightly run, not one per merge');
    assert.ok(visual.on.pull_request?.paths?.length, 'PR runs must stay path-filtered');
    assert.deepEqual(visual.on.schedule.map((entry) => entry.cron), ['17 3 * * *']);
    assert.ok(visual.on.workflow_dispatch, 'manual dispatch must exist');
  });

  it('uploads each Playwright run immediately with the #6496 artifact contract', () => {
    const allRawArtifactNames = [];
    for (const [jobId, job] of Object.entries(visual.jobs)) {
      const steps = jobSteps(job);
      const playwrightRuns = steps
        .map((step, index) => ({ index, step }))
        .filter(({ step }) => /npm run test:e2e:/.test(String(step.run ?? '')));
      assert.ok(playwrightRuns.length > 0, `${jobId} must invoke playwright`);

      const uploads = steps.filter((step) => stepUses(step).startsWith('actions/upload-artifact@'));
      assert.ok(uploads.length >= playwrightRuns.length, `${jobId} must upload after each playwright run`);

      const rawArtifactNames = [];
      for (const [runOffset, playwrightRun] of playwrightRuns.entries()) {
        const nextRunIndex = playwrightRuns[runOffset + 1]?.index ?? steps.length;
        const upload = steps.slice(playwrightRun.index + 1, nextRunIndex).find((step) => {
          if (!stepUses(step).startsWith('actions/upload-artifact@')) return false;
          const uploadPath = Array.isArray(step.with?.path)
            ? step.with.path
            : String(step.with?.path ?? '').split('\n');
          return uploadPath.some((entry) => /^test-results\/?$/.test(String(entry).trim()));
        });
        assert.ok(upload, `${jobId} must upload raw test-results after Playwright run ${runOffset + 1}`);
        assert.match(String(upload.if), /!cancelled\(\)|always\(\)/);
        assert.match(String(upload.with.name), /github\.run_attempt/);
        assert.doesNotMatch(String(upload.with.name), /gallery/i, 'gallery upload is not raw test-results evidence');
        rawArtifactNames.push(String(upload.with.name));
        allRawArtifactNames.push(String(upload.with.name));

        const path = upload.with.path;
        const flattened = Array.isArray(path)
          ? path
          : String(path)
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
        assert.ok(
          flattened.some((entry) => entry === 'test-results' || entry === 'test-results/'),
          `${jobId} raw upload must include test-results, got ${JSON.stringify(path)}`,
        );
        assert.match(stepUses(upload), /@[0-9a-f]{40}$/i);
      }
      assert.equal(
        new Set(rawArtifactNames).size,
        rawArtifactNames.length,
        `${jobId} raw Playwright uploads must have distinct names`,
      );
    }
    assert.equal(
      new Set(allRawArtifactNames).size,
      allRawArtifactNames.length,
      'raw Playwright uploads must have distinct names across the workflow',
    );
  });

  it('publishes to object storage only when the screenshot bucket is configured', () => {
    assert.deepEqual(publish.on.workflow_run.workflows, ['E2E Visual']);
    const job = publish.jobs.publish;
    assert.match(String(job.if), /head_branch == 'main'/);
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
    for (const [name, field] of Object.entries({
      PLAYWRIGHT_RUN_ID: 'id', PLAYWRIGHT_RUN_ATTEMPT: 'run_attempt', PLAYWRIGHT_RUN_NUMBER: 'run_number',
      PLAYWRIGHT_RUN_URL: 'html_url', PLAYWRIGHT_SHA: 'head_sha', PLAYWRIGHT_EVENT: 'event', PLAYWRIGHT_BRANCH: 'head_branch',
    })) {
      assert.equal(sync.env[name], '${{ github.event.workflow_run.' + field + ' }}');
    }
  });

  it('accepts only canonical main runs from the expected workflow and event allowlist', () => {
    const trusted = {
      head_repository: { full_name: 'koala73/worldmonitor' },
      head_branch: 'main',
      path: '.github/workflows/e2e-visual.yml',
      event: 'schedule',
      conclusion: 'success',
    };
    const cases = [
      ...['schedule', 'workflow_dispatch'].map((event) => ({ event, allowed: true })),
      { conclusion: 'failure', allowed: true },
      { head_repository: { full_name: 'attacker/worldmonitor' }, allowed: false },
      { head_repository: {}, allowed: false },
      { head_branch: 'feature', allowed: false },
      { path: '.github/workflows/attacker.yml', allowed: false },
      ...['push', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'repository_dispatch', ''].map(
        (event) => ({ event, allowed: false }),
      ),
      { conclusion: 'cancelled', allowed: false },
    ];
    for (const { allowed, ...overrides } of cases) {
      const run = { ...trusted, ...overrides };
      const actual = runInNewContext(String(publish.jobs.publish.if), {
        github: { repository: 'koala73/worldmonitor', event: { workflow_run: run } },
        contains: (values, value) => values.includes(value),
        fromJSON: JSON.parse,
      }, { timeout: 1000 });
      assert.equal(actual, allowed, JSON.stringify(overrides));
    }
  });

  it('rebuilds the upload from PNGs and trusted metadata without artifact HTML or history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wm-gallery-publish-'));
    try {
      mkdirSync(join(directory, 'bin'));
      mkdirSync(join(directory, 'gallery/screenshots/images'), { recursive: true });
      mkdirSync(join(directory, 'scripts'));
      writeFileSync(join(directory, 'scripts/playwright-screenshot-gallery.mjs'), read('scripts/playwright-screenshot-gallery.mjs'));
      writeFileSync(join(directory, 'gallery/index.html'), '<script>artifact-payload</script>');
      writeFileSync(join(directory, 'gallery/screenshots/index.html'), '<script>artifact-payload</script>');
      writeFileSync(join(directory, 'gallery/extra.js'), 'artifact-payload');
      writeFileSync(join(directory, 'gallery/screenshots/images/extra.html'), 'artifact-payload');
      writeFileSync(join(directory, 'gallery/screenshots/images/01-capture.png'), Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64',
      ));
      const previous = {
        attempt: 1, branch: 'main', createdAt: '2026-08-16T10:00:00.000Z', event: 'push', id: '100',
        reportUrl: '', result: 'success', runNumber: 8, runUrl: '', screenshotCount: 1, screenshotsUrl: '', sha: '1111111',
      };
      writeFileSync(join(directory, 'previous.json'), JSON.stringify([previous]));
      writeFileSync(join(directory, 'gallery/history.json'), JSON.stringify([{ ...previous, id: '999', sha: 'artifact-payload' }]));
      writeFileSync(join(directory, 'bin/curl'), '#!/bin/bash\nprintf \'%s\' \'{"jobs":[{"name":"chrome-gallery","conclusion":"success"}]}\'\n', { mode: 0o755 });
      writeFileSync(join(directory, 'bin/aws'), `#!/bin/bash
set -eu
if [ "$2" = cp ]; then
  cp previous.json "$4"
elif [ "$2" = sync ]; then
  cp -R "$3" uploaded
else
  exit 1
fi
`, { mode: 0o755 });
      const sync = jobSteps(publish.jobs.publish).find((step) => step.id === 'sync');
      const replay = () => spawnSync('bash', ['-c', sync.run], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
          AWS_ACCESS_KEY_ID: 'fixture', S3_ENDPOINT: 'https://storage.invalid', S3_BUCKET: 'fixture',
          GITHUB_TOKEN: 'fixture', GH_REPO: 'koala73/worldmonitor', WORKFLOW_RUN_ID: '200',
          PLAYWRIGHT_RUN_ID: '200', PLAYWRIGHT_RUN_ATTEMPT: '2', PLAYWRIGHT_RUN_NUMBER: '9',
          PLAYWRIGHT_BRANCH: 'main', PLAYWRIGHT_EVENT: 'push', PLAYWRIGHT_SHA: '2222222',
          PLAYWRIGHT_RUN_URL: 'https://github.com/koala73/worldmonitor/actions/runs/200',
        },
      });
      const run = replay();
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.deepEqual(readdirSync(join(directory, 'uploaded')).sort(), ['history.json', 'index.html', 'screenshots']);
      assert.deepEqual(readdirSync(join(directory, 'uploaded/screenshots')).sort(), ['images', 'index.html']);
      assert.deepEqual(readdirSync(join(directory, 'uploaded/screenshots/images')), ['001-01-capture.png']);
      for (const file of ['index.html', 'screenshots/index.html', 'history.json']) {
        assert.doesNotMatch(readFileSync(join(directory, 'uploaded', file), 'utf8'), /artifact-payload/);
      }
      const history = JSON.parse(readFileSync(join(directory, 'uploaded/history.json'), 'utf8'));
      assert.deepEqual(history.map((entry) => entry.id), ['200', '100']);
      assert.equal(history[0].sha, '2222222');
      assert.equal(history[0].attempt, 2);
      assert.equal(history[0].result, 'success');
      assert.equal(history[0].screenshotCount, 1);
      rmSync(join(directory, 'uploaded'), { recursive: true, force: true });
      writeFileSync(join(directory, 'gallery/screenshots/images/payload.png'), '<script>artifact-payload</script>');
      const invalid = replay();
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /invalid PNG signature/);
      assert.equal(existsSync(join(directory, 'uploaded')), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
