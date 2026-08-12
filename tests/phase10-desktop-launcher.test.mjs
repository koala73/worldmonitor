import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = '全球实时热点追踪·探长版';

const readProjectFile = (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8');

test('Phase 10 gives the Tauri shell the user-confirmed independent product identity', async () => {
  const config = JSON.parse(await readProjectFile('src-tauri/tauri.conf.json'));

  assert.equal(config.productName, brand);
  assert.equal(config.mainBinaryName, 'global-intelligence-earth');
  assert.equal(config.identifier, 'com.globalintelligenceearth.desktop');
  assert.equal(config.app.windows[0].title, brand);
  assert.match(config.bundle.shortDescription, /全球实时热点追踪·探长版/);
  assert.match(config.bundle.longDescription, /Based on World Monitor/);
  assert.match(config.bundle.longDescription, /AGPL-3\.0-only/);
});

test('Phase 10 keeps visible Tauri menu identity independent and preserves upstream attribution', async () => {
  const source = await readProjectFile('src-tauri/src/main.rs');

  assert.match(source, /const PRODUCT_BRAND: &str = "全球实时热点追踪·探长版"/);
  assert.match(source, /const UPSTREAM_ATTRIBUTION: &str = "Based on World Monitor, modified and distributed under AGPL-3\.0-only\."/);
  assert.match(source, /const KEYRING_SERVICE: &str = "world-monitor"/);
  assert.match(source, /https:\/\/github\.com\/koala73\/worldmonitor/);
  assert.match(source, /#\[cfg\(target_os = "macos"\)\]\s*\nuse tauri::WindowEvent/);
  assert.doesNotMatch(source, /title\("World Monitor Settings"\)/);
  assert.doesNotMatch(source, /title\("Channel management - World Monitor"\)/);
});

test('Phase 10 preserves Tauri index.html while retaining the web-only dashboard rename', async () => {
  const source = await readProjectFile('vite.config.ts');
  const buildScript = await readProjectFile('src-tauri/build.rs');

  assert.match(source, /!isDesktopBuild && dashboardHtmlOutputPlugin\(\)/);
  assert.match(source, /!isDesktopBuild && activeVariant === 'full' && variantDashboardHtmlPlugin\(\)/);
  assert.match(buildScript, /cargo:rerun-if-changed=\.\.\/dist\/index\.html/);
  assert.match(buildScript, /cargo:rerun-if-changed=\.\.\/dist\/assets/);
});

test('Phase 10 has a Windows Node runtime bundler that verifies the official checksum', async () => {
  const source = await readProjectFile('scripts/download-node-windows.mjs');
  const preparation = await readProjectFile('scripts/prepare-desktop-node-runtime.mjs');
  const packageJson = JSON.parse(await readProjectFile('package.json'));

  assert.match(source, /https:\/\/nodejs\.org\/dist/);
  assert.match(source, /Node\.js distribution licence/);
  assert.match(source, /LICENSE.*travels with/);
  assert.match(await readProjectFile('scripts/source-attribution.mjs'), /NON_DATA_SOURCE_FILES/);
  assert.match(source, /SHASUMS256\.txt/);
  assert.match(source, /SHA-256 mismatch/);
  assert.match(source, /sidecar', 'node'/);
  assert.match(source, /VERSION\.json/);
  assert.match(preparation, /binarySha256/);
  assert.match(preparation, /process\.platform !== 'win32'/);
  assert.equal(packageJson.scripts['desktop:prepare-node-runtime'], 'node scripts/prepare-desktop-node-runtime.mjs');
  assert.match(packageJson.scripts['desktop:tauri:build'], /desktop:prepare-node-runtime/);
  assert.equal(packageJson.scripts['desktop:tauri:build:nsis'], 'npm run desktop:tauri:build -- --bundles nsis');
});

test('Phase 10 launcher is native, path-safe, idempotent, and never returns to legacy services', async () => {
  const source = await readProjectFile('scripts/Launch-Global-Intelligence-Earth-Mother.ps1');

  assert.match(source, /\$PSScriptRoot/);
  assert.match(source, /UTF8Encoding\(\$false\)/);
  assert.match(source, /System\.Threading\.Mutex/);
  assert.match(source, /Get-InstalledDesktopExecutable/);
  assert.match(source, /Install-DesktopApplicationIfNeeded/);
  assert.match(source, /Start-Process -FilePath \$InstallerPath -ArgumentList '\/S' -Wait -PassThru/);
  assert.match(source, /GetFolderPath\('ProgramFiles'\)/);
  assert.match(source, /GetFolderPath\('LocalApplicationData'\)/);
  assert.match(source, /NSIS-installed application directory/);
  assert.match(source, /Get-Process -Name \$DesktopProcessName/);
  assert.match(source, /\$DesktopProcessName\.exe/);
  assert.match(source, /Start-Process -FilePath \$DesktopExecutable/);
  assert.match(source, /Tauri process starts and supervises its own first-party local/);
  assert.doesNotMatch(source, /(?:^|\D)4000(?:\D|$)/);
  assert.doesNotMatch(source, /(?:^|\D)5173(?:\D|$)/);
  assert.doesNotMatch(source, /\b(?:Start-WorkspaceDevServer|Test-LocalTcpPort|Invoke-WebRequest)\b/);
  assert.doesNotMatch(source, /src-tauri\\target\\release\\global-intelligence-earth\.exe/);
});

test('Phase 10 shortcut targets only the new path-safe native launcher', async () => {
  const source = await readProjectFile('scripts/Create-Global-Intelligence-Earth-DesktopShortcut.ps1');

  assert.match(source, /WScript\.Shell/);
  assert.match(source, /Launch-Global-Intelligence-Earth-Mother\.ps1/);
  assert.match(source, /DesktopDirectory/);
  assert.match(source, /CreateShortcut/);
  assert.match(source, /UTF8Encoding\(\$false\)/);
  assert.doesNotMatch(source, /(?:^|\D)4000(?:\D|$)/);
  assert.doesNotMatch(source, /(?:^|\D)5173(?:\D|$)/);
});
