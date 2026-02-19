#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const packageJsonPath = path.join(repoRoot, 'package.json');
const tauriConfPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');

function updateCargoPackageVersion(cargoToml, targetVersion) {
  const packageSectionRegex = /\[package\][\s\S]*?(?=\n\[|$)/;
  const packageSectionMatch = cargoToml.match(packageSectionRegex);
  if (!packageSectionMatch) {
    throw new Error('Could not find [package] section in src-tauri/Cargo.toml');
  }

  const packageSection = packageSectionMatch[0];
  const versionRegex = /^version\s*=\s*"([^"]+)"\s*$/m;
  const versionMatch = packageSection.match(versionRegex);
  if (!versionMatch) {
    throw new Error('Could not find package version in src-tauri/Cargo.toml');
  }

  const currentVersion = versionMatch[1];
  if (currentVersion === targetVersion) {
    return { changed: false, currentVersion, updatedToml: cargoToml };
  }

  const updatedSection = packageSection.replace(versionRegex, `version = "${targetVersion}"`);
  return {
    changed: true,
    currentVersion,
    updatedToml: cargoToml.replace(packageSection, updatedSection),
  };
}

async function main() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const targetVersion = packageJson.version;

  if (!targetVersion || typeof targetVersion !== 'string') {
    throw new Error('package.json is missing a valid "version" field');
  }

  const tauriConf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
  const tauriCurrentVersion = tauriConf.version;
  const tauriChanged = tauriCurrentVersion !== targetVersion;

  const cargoToml = await readFile(cargoTomlPath, 'utf8');
  const cargoUpdate = updateCargoPackageVersion(cargoToml, targetVersion);

  const mismatches = [];
  if (tauriChanged) {
    mismatches.push(`src-tauri/tauri.conf.json (${tauriCurrentVersion} -> ${targetVersion})`);
  }
  if (cargoUpdate.changed) {
    mismatches.push(`src-tauri/Cargo.toml (${cargoUpdate.currentVersion} -> ${targetVersion})`);
  }

  if (CHECK_ONLY) {
    if (mismatches.length > 0) {
      console.error('[version:check] Version mismatch detected:');
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exit(1);
    }
    console.log(`[version:check] OK. package.json, tauri.conf.json, and Cargo.toml are all ${targetVersion}.`);
    return;
  }

  if (!tauriChanged && !cargoUpdate.changed) {
    console.log(`[version:sync] No changes needed. All files already at ${targetVersion}.`);
    return;
  }

  if (tauriChanged) {
    tauriConf.version = targetVersion;
    await writeFile(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');
  }

  if (cargoUpdate.changed) {
    await writeFile(cargoTomlPath, cargoUpdate.updatedToml, 'utf8');
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
