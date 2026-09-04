/**
 * Cloud-prefs schema migrations and conflict-merge, isolated from
 * cloud-prefs-sync.ts so they stay testable without importing the full sync
 * runtime (which transitively pulls in `import.meta.env.DEV` via
 * `@/services/clerk` → proxy.ts and fails outside a Vite build).
 *
 * Each migration is a pure function from blob → blob. The map is keyed by
 * the TARGET schema version (so MIGRATIONS[N] runs when going from N-1 → N).
 */

import type { RegionalFeedRolloutMigrationTarget } from '@/services/regional-feed-rollout';
import { findFullyDisabledCategories, type FeedsByCategory } from '@/services/source-cap';

/**
 * Apply all migrations from `fromVersion + 1` up through `toVersion`
 * inclusive. Pure function — no I/O. Caller controls migrations map and
 * feeds context. Extracted for direct testing without pulling in the
 * cloud-prefs-sync runtime (which has a Vite-env transitive import).
 */
export function applyMigrationChain(
  data: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  migrations: Record<number, (data: Record<string, unknown>) => Record<string, unknown>>,
): Record<string, unknown> {
  let result = data;
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    result = migrations[v]?.(result) ?? result;
  }
  return result;
}

export interface MigrationChainResult {
  data: Record<string, unknown>;
  schemaVersion: number;
}

/**
 * Apply a migration chain while allowing a caller to fail closed before a
 * particular step. The returned version is the last contiguous migration that
 * actually ran, so a blocked step remains retryable on the next sync. A caller
 * may continue into later independent migrations while keeping the blocked
 * step retryable by passing `continueAfterBlockedMigration`.
 */
export function applyMigrationChainWithSchemaVersion(
  data: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  migrations: Record<number, (data: Record<string, unknown>) => Record<string, unknown>>,
  shouldStopBefore?: (version: number, data: Record<string, unknown>) => boolean,
  continueAfterBlockedMigration = false,
): MigrationChainResult {
  let result = data;
  let schemaVersion = fromVersion;
  let blocked = false;
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    if (shouldStopBefore?.(v, result)) {
      if (continueAfterBlockedMigration) {
        blocked = true;
        continue;
      }
      break;
    }
    result = migrations[v]?.(result) ?? result;
    if (!blocked) schemaVersion = v;
  }
  return { data: result, schemaVersion };
}

/**
 * Conflict-resolution merge for cloud-prefs sync.
 *
 * When a POST to /api/user-prefs hits a 409 (the cloud row advanced under
 * us), the local edits the user JUST made must not be discarded. The old
 * behaviour fetched the fresh cloud row and overwrote localStorage with it
 * wholesale — silently destroying, e.g., a watchlist the user typed seconds
 * earlier. This merge resolves the conflict without data loss:
 *
 *   - Start from the fresh cloud blob (so a concurrent change from another
 *     device survives).
 *   - Overlay the keys the user changed locally since the last clean upload
 *     (`dirtyKeys`): a dirty key present in `localBlob` → the local value
 *     wins; a dirty key ABSENT from `localBlob` → the user removed it
 *     locally → drop it from the merge so the removal sticks.
 *
 * Pure function — no I/O. `cloudData` is the migrated cloud blob, `localBlob`
 * is the current localStorage snapshot, `dirtyKeys` is the set of sync keys
 * mutated locally since the last clean upload. Extracted here (not in
 * cloud-prefs-sync.ts) so it stays unit-testable without the sync runtime.
 */
export function mergeCloudWithLocalDirty(
  cloudData: Record<string, unknown>,
  localBlob: Record<string, string>,
  dirtyKeys: Iterable<string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, val] of Object.entries(cloudData)) {
    if (typeof val === 'string') merged[key] = val;
  }
  for (const key of dirtyKeys) {
    if (Object.prototype.hasOwnProperty.call(localBlob, key)) {
      merged[key] = localBlob[key]!;
    } else {
      delete merged[key];
    }
  }
  return merged;
}

