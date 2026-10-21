/**
 * Version comparison for the desktop updater (#5908).
 *
 * Kept dependency-free and separate from `desktop-updater.ts` so the comparison
 * is directly unit-testable: the old inline `version.split('.').map(Number)`
 * produced `NaN` for any suffixed tag (`2.10.0-tech`), every `NaN` comparison is
 * false, so the updater concluded "no update" and logged it as such. That is a
 * silent, permanent stop-updating bug, and it was unobservable through the
 * updater's public surface.
 */

/**
 * Parses the numeric core of a version string.
 *
 * Accepts an optional `v` prefix and ignores any SemVer pre-release/build
 * suffix (`-tech`, `+build.7`), because those qualify a release rather than
 * order it. Returns `null` — never a partially-`NaN` array — when the numeric
 * core is absent or non-numeric, so callers are forced to handle the case.
 */
export function parseDesktopVersion(version: string): number[] | null {
  if (typeof version !== 'string') return null;

  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0];
  if (!core) return null;

  const segments = core.split('.');
  const parsed: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null;
    parsed.push(Number(segment));
  }
  return parsed;
}

/**
 * Returns whether `remote` orders after `current`, or `null` when either side
 * cannot be parsed.
 *
 * The `null` is the point: a boolean would collapse "you are up to date" and
 * "I have no idea what version that is" into the same silent answer.
 */
export function isNewerDesktopVersion(remote: string, current: string): boolean | null {
  const r = parseDesktopVersion(remote);
  const c = parseDesktopVersion(current);
  if (!r || !c) return null;

  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] ?? 0;
    const cv = c[i] ?? 0;
    if (rv > cv) return true;
    if (rv < cv) return false;
  }
  return false;
}

export type UpdateDecision = 'update_available' | 'no_update' | 'version_unparsable';

/**
 * The updater's three-way decision, extracted so it is directly testable.
 *
 * #5908's damage came from this decision having only two outcomes: an
 * unreadable version fell into "no_update" and the failure became invisible.
 * Keeping the mapping here means a regression that collapses the third outcome
 * fails a unit test instead of silently stranding every installed client.
 */
export function decideUpdateOutcome(remote: string, current: string): UpdateDecision {
  const newer = isNewerDesktopVersion(remote, current);
  if (newer === null) return 'version_unparsable';
  return newer ? 'update_available' : 'no_update';
}
