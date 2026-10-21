#!/usr/bin/env node

import { isMainModule } from './lib/main-module.mjs';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value, label) {
  const text = String(value ?? '');
  const match = text.match(VERSION_PATTERN);
  if (!match) {
    throw new Error(`${label} must be a strict MAJOR.MINOR.PATCH version; got "${text || '(empty)'}"`);
  }

  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`${label} contains a numeric component outside the safe integer range`);
  }

  return {
    text,
    parts,
  };
}

export function compareReleaseVersions(left, right) {
  const leftVersion = parseVersion(left, 'left version');
  const rightVersion = parseVersion(right, 'right version');

  for (let index = 0; index < leftVersion.parts.length; index += 1) {
    if (leftVersion.parts[index] !== rightVersion.parts[index]) {
      return leftVersion.parts[index] < rightVersion.parts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function releaseVersionFromTag(tag) {
  const text = String(tag ?? '');
  const match = text.match(TAG_PATTERN);
  if (!match) {
    throw new Error(`latest release tag must be vMAJOR.MINOR.PATCH; got "${text || '(empty)'}"`);
  }
  return text.slice(1);
}

export function resolveDesktopRelease({ packageVersion, latestReleaseTag = '' }) {
  const targetVersion = parseVersion(packageVersion, 'package.json version');
  const targetTag = `v${targetVersion.text}`;
  const latestTag = String(latestReleaseTag ?? '');

  if (!latestTag) {
    return {
      action: 'release',
      tag: targetTag,
      reason: `no published desktop release exists; prepare ${targetTag}`,
    };
  }

  const latestVersion = releaseVersionFromTag(latestTag);
  const comparison = compareReleaseVersions(targetVersion.text, latestVersion);
  if (comparison > 0) {
    return {
      action: 'release',
      tag: targetTag,
      latestReleaseTag: latestTag,
      reason: `${targetTag} is newer than published ${latestTag}`,
    };
  }

  return {
    action: 'noop',
    tag: targetTag,
    latestReleaseTag: latestTag,
    reason: `${targetTag} is not newer than published ${latestTag}`,
  };
}

function main() {
  const [packageVersion, latestReleaseTag = ''] = process.argv.slice(2);
  if (!packageVersion || process.argv.length > 4) {
    throw new Error('usage: resolve-desktop-release.mjs <package-version> [latest-release-tag]');
  }

  const result = resolveDesktopRelease({ packageVersion, latestReleaseTag });
  console.log(`action=${result.action}`);
  console.log(`tag=${result.tag}`);
  console.log(`reason=${result.reason}`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[resolve-desktop-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
