#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SUPPORTED_RELEASE_VARIANTS, buildReleaseTag } from './release-metadata.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');

function parseArgs(argv) {
  const options = {
    version: '',
    bump: '',
    variants: ['full', 'tech', 'finance'],
    remote: 'macos',
    push: false,
    signTags: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      options.version = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
      continue;
    }
    if (arg === '--bump') {
      options.bump = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--bump=')) {
      options.bump = arg.slice('--bump='.length);
      continue;
    }
    if (arg === '--variants') {
      options.variants = parseVariants(argv[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (arg.startsWith('--variants=')) {
      options.variants = parseVariants(arg.slice('--variants='.length));
      continue;
    }
    if (arg === '--remote') {
      options.remote = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--remote=')) {
      options.remote = arg.slice('--remote='.length);
      continue;
    }
    if (arg === '--push') {
      options.push = true;
      continue;
    }
    if (arg === '--sign-tags') {
      options.signTags = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!!options.version === !!options.bump) {
    throw new Error('Choose exactly one of --version or --bump');
  }

  return options;
}

function parseVariants(input) {
  const raw = input === 'all' ? SUPPORTED_RELEASE_VARIANTS : input.split(',').map((value) => value.trim()).filter(Boolean);
  const unique = [...new Set(raw)];
  for (const variant of unique) {
    if (!SUPPORTED_RELEASE_VARIANTS.includes(variant)) {
      throw new Error(`Unsupported release variant: ${variant}`);
    }
  }
  return unique;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

export function bumpVersion(currentVersion, bump) {
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported current version: ${currentVersion}`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'major') return `${major + 1}.0.0`;
  throw new Error(`Unsupported bump type: ${bump}`);
}

export function buildTagPlan(version, variants) {
  return variants.map((variant) => buildReleaseTag(version, variant));
}

async function updatePackageVersion(version) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  packageJson.version = version;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const branch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') {
    throw new Error(`Release prep must run from main, found ${branch}`);
  }

  const dirtyStatus = runCommand('git', ['status', '--short']);
  if (dirtyStatus) {
    throw new Error('Release prep requires a clean worktree');
  }

  const currentVersion = JSON.parse(await readFile(packageJsonPath, 'utf8')).version;
  const nextVersion = options.version || bumpVersion(currentVersion, options.bump);
  const tags = buildTagPlan(nextVersion, options.variants);

  await updatePackageVersion(nextVersion);
  runCommand('npm', ['run', 'version:sync']);
  runCommand('npm', ['run', 'version:check']);
  runCommand('npm', ['run', 'typecheck:all']);

  runCommand('git', [
    'add',
    'package.json',
    'package-lock.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/Info.plist',
  ]);
  runCommand('git', ['commit', '-m', `Prepare ${nextVersion} release`, '-m', 'Co-Authored-By: Codex GPT-5.4 <noreply@openai.com>']);

  for (const tag of tags) {
    const tagArgs = options.signTags
      ? ['tag', '-s', tag, '-m', `Release ${tag}`]
      : ['tag', '-a', tag, '-m', `Release ${tag}`];
    runCommand('git', tagArgs);
  }

  if (options.push) {
    runCommand('git', ['push', options.remote, 'main']);
    runCommand('git', ['push', options.remote, ...tags]);
  }

  console.log(JSON.stringify({ version: nextVersion, tags, pushed: options.push }, null, 2));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(`[release-prepare] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
