/**
 * Cloud-prefs schema migrations, isolated from cloud-prefs-sync.ts so they
 * stay testable without importing the full sync runtime (which transitively
 * pulls in `import.meta.env.DEV` via `@/services/clerk` → proxy.ts and
 * fails outside a Vite build).
 *
 * Each migration is a pure function from blob → blob. The map is keyed by
 * the TARGET schema version (so MIGRATIONS[N] runs when going from N-1 → N).
 */

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

/**
 * Schema-2 migrations map. Used both inline by cloud-prefs-sync.ts (against
 * the variant-aware FEEDS) and by tests (against fixture FEEDS).
 */
export function buildMigrations(
  feedsByCategory: FeedsByCategory,
): Record<number, (data: Record<string, unknown>) => Record<string, unknown>> {
  return {
    2: (data) => migrateDisabledFeedsV2(data, feedsByCategory),
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
