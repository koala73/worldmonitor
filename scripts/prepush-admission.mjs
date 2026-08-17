#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_MAX_PARALLEL = 2;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 12 * 60_000;

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function usage() {
  console.error('usage: prepush-admission.mjs <acquire|release> <git-common-dir> [lease-or-owner-pid]');
}

function admissionRoot(commonDir) {
  const canonicalCommonDir = realpathSync(resolve(commonDir));
  const root = join(canonicalCommonDir, 'wm-prepush-admission');
  mkdirSync(root, { mode: 0o700, recursive: true });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe pre-push admission directory: ${root}`);
  }
  return root;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOwner(slotPath) {
  const raw = readFileSync(join(slotPath, 'owner.json'), 'utf8');
  try {
    return { owner: JSON.parse(raw), raw };
  } catch (error) {
    error.ownerRaw = raw;
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function quarantineOwnedSlot(slotPath, expectedRaw, expectedStat, reason) {
  const quarantinePath = `${slotPath}.${reason}-${randomUUID()}`;
  try {
    renameSync(slotPath, quarantinePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  try {
    const movedStat = lstatSync(quarantinePath);
    let movedRaw = null;
    try {
      movedRaw = readFileSync(join(quarantinePath, 'owner.json'), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!sameFile(expectedStat, movedStat) || movedRaw !== expectedRaw) {
      try {
        renameSync(quarantinePath, slotPath);
        return false;
      } catch {
        // Fail closed. Never delete a lease whose identity changed, and never
        // overwrite another owner that acquired the original slot path.
      }
      throw new Error(`Pre-push admission slot changed owner during ${reason}`);
    }
    rmSync(quarantinePath, { recursive: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function reclaimIfStale(slotPath, staleMs) {
  let stat;
  try {
    stat = lstatSync(slotPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  // Avoid parsing every live owner's record on every poll. Directory mtime is
  // refreshed when owner.json is created, so a young slot cannot be stale.
  if (Date.now() - stat.mtimeMs < staleMs) return false;

  let ownerRecord;
  try {
    ownerRecord = readOwner(slotPath);
  } catch (error) {
    // A creator may be between mkdir and owner.json. Treat it as fresh until
    // the directory itself exceeds the stale grace period.
    if (error instanceof SyntaxError || error?.code === 'ENOENT' || error?.code === 'EISDIR') {
      return quarantineOwnedSlot(slotPath, error.ownerRaw ?? null, stat, 'stale');
    }
    throw error;
  }

  const acquiredAt = Number(ownerRecord?.owner?.acquiredAt ?? stat.mtimeMs);
  const ageMs = Date.now() - acquiredAt;
  if (ageMs < staleMs) return false;
  // Age alone cannot prove that a heavy phase ended. Reclaim only when its
  // recorded process is gone, or the cap can be exceeded by a long push.
  if (processIsAlive(Number(ownerRecord?.owner?.pid))) return false;

  return quarantineOwnedSlot(slotPath, ownerRecord.raw, stat, 'stale');
}

function tryAcquire(root, settings) {
  const { maxParallel, ownerPid, staleMs } = settings;
  for (let slotNumber = 1; slotNumber <= maxParallel; slotNumber += 1) {
    const slotPath = join(root, `slot-${slotNumber}`);
    while (true) {
      try {
        mkdirSync(slotPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (reclaimIfStale(slotPath, staleMs)) continue;
        break;
      }

      const createdStat = lstatSync(slotPath);
      const token = randomUUID();
      try {
        writeFileSync(
          join(slotPath, 'owner.json'),
          `${JSON.stringify({ acquiredAt: Date.now(), pid: ownerPid, token })}\n`,
          { flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        let currentRaw = null;
        try {
          currentRaw = readFileSync(join(slotPath, 'owner.json'), 'utf8');
        } catch (readError) {
          if (readError?.code !== 'ENOENT') throw readError;
        }
        quarantineOwnedSlot(slotPath, currentRaw, createdStat, 'failed');
        throw error;
      }
      return JSON.stringify({ slotPath, token });
    }
  }
  return null;
}

async function acquire(root, ownerPid) {
  const maxParallel = positiveInteger('WM_PREPUSH_ADMISSION_MAX', DEFAULT_MAX_PARALLEL);
  const pollMs = positiveInteger('WM_PREPUSH_ADMISSION_POLL_MS', DEFAULT_POLL_MS);
  const staleMs = positiveInteger('WM_PREPUSH_ADMISSION_STALE_MS', DEFAULT_STALE_MS);
  const waitMs = positiveInteger('WM_PREPUSH_ADMISSION_WAIT_MS', DEFAULT_WAIT_MS);
  const deadline = Date.now() + waitMs;
  let announcedWait = false;
  const settings = { maxParallel, ownerPid, staleMs };

  while (true) {
    const lease = tryAcquire(root, settings);
    if (lease) return lease;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a pre-push heavy-phase slot after ${waitMs}ms`);
    }
    if (!announcedWait) {
      console.error(`Pre-push heavy phase is busy (${maxParallel} active); waiting for a slot...`);
      announcedWait = true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

function release(root, encodedLease) {
  let lease;
  try {
    lease = JSON.parse(encodedLease);
  } catch {
    throw new TypeError('Invalid pre-push admission lease');
  }

  const slotPath = resolve(String(lease.slotPath ?? ''));
  if (dirname(slotPath) !== root || !/^slot-[1-9]\d*$/.test(slotPath.slice(root.length + 1))) {
    throw new Error('Pre-push admission lease escapes its root');
  }

  let ownerRecord;
  let stat;
  try {
    stat = lstatSync(slotPath);
    ownerRecord = readOwner(slotPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (ownerRecord.owner.token !== lease.token) {
    throw new Error('Pre-push admission lease does not own this slot');
  }
  quarantineOwnedSlot(slotPath, ownerRecord.raw, stat, 'released');
}

async function main() {
  const [mode, commonDir, value] = process.argv.slice(2);
  if (!['acquire', 'release'].includes(mode) || !commonDir || (mode === 'release' && !value)) {
    usage();
    process.exitCode = 2;
    return;
  }

  let root;
  try {
    root = admissionRoot(commonDir);
    if (mode === 'acquire') {
      const ownerPid = value === undefined ? process.ppid : Number(value);
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
        throw new TypeError('owner pid must be a positive integer');
      }
      console.log(await acquire(root, ownerPid));
    } else {
      release(root, value);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error instanceof TypeError ? 2 : 1;
  }
}

await main();
