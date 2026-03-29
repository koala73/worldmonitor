export function readCargoPackageMetadata(cargoToml) {
  const packageSectionRegex = /\[package\][\s\S]*?(?=\n\[|$)/;
  const packageSectionMatch = cargoToml.match(packageSectionRegex);
  if (!packageSectionMatch) {
    throw new Error('Could not find [package] section in src-tauri/Cargo.toml');
  }

  const packageSection = packageSectionMatch[0];
  const nameRegex = /^name\s*=\s*"([^"]+)"\s*$/m;
  const nameMatch = packageSection.match(nameRegex);
  if (!nameMatch) {
    throw new Error('Could not find package name in src-tauri/Cargo.toml');
  }

  const versionRegex = /^version\s*=\s*"([^"]+)"\s*$/m;
  const versionMatch = packageSection.match(versionRegex);
  if (!versionMatch) {
    throw new Error('Could not find package version in src-tauri/Cargo.toml');
  }

  return {
    name: nameMatch[1],
    version: versionMatch[1],
  };
}

export function updateCargoPackageVersion(cargoToml, targetVersion) {
  const packageSectionRegex = /\[package\][\s\S]*?(?=\n\[|$)/;
  const packageSectionMatch = cargoToml.match(packageSectionRegex);
  if (!packageSectionMatch) {
    throw new Error('Could not find [package] section in src-tauri/Cargo.toml');
  }

  const packageSection = packageSectionMatch[0];
  const { version: currentVersion } = readCargoPackageMetadata(cargoToml);
  const versionRegex = /^version\s*=\s*"([^"]+)"\s*$/m;
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

export function updatePackageLockVersion(packageLock, targetVersion) {
  const currentVersion = packageLock.version ?? packageLock.packages?.['']?.version ?? '';
  const rootPackageVersion = packageLock.packages?.['']?.version ?? '';
  const changed = currentVersion !== targetVersion || rootPackageVersion !== targetVersion;

  if (!changed) {
    return { changed: false, currentVersion, updatedLockfile: packageLock };
  }

  const updatedPackages = { ...packageLock.packages };
  updatedPackages[''] = {
    ...updatedPackages[''],
    version: targetVersion,
  };

  return {
    changed: true,
    currentVersion,
    updatedLockfile: {
      ...packageLock,
      version: targetVersion,
      packages: updatedPackages,
    },
  };
}

export function updateCargoLockVersion(cargoLock, packageName, targetVersion) {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const packageBlockRegex = new RegExp(String.raw`(\[\[package\]\]\r?\nname = "${escapedPackageName}"\r?\nversion = ")([^"]+)(")`, 'm');
  const versionMatch = cargoLock.match(packageBlockRegex);
  if (!versionMatch) {
    throw new Error(`Could not find ${packageName} package version in src-tauri/Cargo.lock`);
  }

  const currentVersion = versionMatch[2];
  if (currentVersion === targetVersion) {
    return { changed: false, currentVersion, updatedLock: cargoLock };
  }

  return {
    changed: true,
    currentVersion,
    updatedLock: cargoLock.replace(packageBlockRegex, `$1${targetVersion}$3`),
  };
}
