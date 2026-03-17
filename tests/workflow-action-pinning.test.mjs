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
  assert.match(
    buildDesktop,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    'desktop release workflow should pin upload-artifact to a commit SHA',
  );
  assert.match(
    buildDesktop,
    /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/,
    'desktop release workflow should pin download-artifact to a commit SHA',
  );
  assert.doesNotMatch(
    buildDesktop,
    /actions\/upload-artifact@v4|actions\/download-artifact@v4/,
    'desktop release workflow should not use floating artifact action tags',
  );
  assert.match(
    testLinuxApp,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    'linux app workflow should pin upload-artifact to a commit SHA',
  );
  assert.doesNotMatch(
    testLinuxApp,
    /actions\/upload-artifact@v4/,
    'linux app workflow should not use a floating artifact upload action tag',
  );
});
