import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const buildDesktop = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'build-desktop.yml'),
  'utf8',
);
const testLinuxApp = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'test-linux-app.yml'),
  'utf8',
);

test('artifact workflows pin upload and download actions to immutable SHAs', () => {
  const uploadPinnedShaPattern = /actions\/upload-artifact@[0-9a-f]{40}/;
  const downloadPinnedShaPattern = /actions\/download-artifact@[0-9a-f]{40}/;

  assert.match(
    buildDesktop,
    uploadPinnedShaPattern,
    'desktop release workflow should pin upload-artifact to a commit SHA',
  );
  assert.match(
    buildDesktop,
    downloadPinnedShaPattern,
    'desktop release workflow should pin download-artifact to a commit SHA',
  );
  assert.doesNotMatch(
    buildDesktop,
    /actions\/upload-artifact@v\d+|actions\/download-artifact@v\d+/,
    'desktop release workflow should not use floating artifact action tags',
  );
  assert.match(
    testLinuxApp,
    uploadPinnedShaPattern,
    'linux app workflow should pin upload-artifact to a commit SHA',
  );
  assert.doesNotMatch(
    testLinuxApp,
    /actions\/upload-artifact@v\d+/,
    'linux app workflow should not use a floating artifact upload action tag',
  );
});
