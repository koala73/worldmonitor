// AppImage delta updates (#5757). The repack embeds update information that
// tells AppImageUpdate-style tools to fetch a .zsync file from the latest
// GitHub release. That only works if three pieces agree:
//   1. the glob embedded by scripts/repack-linux-appimage.sh matches the name
//      GitHub gives the uploaded .zsync (Tauri writes "World Monitor_…" and
//      GitHub stores it as "World.Monitor_…");
//   2. build-desktop.yml uploads that .zsync next to the AppImage;
//   3. the publish gate refuses a release that lacks one.
// The repack itself needs Linux and appimagetool; it was run end to end in a
// linux/amd64 container against the v2.11.8 AppImage (see the PR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repack = readFileSync(join(root, 'scripts/repack-linux-appimage.sh'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/build-desktop.yml'), 'utf8');
const download = readFileSync(join(root, 'api/download.js'), 'utf8');

// GitHub's stored name for an uploaded file: spaces become dots.
const stored = (name) => name.replace(/ /g, '.');
const tauriName = (arch) => `World Monitor_2.11.9_${arch}.AppImage`;

function embeddedGlob(assetArch) {
  const m = repack.match(/UPDATE_INFO="gh-releases-zsync\|\$\{REPO%%\/\*\}\|\$\{REPO#\*\/\}\|latest\|([^"]+)"/);
  assert.ok(m, 'repack script no longer embeds gh-releases-zsync update information for the latest release');
  return m[1].replace('${ASSET_ARCH}', assetArch);
}

const globToRegExp = (glob) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

test('the embedded glob matches the stored .zsync name for both architectures', () => {
  for (const [toolArch, assetArch] of [['x86_64', 'amd64'], ['aarch64', 'aarch64']]) {
    assert.match(repack, new RegExp(`${toolArch}\\)[\\s\\S]*?ASSET_ARCH=${assetArch}`), `${toolArch} must map to asset arch ${assetArch}`);
    const glob = globToRegExp(embeddedGlob(assetArch));
    const zsync = `${stored(tauriName(assetArch))}.zsync`;
    assert.match(zsync, glob, `${zsync} is not matched by the embedded glob`);
    assert.doesNotMatch(stored(tauriName(assetArch)), glob, 'the glob must select the .zsync, not the AppImage');
    const other = assetArch === 'amd64' ? 'aarch64' : 'amd64';
    assert.doesNotMatch(`${stored(tauriName(other))}.zsync`, glob, `the ${assetArch} glob must not select the ${other} file`);
  }
});

test('the .zsync records the stored AppImage name as its download URL', () => {
  // appimagetool takes the URL from the output file name, so the repack must
  // build under the stored name and verify the result.
  assert.match(repack, /ASSET_NAME=\$\(basename "\$APPIMAGE" \| tr ' ' '\.'\)/);
  assert.match(repack, /-u "\$UPDATE_INFO" squashfs-root "\$ASSET_NAME"/);
  assert.match(repack, /ZSYNC_URL=\$\(sed -n 's\/\^URL: \/\/p' "\$ZSYNC"/);
  assert.match(repack, /--appimage-updateinformation/);
});

test('build-desktop.yml uploads the .zsync with the stripped AppImage', () => {
  assert.match(workflow, /ZSYNC="\$\(dirname "\$APPIMAGE"\)\/\$\(basename "\$APPIMAGE" \| tr ' ' '\.'\)\.zsync"/);
  assert.match(workflow, /gh release upload "\$TAG_NAME" "\$APPIMAGE" "\$ZSYNC" --clobber/);
});

test('the publish gate requires a .zsync for both AppImages', () => {
  const loop = workflow.match(/for suffix in ('_amd64\\\.AppImage\\\.zsync\$'[^\n]*); do/);
  assert.ok(loop, 'publish gate has no .zsync completeness check');
  assert.match(loop[1], /'_aarch64\\\.AppImage\\\.zsync\$'/);
});

test('/api/download never serves a .zsync as the Linux download', () => {
  for (const arch of ['amd64', 'aarch64']) {
    const m = download.match(new RegExp(`name\\.endsWith\\('_${arch}\\.AppImage'\\)`));
    assert.ok(m, `/api/download no longer anchors the ${arch} AppImage match at the end of the name`);
  }
});
