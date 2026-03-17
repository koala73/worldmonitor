#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseCargoPackageMetadata, parseCargoLockVersion } from './release-doctor.mjs';
import {
  SUPPORTED_RELEASE_VARIANTS,
  buildReleaseName,
  buildReleaseTag,
  getReleaseProductName,
  parseReleaseRef,
} from './release-metadata.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function parseArgs(argv) {
  const options = {
    event: '',
    ref: '',
    variant: '',
    sha: '',
    githubOutput: '',
    enforceMain: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--event') {
      options.event = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--event=')) {
      options.event = arg.slice('--event='.length);
      continue;
    }
    if (arg === '--ref') {
      options.ref = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--ref=')) {
      options.ref = arg.slice('--ref='.length);
      continue;
    }
    if (arg === '--variant') {
      options.variant = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--variant=')) {
      options.variant = arg.slice('--variant='.length);
      continue;
    }
    if (arg === '--sha') {
      options.sha = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--sha=')) {
      options.sha = arg.slice('--sha='.length);
      continue;
    }
    if (arg === '--github-output') {
      options.githubOutput = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--github-output=')) {
      options.githubOutput = arg.slice('--github-output='.length);
      continue;
    }
    if (arg === '--no-enforce-main') {
      options.enforceMain = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['push', 'workflow_dispatch'].includes(options.event)) {
    throw new Error(`Unsupported release event: ${options.event}`);
  }

  if (!options.sha) {
    throw new Error('Missing --sha');
  }

  if (options.event === 'workflow_dispatch') {
    if (!SUPPORTED_RELEASE_VARIANTS.includes(options.variant)) {
      throw new Error(`Unsupported dispatch variant: ${options.variant}`);
    }
  } else if (!options.ref) {
    throw new Error('Missing --ref for tag-driven release context');
  }

  return options;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || `${command} ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
}

export async function readSynchronizedVersions() {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const tauriConfPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
  const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
  const cargoLockPath = path.join(repoRoot, 'src-tauri', 'Cargo.lock');
  const infoPlistPath = path.join(repoRoot, 'src-tauri', 'Info.plist');

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const tauriConf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
  const cargoToml = await readFile(cargoTomlPath, 'utf8');
  const cargoLock = await readFile(cargoLockPath, 'utf8');
  const infoPlist = await readFile(infoPlistPath, 'utf8');
  const cargoPackage = parseCargoPackageMetadata(cargoToml);
  const infoPlistVersionMatch = infoPlist.match(/<key>CFBundleGetInfoString<\/key>\s*<string>World Monitor ([^<]+)<\/string>/);

  return {
    packageVersion: packageJson.version,
    tauriVersion: tauriConf.version,
    cargoVersion: cargoPackage.version,
    cargoLockVersion: parseCargoLockVersion(cargoLock, cargoPackage.name),
    infoPlistVersion: infoPlistVersionMatch?.[1] ?? '',
  };
}

export function resolveReleaseContext({ event, refName, inputVariant, packageVersion, sha }) {
  const shortSha = sha.slice(0, 12);

  if (event === 'workflow_dispatch') {
    const variant = inputVariant;
    return {
      publish: false,
      variant,
      version: packageVersion,
      tag: buildReleaseTag(packageVersion, variant),
      releaseName: buildReleaseName(packageVersion, variant),
      productName: getReleaseProductName(variant),
      commitSha: sha,
      shortSha,
    };
  }

  const parsed = parseReleaseRef(refName);
  if (parsed.version !== packageVersion) {
    throw new Error(`Tag ${parsed.tag} does not match package version ${packageVersion}`);
  }

  return {
    publish: true,
    variant: parsed.variant,
    version: parsed.version,
    tag: parsed.tag,
    releaseName: buildReleaseName(parsed.version, parsed.variant),
    productName: getReleaseProductName(parsed.variant),
    commitSha: sha,
    shortSha,
  };
}

export function validateVersionSync(versions) {
  const expected = versions.packageVersion;
  const mismatches = [];
  for (const [label, value] of Object.entries({
    'src-tauri/tauri.conf.json': versions.tauriVersion,
    'src-tauri/Cargo.toml': versions.cargoVersion,
    'src-tauri/Cargo.lock': versions.cargoLockVersion,
    'src-tauri/Info.plist': versions.infoPlistVersion,
  })) {
    if (value !== expected) mismatches.push(`${label} (${value} != ${expected})`);
  }
  return mismatches;
}

export function commitIsOnRemoteMain(branchListOutput) {
  return branchListOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line === 'origin/main' || line.endsWith('/origin/main'));
}

async function writeGithubOutputs(outputPath, context) {
  if (!outputPath) return;
  const lines = Object.entries(context)
    .map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(outputPath, `${lines.join('\n')}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = await readSynchronizedVersions();
  const mismatches = validateVersionSync(versions);
  if (mismatches.length > 0) {
    throw new Error(`Version files are out of sync: ${mismatches.join(', ')}`);
  }

  const context = resolveReleaseContext({
    event: options.event,
    refName: options.ref,
    inputVariant: options.variant,
    packageVersion: versions.packageVersion,
    sha: options.sha,
  });

  if (options.enforceMain && context.publish) {
    const branches = runCommand('git', ['branch', '-r', '--contains', options.sha]);
    if (!commitIsOnRemoteMain(branches)) {
      throw new Error(`Tagged commit ${options.sha} is not on origin/main`);
    }
    const tagType = runCommand('git', ['cat-file', '-t', context.tag]);
    if (tagType !== 'tag') {
      throw new Error(`Release tag ${context.tag} must be annotated`);
    }
  }

  await writeGithubOutputs(options.githubOutput, context);
  console.log(JSON.stringify(context, null, 2));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(`[release-context] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