/**
 * After a successful upload, decide which dirty keys are now durably synced
 * and can be cleared — NOT the whole set.
 *
 * A user can mutate another pref *while the POST is in flight*: the setItem
 * patch marks it dirty, but it was never in `postedBlob`. Blanket-clearing
 * the dirty set would drop that tracking, so a subsequent 409 would see an
 * empty dirty set and mergeCloudWithLocalDirty would let the cloud blob
 * clobber the just-made edit — reintroducing the exact data-loss bug the
 * dirty set exists to prevent.
 *
 * A key is "settled" iff the value the server accepted (`postedBlob`) still
 * equals the current local value (`localBlob`). Absence counts as null on
 * both sides, so a synced *removal* settles too. A key changed mid-flight,
 * or dirtied mid-flight and absent from `postedBlob`, fails the equality
 * check and is NOT returned — it stays dirty for the next upload.
 *
 * Pure function — no I/O. Returns the subset of `dirtyKeys` safe to clear.
 */
export function settledDirtyKeys(
  postedBlob: Record<string, string>,
  localBlob: Record<string, string>,
  dirtyKeys: Iterable<string>,
): string[] {
  const settled: string[] = [];
  for (const key of dirtyKeys) {
    const posted = Object.prototype.hasOwnProperty.call(postedBlob, key) ? postedBlob[key]! : null;
    const local = Object.prototype.hasOwnProperty.call(localBlob, key) ? localBlob[key]! : null;
    if (posted === local) settled.push(key);
  }
  return settled;
}

/**
 * #4746: read-modify-write projection for ADDING dirty keys. Two same-user
 * tabs share one persisted marker set; a wholesale overwrite by the second
 * tab drops the first tab's pending markers. Union with whatever the entry
 * already holds (empty for another user's entry — parsePersistedDirtyKeys
 * refuses cross-user reads — so the write correctly re-scopes it).
 */
export function unionPersistedDirtyKeys(
  raw: string | null,
  allowedKeys: Iterable<string>,
  userId: string,
  additions: Iterable<string>,
): { userId: string; keys: string[] } {
  const merged = new Set(parsePersistedDirtyKeys(raw, allowedKeys, userId));
  const allowed = new Set(allowedKeys);
  for (const key of additions) {
    if (typeof key === 'string' && allowed.has(key)) merged.add(key);
  }
  return { userId, keys: [...merged] };
}

/**
 * #4746: read-modify-write projection for SETTLING dirty keys. Removes only
 * the settled keys; a wholesale overwrite here would resurrect nothing but
 * could drop another tab's still-pending markers.
 */
export function withoutPersistedDirtyKeys(
  raw: string | null,
  allowedKeys: Iterable<string>,
  userId: string,
  removals: Iterable<string>,
): { userId: string; keys: string[] } {
  const remove = new Set(removals);
  const keys = parsePersistedDirtyKeys(raw, allowedKeys, userId)
    .filter((key) => !remove.has(key));
  return { userId, keys };
}

