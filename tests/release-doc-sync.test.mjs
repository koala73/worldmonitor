import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const documentation = readFileSync(
  path.join(repoRoot, 'docs', 'DOCUMENTATION.md'),
  'utf8',
);
const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('README uses a non-stale latest-release download label', () => {
  assert.match(readme, /<strong>Download Latest Release<\/strong>/);
  assert.doesNotMatch(readme, /<strong>Download v\d+\.\d+\.\d+<\/strong>/);
});

test('documentation version badge is dynamic and release-backed', () => {
  assert.match(
    documentation,
    /img\.shields\.io\/github\/v\/release\/bradleybond512\/worldmonitor-macos\?label=version/,
  );
  assert.doesNotMatch(
    documentation,
    /img\.shields\.io\/badge\/version-\d+\.\d+\.\d+-blue/,
  );
});

test('changelog includes the current package version entry', () => {
  const versionHeaderRegex = new RegExp(
    `^## \\[${escapeRegex(packageJson.version)}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    'm',
  );
  assert.match(
    changelog,
    versionHeaderRegex,
    `CHANGELOG.md must include a dated section for version ${packageJson.version}`,
  );
});
