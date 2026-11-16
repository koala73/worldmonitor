// Rolling history of orbit elements for the profiled imaging satellites (#9110).
//
// The catalog's daily ring keeps one snapshot per UTC day for 8 days and ships to every
// Orbital Watch browser. Manoeuvre detection needs every new epoch over a longer window and
// only the seeder reads it, so it lives in R2, not Redis. One entry per satellite per epoch.
import { historyEntryFromOmm, isHistoryEntry } from './_orbital-maneuvers.mjs';

export const ORBITAL_HISTORY_R2_KEY = 'seed-data/orbital/elements-history-v1.json';
export const HISTORY_SCHEMA = 1;
export const HISTORY_DAYS = 30;

const DAY_MS = 86_400_000;

function entryKey(entry) {
  return `${entry.noradId}:${entry.epoch}`;
}

/**
 * Throws when a stored history is present but not one this code wrote, including one with any
 * entry it cannot read (an ISO-string epoch, a missing element), so the caller never replaces
 * history it cannot read with a fresh, shorter one.
 */
export function assertReadableHistory(previous) {
  if (previous == null) return;
  if (typeof previous !== 'object' || previous.schema !== HISTORY_SCHEMA || !Array.isArray(previous.entries)) {
    throw new Error(`orbital elements history has an unreadable shape (schema ${previous?.schema ?? 'missing'})`);
  }
  const unreadable = previous.entries.findIndex((entry) => !isHistoryEntry(entry));
  if (unreadable !== -1) throw new Error(`orbital elements history has an unreadable entry at index ${unreadable}`);
}

/**
 * Adds an entry for each satellite whose epoch is not held yet, drops entries whose epoch is
 * older than the window, and orders by NORAD id then epoch. `changed` is false when there is
 * nothing to write.
 */
export function mergeHistory(previous, satellites, nowMs, historyDays = HISTORY_DAYS) {
  assertReadableHistory(previous);
  const oldestEpoch = nowMs - historyDays * DAY_MS;
  const held = (previous?.entries ?? []).filter((entry) => Number.isFinite(entry?.epoch));
  const kept = held.filter((entry) => entry.epoch >= oldestEpoch);
  const byKey = new Map(kept.map((entry) => [entryKey(entry), entry]));
  let added = 0;
  for (const satellite of Array.isArray(satellites) ? satellites : []) {
    const entry = historyEntryFromOmm(satellite?.elements);
    if (!entry || entry.epoch < oldestEpoch || entry.epoch > nowMs + DAY_MS) continue;
    const key = entryKey(entry);
    if (byKey.has(key)) continue;
    byKey.set(key, entry);
    added++;
  }
  const entries = [...byKey.values()].sort((a, b) => a.noradId - b.noradId || a.epoch - b.epoch);
  return {
    history: { schema: HISTORY_SCHEMA, windowDays: historyDays, updatedAt: nowMs, entries },
    added,
    pruned: held.length - kept.length,
    changed: added > 0 || held.length !== kept.length || previous == null,
  };
}
