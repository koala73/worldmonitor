#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCargoPackageMetadata,
  updateCargoLockVersion,
  updateCargoPackageVersion,
  updatePackageLockVersion,
} from './sync-desktop-version-lib.mjs';

const CHECK_ONLY = process.argv.includes('--check');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const packageJsonPath = path.join(repoRoot, 'package.json');
const packageLockPath = path.join(repoRoot, 'package-lock.json');
const tauriConfPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(repoRoot, 'src-tauri', 'Cargo.lock');
const infoPlistPath = path.join(repoRoot, 'src-tauri', 'Info.plist');

async function main() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8'));
  const targetVersion = packageJson.version;

  if (!targetVersion || typeof targetVersion !== 'string') {
    throw new Error('package.json is missing a valid "version" field');
  }

  const packageLockUpdate = updatePackageLockVersion(packageLock, targetVersion);
  const tauriConf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
  const tauriCurrentVersion = tauriConf.version;
  const tauriChanged = tauriCurrentVersion !== targetVersion;

  const cargoToml = await readFile(cargoTomlPath, 'utf8');
  const cargoUpdate = updateCargoPackageVersion(cargoToml, targetVersion);
  const cargoPackage = readCargoPackageMetadata(cargoToml);
  const cargoLock = await readFile(cargoLockPath, 'utf8');
  const cargoLockUpdate = updateCargoLockVersion(cargoLock, cargoPackage.name, targetVersion);

  const infoPlist = await readFile(infoPlistPath, 'utf8');
  const infoPlistVersionMatch = infoPlist.match(/<key>CFBundleGetInfoString<\/key>\s*<string>World Monitor ([^<]+)<\/string>/);
  const infoPlistCurrentVersion = infoPlistVersionMatch ? infoPlistVersionMatch[1] : null;
  const infoPlistChanged = infoPlistCurrentVersion !== targetVersion;

  const mismatches = [];
  if (packageLockUpdate.changed) {
    mismatches.push(`package-lock.json (${packageLockUpdate.currentVersion} -> ${targetVersion})`);
  }
  if (tauriChanged) {
    mismatches.push(`src-tauri/tauri.conf.json (${tauriCurrentVersion} -> ${targetVersion})`);
  }
  if (cargoUpdate.changed) {
    mismatches.push(`src-tauri/Cargo.toml (${cargoUpdate.currentVersion} -> ${targetVersion})`);
  }
  if (cargoLockUpdate.changed) {
    mismatches.push(`src-tauri/Cargo.lock (${cargoLockUpdate.currentVersion} -> ${targetVersion})`);
  }
  if (infoPlistChanged) {
    mismatches.push(`src-tauri/Info.plist CFBundleGetInfoString (${infoPlistCurrentVersion ?? 'unknown'} -> ${targetVersion})`);
  }

  if (CHECK_ONLY) {
    if (mismatches.length > 0) {
      console.error('[version:check] Version mismatch detected:');
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exit(1);
    }
    console.log(`[version:check] OK. package.json, package-lock.json, tauri.conf.json, Cargo.toml, Cargo.lock, and Info.plist are all ${targetVersion}.`);
    return;
  }

  if (!packageLockUpdate.changed && !tauriChanged && !cargoUpdate.changed && !cargoLockUpdate.changed && !infoPlistChanged) {
    console.log(`[version:sync] No changes needed. All files already at ${targetVersion}.`);
    return;
  }

  if (packageLockUpdate.changed) {
    await writeFile(packageLockPath, `${JSON.stringify(packageLockUpdate.updatedLockfile, null, 2)}\n`, 'utf8');
  }

  if (tauriChanged) {
    tauriConf.version = targetVersion;
    await writeFile(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');
  }

  if (cargoUpdate.changed) {
    await writeFile(cargoTomlPath, cargoUpdate.updatedToml, 'utf8');
  }

  if (cargoLockUpdate.changed) {
    await writeFile(cargoLockPath, cargoLockUpdate.updatedLock, 'utf8');
  }

  if (infoPlistChanged) {
    const updatedPlist = infoPlist.replace(
      /(<key>CFBundleGetInfoString<\/key>\s*<string>)World Monitor [^<]+(<\/string>)/,
      `$1World Monitor ${targetVersion}$2`,
    );
    await writeFile(infoPlistPath, updatedPlist, 'utf8');
  }

  console.log(`[version:sync] Synced desktop versions to ${targetVersion}.`);
  for (const mismatch of mismatches) {
    console.log(`- ${mismatch}`);
  }
}

main().catch((error) => {
  console.error(`[version:sync] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