export function parsePersistedDirtyKeys(
  raw: string | null,
  allowedKeys: Iterable<string>,
  expectedUserId: string,
): string[] {
  if (!raw) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { userId?: unknown }).userId !== expectedUserId ||
    !Array.isArray((parsed as { keys?: unknown }).keys)
  ) {
    return [];
  }

  const allowed = new Set(allowedKeys);
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of (parsed as { keys: unknown[] }).keys) {
    if (typeof key !== 'string' || !allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Schema migrations map. Used both inline by cloud-prefs-sync.ts (against the
 * variant-aware FEEDS) and by tests (against fixture FEEDS).
 */
export interface CloudPrefsMigrationOptions {
  frontline?: {
    legacyDefaultDisabled?: ReadonlySet<string>;
    names?: ReadonlySet<string>;
    legacyCapDisabled?: ReadonlySet<string>;
  };
  strategic?: {
    legacyDefaultDisabled?: ReadonlySet<string>;
    names?: ReadonlySet<string>;
    legacyCapDisabled?: ReadonlySet<string>;
    legacyDisabledStates?: ReadonlyArray<ReadonlySet<string>>;
  };
  regionalRollout?: {
    targets?: ReadonlyArray<RegionalFeedRolloutMigrationTarget>;
  };
  canadaArctic?: {
    optInSources?: ReadonlyArray<string>;
  };
  canadaDepth?: {
    optInSources?: ReadonlyArray<string>;
  };
  crisisDesk?: {
    optInSources?: ReadonlyArray<string>;
  };
}

export function buildMigrations(
  feedsByCategory: FeedsByCategory,
  options: CloudPrefsMigrationOptions = {},
): Record<number, (data: Record<string, unknown>) => Record<string, unknown>> {
  const frontline = options.frontline ?? {};
  const strategic = options.strategic ?? {};
  const regionalRollout = options.regionalRollout ?? {};
  const canadaArctic = options.canadaArctic ?? {};
  const canadaDepth = options.canadaDepth ?? {};
  const crisisDesk = options.crisisDesk ?? {};
  return {
    2: (data) => migrateDisabledFeedsV2(data, feedsByCategory),
    3: (data) => migrateFrontlineEuropeDefaultsV3(
      data,
      frontline.legacyDefaultDisabled ?? new Set(),
      frontline.names ?? new Set(),
      frontline.legacyCapDisabled ?? new Set(),
    ),
    4: (data) => migrateStrategicDefaultsV4(
      data,
      strategic.legacyDefaultDisabled ?? new Set(),
      strategic.names ?? new Set(),
      strategic.legacyCapDisabled ?? new Set(),
      strategic.legacyDisabledStates ?? [],
    ),
    5: (data) => migrateRegionalFeedRolloutDefaultsV5(
      data,
      regionalRollout.targets ?? [],
    ),
    6: (data) => migrateCanadaArcticOptInsV6(data, canadaArctic.optInSources ?? []),
    7: (data) => migrateCanadaDepthOptInsV7(data, canadaDepth.optInSources ?? []),
    8: (data) => migrateCrisisDeskOptInsV8(data, crisisDesk.optInSources ?? []),
  };
}

/**
 * Schema-2 migration body, kept separate for direct unit testing.
 *
 * Schema 2 (2026-05-01): one-shot recovery for the v1 free-tier source-cap
 * bug. The pre-PR-3521 alphabetical-slice cap auto-disabled every source
 * past position 80 alphabetically, leaving entire late-alphabet categories
 * (Layoffs, Semiconductors, IPO, Funding, Product Hunt, …) with 100% of
 * their feeds in `disabledFeeds`. PR #3521 added a per-origin localStorage
 * migration to recover this, but cloud-prefs sync re-poisoned origins
 * every load by overwriting localStorage with the still-bad cloud blob —
 * the recovery had to live at the cloud-data layer to be permanent.
 *
 * This migration runs ONCE per cloud row (gated by schemaVersion < 2),
 * detects categories where 100% of sources are in `disabledFeeds`, and
 * re-enables them. After the migration completes, schemaVersion bumps to
 * 2 and subsequent sync pulls skip recovery — so a user who explicitly
 * disables every source in a category POST-migration keeps that
 * preference forever. The 100%-disabled-category heuristic is targeted
 * enough that explicit single-source disabling is preserved.
 *
 * The recovery uses the variant-aware FEEDS passed in by the caller; the
 * cloud blob is variant-scoped (per /api/user-prefs?variant=...) so the
 * caller-supplied FEEDS already matches the row's variant.
 */
export function migrateDisabledFeedsV2(
  data: Record<string, unknown>,
  feedsByCategory: FeedsByCategory,
): Record<string, unknown> {
  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return data;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return data; }
  if (!Array.isArray(parsed) || parsed.length === 0) return data;

  const disabledStrings = parsed.filter((n): n is string => typeof n === 'string');
  const recoverable = findFullyDisabledCategories(feedsByCategory, new Set(disabledStrings));
  if (recoverable.length === 0) return data;

  const recoveredSet = new Set(recoverable);
  const cleaned = parsed.filter(
    (n) => typeof n !== 'string' || !recoveredSet.has(n),
  );
  console.log(
    `[cloud-prefs] schema-2 migration: re-enabled ${recoverable.length} source(s) from fully-disabled categories`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(cleaned) };
}

function hasExactStringSet(values: unknown[], expected: ReadonlySet<string>): boolean {
  if (values.length !== expected.size) return false;
  const actual = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') return false;
    actual.add(value);
  }
  if (actual.size !== expected.size) return false;
  for (const value of expected) {
    if (!actual.has(value)) return false;
  }
  return true;
}

/**
 * Schema-3 migration body for #5949/#5963.
 *
 * The old v3 source-reduction defaults stored the five frontline sources in
 * `disabledFeeds`, and the first protected-cap rollout could append the same
 * names to its exact persisted cap result. Only an exact match to one of
 * those untouched legacy sets is safe to migrate: any extra or missing entry
 * indicates that the user customized source preferences, so the migration
 * leaves the blob alone rather than overriding explicit choices. The
 * exact-match guard also makes this safe when a stale cloud row is applied
 * after the local startup migration.
 */
