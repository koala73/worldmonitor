import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const desktopPackageScript = readFileSync(path.join(repoRoot, 'scripts', 'desktop-package.mjs'), 'utf8');

test('macOS desktop packaging signs and verifies the app bundle before creating a dmg', () => {
  assert.match(
    packageJson.scripts['desktop:build:full'],
    /scripts\/desktop-package\.mjs --os macos --variant full/,
    'desktop:build:full should use the desktop packaging script instead of raw tauri build',
  );
  assert.match(
    packageJson.scripts['desktop:build:tech'],
    /scripts\/desktop-package\.mjs --os macos --variant tech/,
    'desktop:build:tech should use the desktop packaging script instead of raw tauri build',
  );
  assert.match(
    packageJson.scripts['desktop:build:finance'],
    /scripts\/desktop-package\.mjs --os macos --variant finance/,
    'desktop:build:finance should use the desktop packaging script instead of raw tauri build',
  );
  assert.match(
    packageJson.scripts['desktop:build:app:full'],
    /scripts\/desktop-package\.mjs --os macos --variant full --app-only/,
    'desktop:build:app:full should build only the local app bundle for install sync',
  );
  assert.match(
    desktopPackageScript,
    /codesign["']?,?\s*\[[^\]]*--force[^\]]*--deep[^\]]*--sign[^\]]*-/s,
    'macOS packaging should ad-hoc sign the generated app bundle when developer signing is unavailable',
  );
  assert.match(
    desktopPackageScript,
    /verifyMacCodeSignature\(appPath, 'App bundle'\)/,
    'macOS packaging should verify the app bundle signature after signing',
  );
  assert.match(
    desktopPackageScript,
    /hdiutil["']?,?\s*\[[^\]]*create/s,
    'macOS packaging should create the dmg after the app bundle has been signed and verified',
  );
  assert.match(
    desktopPackageScript,
    /attach[\s\S]*verifyMacCodeSignature\(path\.join\(mountPoint, appName\), 'Mounted app bundle'\)[\s\S]*detach/s,
    'macOS packaging should verify the signed app bundle inside the mounted dmg before returning success',
  );
  assert.match(
    desktopPackageScript,
    /const bundles = targetOs === 'macos' \? sign \? 'app,dmg' : 'app'/,
    'macOS packaging should preserve Tauri dmg bundling when signing is requested',
  );
  assert.match(
    desktopPackageScript,
    /const appOnly = hasFlag\('app-only'\);/,
    'desktop packaging should support an app-only mode for local install sync',
  );
  assert.match(
    desktopPackageScript,
    /if \(appOnly\) \{\s*process\.exit\(0\);\s*\}/,
    'desktop packaging should allow app verification to succeed without forcing dmg creation',
  );
  assert.match(
    desktopPackageScript,
    /const variantProductName = \{[\s\S]*finance: 'Finance Monitor'[\s\S]*\}\[variant\];/,
    'macOS packaging should derive an expected app bundle name from the selected variant',
  );
  assert.doesNotMatch(
    desktopPackageScript,
    /readdirSync\(appDir\)\.find\(\(entry\) => entry\.endsWith\('\.app'\)\)/,
    'macOS packaging should not pick the first .app bundle from the output directory',
  );
  assert.match(
    desktopPackageScript,
    /codesign[\s\S]*dmgPath/,
    'signed macOS packaging should verify or sign the dmg artifact explicitly',
  );
  assert.match(
    desktopPackageScript,
    /full\|tech\|finance/,
    'CLI help and validation should list the finance variant',
  );
});
