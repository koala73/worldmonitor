/**
 * Case-file (dossier) cache logic for ForecastPanel (#5300).
 *
 * The bootstrap feed carries the forecast LIST without `caseFile` — the dossiers were
 * 78% of the old payload. The panel fetches them lazily on first expand, which makes
 * its state genuinely stateful across refresh ticks, and that state is where the bugs
 * live:
 *
 *   - A refresh tick re-hydrates from the bootstrap feed, so any dossier already fetched
 *     must be re-merged or the pane the user has open re-renders EMPTY.
 *   - The fetch is de-duped by a latched promise. If a refresh introduces a forecast the
 *     completed fetch never covered, that latch must drop or the new pane resolves
 *     instantly against the old promise and stays empty forever.
 *   - But a forecast that legitimately has NO dossier is still "covered". Keying the
 *     refetch decision off a missing `caseFile` alone would refetch the whole feed on
 *     every click of such a pane.
 *
 * These are pure state transitions, extracted here so they are unit-testable: this repo
 * has no jsdom, so ForecastPanel itself can only be source-scanned. Leaf module — it must
 * stay import-free so `tsx --test` can load it without Vite's `import.meta.env`.
 */

interface HasCaseFile<C> {
  id: string;
  caseFile?: C;
  hasCaseFile?: boolean;
}

/**
 * Re-merge already-fetched dossiers into a freshly-hydrated list. Returns `forecasts`
 * untouched when nothing is cached, so the common (pre-fetch) path allocates nothing.
 */
export function mergeCachedCaseFiles<C, T extends HasCaseFile<C>>(
  forecasts: T[],
  cached: ReadonlyMap<string, C>,
): T[] {
  if (cached.size === 0) return forecasts;
  return forecasts.map((f) => {
    const caseFile = cached.get(f.id);
    return !f.caseFile && caseFile ? { ...f, caseFile } : f;
  });
}

/**
 * Should the next expand re-fetch the dossier feed?
 *
 * Only once the previous fetch has SETTLED (nulling an in-flight promise would merely
 * duplicate it), and only when the list holds a forecast that fetch never covered.
 */
export function needsCaseFileRefetch<C>(
  forecasts: readonly HasCaseFile<C>[],
  fetchedIds: ReadonlySet<string>,
  settled: boolean,
): boolean {
  if (!settled) return false;
  return forecasts.some((f) => !fetchedIds.has(f.id));
}

/**
 * A stripped dashboard row carries this marker only when the canonical feed has
 * a dossier for it. Do not download the full feed for an intentionally empty pane.
 */
export function shouldFetchCaseFile<C>(
  forecast: HasCaseFile<C> | undefined,
  detailIsOpen: boolean,
  detailIsEmpty: boolean,
): boolean {
  return detailIsOpen && detailIsEmpty && forecast?.hasCaseFile === true;
}