export function migrateFrontlineEuropeDefaultsV3(
  data: Record<string, unknown>,
  legacyDefaultDisabled: ReadonlySet<string>,
  frontlineNames: ReadonlySet<string>,
  legacyCapDisabled: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (
    (legacyDefaultDisabled.size === 0 && legacyCapDisabled.size === 0)
    || frontlineNames.size === 0
  ) return data;
  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return data;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return data; }
  if (
    !Array.isArray(parsed)
    || (!hasExactStringSet(parsed, legacyDefaultDisabled) && !hasExactStringSet(parsed, legacyCapDisabled))
  ) return data;

  const cleaned = parsed.filter(
    (name) => typeof name !== 'string' || !frontlineNames.has(name),
  );
  if (cleaned.length === parsed.length) return data;

  console.log(
    `[prefs] schema-3 migration: re-enabled ${parsed.length - cleaned.length} frontline source(s) from an untouched legacy default/cap state`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(cleaned) };
}

/**
 * Schema-4 migration for PR #6000.
 *
 * Before strategic defaults were canonical, newly promoted feeds were present
 * in the untouched source-reduction disabled set. Only an exact match to that
 * old default or cap result is safe to rewrite. Callers may supply exact
 * locale-specific states because cloud rows do not retain the writing locale;
 * any extra or missing entry still means the user customized preferences, so
 * leave the blob alone.
 */
export function migrateStrategicDefaultsV4(
  data: Record<string, unknown>,
  legacyDefaultDisabled: ReadonlySet<string>,
  strategicDefaultNames: ReadonlySet<string>,
  legacyCapDisabled: ReadonlySet<string> = new Set(),
  additionalLegacyDisabledStates: ReadonlyArray<ReadonlySet<string>> = [],
): Record<string, unknown> {
  const recognizedStates = [
    legacyDefaultDisabled,
    legacyCapDisabled,
    ...additionalLegacyDisabledStates,
  ].filter((state) => state.size > 0);
  if (recognizedStates.length === 0 || strategicDefaultNames.size === 0) return data;
  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return data;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return data; }
  if (
    !Array.isArray(parsed)
    || !recognizedStates.some((state) => hasExactStringSet(parsed, state))
  ) return data;

  const cleaned = parsed.filter(
    (name) => typeof name !== 'string' || !strategicDefaultNames.has(name),
  );
  if (cleaned.length === parsed.length) return data;

  console.log(
    `[prefs] schema-4 migration: re-enabled ${parsed.length - cleaned.length} strategic default source(s) from an untouched legacy default/cap state`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(cleaned) };
}

interface RegionalFeedRolloutMigrationAnalysis {
  matchingTargets: ReadonlyArray<RegionalFeedRolloutMigrationTarget>;
  candidates: string[][];
  candidateKeys: Set<string>;
}

function analyzeRegionalFeedRolloutMigration(
  data: Record<string, unknown>,
  targets: ReadonlyArray<RegionalFeedRolloutMigrationTarget>,
): RegionalFeedRolloutMigrationAnalysis | null {
  if (targets.length === 0) return null;

  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return null;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  const matchingTargets = targets.filter(
    (target) => hasExactStringSet(parsed, target.legacyDisabled),
  );
  if (matchingTargets.length === 0) return null;

  const candidates = matchingTargets.map((target) => {
    const cleaned = parsed.filter(
      (name): name is string => typeof name === 'string' && !target.defaultNames.has(name),
    );
    return [...new Set([...cleaned, ...target.optInNames])];
  });
  const candidateKeys = new Set(
    candidates.map((candidate) => JSON.stringify([...candidate].sort())),
  );
  return { matchingTargets, candidates, candidateKeys };
}

/**
 * Whether schema 5 cannot safely infer the locale behind a cloud row.
 * Callers use this before advancing the row's schema marker; the migration
 * itself remains a pure data transform and continues to return the original
 * blob for ambiguous fingerprints.
 */
export function isRegionalFeedRolloutMigrationAmbiguous(
  data: Record<string, unknown>,
  targets: ReadonlyArray<RegionalFeedRolloutMigrationTarget>,
): boolean {
  const analysis = analyzeRegionalFeedRolloutMigration(data, targets);
  return analysis !== null && analysis.candidateKeys.size !== 1;
}

