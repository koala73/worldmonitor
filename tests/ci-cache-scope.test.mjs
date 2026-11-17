// A cache saved by a pull_request run is scoped to refs/pull/<n>/merge: only
// later runs of that same PR can read it. A cache saved on main is readable by
// every PR. So a workflow that runs only on pull requests must not save under a
// key that no main run ever writes. Each PR then misses and saves its own copy.
// pro-bundle-freshness.yml did that: its setup-node npm cache was keyed over the
// root and pro-test lockfiles together. On 17 November 2026 eight identical
// 592 MB copies sat on eight PR refs, the repository was at 10.75 GB against a
// 10 GB limit, and main's desktop-rust cache was evicted within a day of being
// saved.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(root, '.github/workflows');

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

function triggers(workflow) {
  const on = workflow.on ?? workflow[true];
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, null]));
  return on ?? {};
}

// Runs whose caches every PR can read: pushes to main and scheduled runs,
// which run on the default branch.
function writesOnMain(on) {
  if ('schedule' in on) return true;
  if (!('push' in on)) return false;
  const push = on.push ?? {};
  if (push.tags && !push.branches) return false;
  return !push.branches || push.branches.includes('main');
}

// Runs on pull requests but never where every PR could read its caches. A
// manual dispatch does not change that: it is rare, and on a branch its caches
// are scoped the same way.
function isPrOnly(on) {
  return Object.keys(on).some((e) => PR_EVENTS.has(e)) && !writesOnMain(on);
}

function action(step) {
  return typeof step.uses === 'string' ? step.uses.split('@')[0] : '';
}

// setup-node's npm cache key is the hash of its dependency files, so two steps
// share an entry exactly when they list the same files.
function setupNodeCacheId(step) {
  const w = step.with ?? {};
  if (action(step) !== 'actions/setup-node' || !w.cache) return null;
  const files = String(w['cache-dependency-path'] ?? 'package-lock.json')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  return `${w.cache}:${files.join(',')}`;
}

// Keys this job saves under: actions/cache saves its primary key, and
// actions/cache/save names one directly or through a restore step's output.
function savedKeys(job) {
  const steps = job.steps ?? [];
  const keys = [];
  for (const step of steps) {
    const key = step.with?.key;
    if (action(step) === 'actions/cache') keys.push(key);
    if (action(step) === 'actions/cache/save') {
      const ref = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.cache-primary-key\s*\}\}$/.exec(key ?? '');
      const restore = ref && steps.find((s) => s.id === ref[1]);
      keys.push(restore ? restore.with?.key : key);
    }
  }
  return keys;
}

const workflows = readdirSync(workflowDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => {
    const parsed = YAML.parse(readFileSync(join(workflowDir, file), 'utf8'));
    const on = triggers(parsed);
    return { file, parsed, on, jobs: Object.values(parsed.jobs ?? {}) };
  });

const mainWorkflows = workflows.filter((w) => writesOnMain(w.on));
const mainSetupNodeCaches = new Set(
  mainWorkflows.flatMap((w) => w.jobs.flatMap((j) => (j.steps ?? []).map(setupNodeCacheId))).filter(Boolean),
);
const mainSavedKeys = new Set(mainWorkflows.flatMap((w) => w.jobs.flatMap(savedKeys)));

describe('pull-request-only workflows save only caches main also writes', () => {
  const prOnly = workflows.filter((w) => isPrOnly(w.on));

  it('finds the pull-request-only workflows to check', () => {
    assert.ok(
      prOnly.some((w) => w.file === 'pro-bundle-freshness.yml'),
      'trigger parsing broke: pro-bundle-freshness.yml is pull_request-only',
    );
    assert.ok(mainSetupNodeCaches.size > 0 && mainSavedKeys.size > 0, 'found no caches written on main');
  });

  for (const w of prOnly) {
    it(`${w.file}: setup-node caches use dependency files a main run also caches`, () => {
      for (const job of w.jobs) {
        for (const step of job.steps ?? []) {
          const id = setupNodeCacheId(step);
          if (!id) continue;
          assert.ok(
            mainSetupNodeCaches.has(id),
            `${w.file} saves a setup-node cache over [${id}] that no main or scheduled run writes, ` +
              'so every PR saves its own copy. Restore a cache main writes ' +
              '(./.github/actions/install-root-deps, actions/cache/restore) or drop `cache:`.',
          );
        }
      }
    });

    it(`${w.file}: actions/cache saves use keys a main run also saves`, () => {
      for (const job of w.jobs) {
        for (const key of savedKeys(job)) {
          assert.ok(
            mainSavedKeys.has(key),
            `${w.file} saves under "${key}", which no main or scheduled run saves, so every PR ` +
              'saves its own copy. Use actions/cache/restore with a key main writes.',
          );
        }
      }
    });
  }
});

describe('pro-bundle-freshness restores what test.yml saves on main', () => {
  const find = (file) => workflows.find((w) => w.file === file);
  const restoreKey = (w) =>
    w.jobs.flatMap((j) => j.steps ?? []).find((s) => s.id === 'built-output-deps')?.with?.key;

  it('uses the exact built-output-deps key of unit-built-output', () => {
    const freshness = restoreKey(find('pro-bundle-freshness.yml'));
    assert.ok(freshness, 'pro-bundle-freshness.yml has no built-output-deps restore step');
    assert.equal(freshness, restoreKey(find('test.yml')));
  });

  it('restores that key without saving it', () => {
    const steps = find('pro-bundle-freshness.yml').jobs.flatMap((j) => j.steps ?? []);
    const step = steps.find((s) => s.id === 'built-output-deps');
    assert.equal(action(step), 'actions/cache/restore');
  });
});
