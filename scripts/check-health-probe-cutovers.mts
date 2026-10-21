import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isUtcIsoInstant,
  validateAcceptanceBaseline,
} from './check-seed-freshness.mjs';

const BASELINE_URL = new URL('./seed-freshness-baseline.json', import.meta.url);
const HEALTH_URL = new URL('../api/health.js', import.meta.url);

type JsonRecord = Record<string, unknown>;

export interface CutoverValidationInput {
  baseSeedMeta: unknown;
  headSeedMeta: unknown;
  baseline: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function seedMetaKey(config: unknown): string | null {
  return isRecord(config) && typeof config.key === 'string' ? config.key : null;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Require every new or repointed SEED_META probe to declare how deployment
 * avoids the predictable EMPTY window before its producer first publishes.
 *
 * Pre-seed evidence lives beside the changed probe, so it is bound to the
 * exact fromKey transition. The alternative is an owner-bound baseline entry
 * whose expiry cannot outlive the first scheduled producer run.
 */
export function validateHealthProbeCutovers({
  baseSeedMeta,
  headSeedMeta,
  baseline,
}: CutoverValidationInput) {
  if (!isRecord(baseSeedMeta)) {
    throw new Error('Base SEED_META must be an object');
  }
  if (!isRecord(headSeedMeta)) {
    throw new Error('Head SEED_META must be an object');
  }
  validateAcceptanceBaseline(baseline);
  if (!isRecord(baseline) || !Array.isArray(baseline.acknowledged)) {
    throw new Error('Acceptance baseline must contain an acknowledged array');
  }

  const changed: Array<{
    name: string;
    fromKey: string | null;
    toKey: string;
    mode: 'preseed' | 'expiring-ack' | 'activation-marker';
  }> = [];
  for (const [name, config] of Object.entries(headSeedMeta)) {
    const toKey = seedMetaKey(config);
    if (!toKey) {
      throw new Error(`SEED_META.${name} needs a string key`);
    }
    const fromKey = seedMetaKey(baseSeedMeta[name]);
    if (fromKey === toKey) continue;

    const cutover = isRecord(config) ? config.cutover : null;
    if (!isRecord(cutover)) {
      throw new Error(
        `Health probe ${name} (${fromKey ?? '<new>'} -> ${toKey}) needs machine-readable pre-seed evidence, a durable activation marker, or an expiring acknowledgement`,
      );
    }
    if (cutover.fromKey !== fromKey) {
      throw new Error(
        `Health probe ${name} cutover.fromKey must equal ${fromKey ?? 'null'} for this transition`,
      );
    }
    if (!Number.isInteger(cutover.issue)) {
      throw new Error(`Health probe ${name} cutover needs an owner issue number`);
    }

    if (cutover.mode === 'preseed') {
      if (!isUtcIsoInstant(cutover.verifiedAt)) {
        throw new Error(`Health probe ${name} pre-seed evidence needs a valid UTC ISO verifiedAt instant`);
      }
      const evidence = cutover.evidence;
      if (
        !isRecord(evidence)
        || evidence.platform !== 'railway'
        || typeof evidence.service !== 'string'
        || evidence.service.trim().length === 0
        || evidence.probeKey !== toKey
        || evidence.compactHealthStatus !== 'OK'
        || !isHttpsUrl(evidence.reference)
      ) {
        throw new Error(
          `Health probe ${name} pre-seed evidence must identify Railway, its service, probe ${toKey}, compact health OK, and an HTTPS reference`,
        );
      }
    } else if (cutover.mode === 'activation-marker') {
      if (
        typeof cutover.activationKey !== 'string'
        || !/^seed-activated:[a-z0-9][a-z0-9:-]*$/.test(cutover.activationKey)
        || config.activationKey !== cutover.activationKey
      ) {
        throw new Error(
          `Health probe ${name} activation-marker cutover must bind config.activationKey to an exact seed-activated:* key`,
        );
      }
    } else if (cutover.mode === 'expiring-ack') {
      if (typeof cutover.status !== 'string' || cutover.status.trim().length === 0) {
        throw new Error(`Health probe ${name} expiring acknowledgement needs an exact health status`);
      }
      const acknowledgement = baseline.acknowledged.find((entry) => (
        isRecord(entry)
        && entry.name === name
        && entry.status === cutover.status
        && entry.issue === cutover.issue
        && isRecord(entry.cutover)
        && entry.cutover.probeKey === toKey
      ));
      if (!acknowledgement) {
        throw new Error(
          `Health probe ${name} needs an expiring acknowledgement for ${toKey} owned by #${cutover.issue}`,
        );
      }
    } else {
      throw new Error(`Health probe ${name} cutover mode must be preseed, activation-marker, or expiring-ack`);
    }

    changed.push({ name, fromKey, toKey, mode: cutover.mode });
  }
  return changed;
}

function resolveCommit(ref: string): string {
  return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Load the base revision's exported SEED_META registry in an isolated temporary module.
 */
async function readBaseSeedMeta(ref: string) {
  const commit = resolveCommit(ref);
  const source = execFileSync('git', ['show', `${commit}:api/health.js`], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const temporaryUrl = new URL(`../api/.health-cutover-base-${randomUUID()}.mjs`, import.meta.url);
  writeFileSync(temporaryUrl, source, { flag: 'wx' });
  try {
    const module = await import(temporaryUrl.href);
    if (!isRecord(module.__testing__) || !isRecord(module.__testing__.SEED_META)) {
      throw new Error(`api/health.js at ${commit} does not export __testing__.SEED_META`);
    }
    return { commit, seedMeta: module.__testing__.SEED_META };
  } finally {
    unlinkSync(temporaryUrl);
  }
}

async function main() {
  const baseRef = process.argv[2] || process.env.HEALTH_PROBE_CUTOVER_BASE || 'origin/main';
  const [{ commit, seedMeta: baseSeedMeta }, headModule] = await Promise.all([
    readBaseSeedMeta(baseRef),
    import(HEALTH_URL.href),
  ]);
  if (!isRecord(headModule.__testing__) || !isRecord(headModule.__testing__.SEED_META)) {
    throw new Error('Current api/health.js does not export __testing__.SEED_META');
  }
  const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
  const changed = validateHealthProbeCutovers({
    baseSeedMeta,
    headSeedMeta: headModule.__testing__.SEED_META,
    baseline,
  });
  if (changed.length === 0) {
    console.log(`Health-probe cutover check passed: no new or repointed probes since ${commit}.`);
    return;
  }
  for (const entry of changed) {
    console.log(
      `Health-probe cutover check passed: ${entry.name} ${entry.fromKey ?? '<new>'} -> ${entry.toKey} (${entry.mode}).`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
