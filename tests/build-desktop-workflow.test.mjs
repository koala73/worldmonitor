import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'build-desktop.yml'),
  'utf8',
);

test('desktop build workflow is tag-driven and publishes only after artifact verification', () => {
  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*Build-only variant/,
    'workflow dispatch should be build-only, not a release publisher',
  );
  assert.match(
    workflow,
    /Resolve release context[\s\S]*node scripts\/release-context\.mjs/,
    'desktop build workflow should derive variant, tag, and publish mode from a shared release-context script',
  );
  assert.match(
    workflow,
    /Build Tauri app[\s\S]*read -r -a tauri_args <<< "\$\{TAURI_BUILD_ARGS\}"[\s\S]*npm exec tauri build -- "\$\{tauri_args\[@\]\}"/,
    'desktop build workflow should build artifacts directly before publishing them with shell-safe argument handling',
  );
  assert.doesNotMatch(
    workflow,
    /tauri-apps\/tauri-action/,
    'desktop build workflow should not publish releases from tauri-action before manifest checks finish',
  );
  assert.match(
    workflow,
    /Collect release manifest[\s\S]*node scripts\/release-manifest\.mjs[\s\S]*--mode collect/,
    'desktop build workflow should produce per-platform release manifests with checksums',
  );
  assert.match(
    workflow,
    /Create or update GitHub release[\s\S]*gh release create/,
    'desktop build workflow should publish releases in a dedicated post-build job',
  );
  assert.match(
    workflow,
    /Upload release assets and manifest[\s\S]*gh release upload/,
    'desktop build workflow should upload a consolidated manifest alongside release assets',
  );
  assert.match(
    workflow,
    /Verify uploaded release payload[\s\S]*gh release download[\s\S]*node scripts\/release-manifest\.mjs[\s\S]*--mode verify/,
    'desktop build workflow should re-download and verify the exact uploaded payload before sign-off',
  );
  assert.match(
    workflow,
    /variant:[\s\S]*- finance/,
    'desktop build workflow should support the finance variant in manual build mode',
  );
});