/**
 * Schema-5 migration for the #5975/#5976/#5977/#5980 regional feed wave,
 * including exact dormant-profile fingerprints from the immediately preceding
 * frontline and Ukraine-depth releases.
 *
 * Persisted source preferences are a denylist. Adding a feed therefore made
 * it enabled for every returning profile unless the new name was explicitly
 * inserted into `disabledFeeds`; the free cap could then persist the inverse
 * problem by disabling sources that the catalog declared default-on.
 *
 * The denylist does not record whether an entry came from the user or the cap,
 * so this migration never infers intent from individual names. Callers provide
 * exact untouched default/cap states reconstructed for the chronological
 * release paths. A single extra, missing, duplicated, or malformed entry makes
 * the state unrecognized and leaves it unchanged. That preserves every
 * deliberate post-rollout source toggle while repairing untouched profiles.
 */
export function migrateRegionalFeedRolloutDefaultsV5(
  data: Record<string, unknown>,
  targets: ReadonlyArray<RegionalFeedRolloutMigrationTarget>,
): Record<string, unknown> {
  const analysis = analyzeRegionalFeedRolloutMigration(data, targets);
  if (!analysis) return data;
  // The cloud row does not record the locale that produced its denylist. If
  // multiple locales share a fingerprint but require different outcomes,
  // preserve the row rather than guessing and overwriting user intent.
  if (analysis.candidateKeys.size !== 1) return data;

  const raw = data['worldmonitor-disabled-feeds'] as string;
  const reconciled = analysis.candidates[0]!;
  if (JSON.stringify(reconciled) === raw) return data;

  const target = analysis.matchingTargets[0]!;
  console.log(
    `[prefs] schema-5 migration: reconciled ${target.defaultNames.size} rollout default(s) and ${target.optInNames.size} opt-in source(s) for an untouched profile`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(reconciled) };
}

/**
 * Schema-6 migration for the Canada + Arctic/Nordic pack (#5960).
 *
 * The new companion feeds are catalog opt-ins. Because persisted source
 * preferences are a denylist, a non-empty returning profile must explicitly
 * receive those names or the catalog addition silently enables them. Empty or
 * malformed states are left untouched because they do not prove an untouched
 * returner fingerprint.
 */
export function migrateCanadaArcticOptInsV6(
  data: Record<string, unknown>,
  optInSources: ReadonlyArray<string>,
): Record<string, unknown> {
  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return data;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return data; }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((name) => typeof name !== 'string')
  ) return data;

  const existing = new Set(parsed);
  const updated = [...parsed];
  for (const name of optInSources) {
    if (!existing.has(name)) updated.push(name);
  }
  if (updated.length === parsed.length) return data;

  console.log(
    `[prefs] schema-6 migration: disabled ${updated.length - parsed.length} Canada/Arctic opt-in source(s)`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(updated) };
}

/**
 * Schema-7 migration for the Canada depth pack (#6604/#6605).
 *
 * Copy of migrateCanadaArcticOptInsV6: insert ONLY the new opt-in names.
 * Schema 6 already ran for returners; a new App.ts localStorage key alone
 * is not enough — cloud blobs need this version bump.
 */
export function migrateCanadaDepthOptInsV7(
  data: Record<string, unknown>,
  optInSources: ReadonlyArray<string>,
): Record<string, unknown> {
  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return data;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return data; }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((name) => typeof name !== 'string')
  ) return data;

  const existing = new Set(parsed);
  const updated = [...parsed];
  for (const name of optInSources) {
    if (!existing.has(name)) updated.push(name);
  }
  if (updated.length === parsed.length) return data;

  console.log(
    `[prefs] schema-7 migration: disabled ${updated.length - parsed.length} Canada depth opt-in source(s)`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(updated) };
}

/**
 * Schema-8 migration for the validated crisis-desk pack (#6813-#6830).
 *
 * Only the reviewed opt-in companions are inserted into a non-empty denylist.
 * English and strategic floor defaults remain enabled. Empty or malformed
 * states stay untouched because they do not prove a returning profile.
 */
export function migrateCrisisDeskOptInsV8(
  data: Record<string, unknown>,
  optInSources: ReadonlyArray<string>,
): Record<string, unknown> {
  const raw = data['worldmonitor-disabled-feeds'];
  if (typeof raw !== 'string') return data;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return data; }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((name) => typeof name !== 'string')
  ) return data;

  const existing = new Set(parsed);
  const updated = [...parsed];
  for (const name of optInSources) {
    if (!existing.has(name)) updated.push(name);
  }
  if (updated.length === parsed.length) return data;

  console.log(
    `[prefs] schema-8 migration: disabled ${updated.length - parsed.length} crisis-desk opt-in source(s)`,
  );
  return { ...data, 'worldmonitor-disabled-feeds': JSON.stringify(updated) };
}
