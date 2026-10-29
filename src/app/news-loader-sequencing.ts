export interface NewsDigestSnapshot<TDigest> {
  digest: TDigest | null;
  pending: boolean;
}

export interface NewsCategorySpec<TFeeds> {
  key: string;
  feeds: TFeeds;
  isCustom?: boolean;
}

export interface NewsCategoryLoadOptions {
  recordBaselineSample: boolean;
  /** A fresher digest is still in flight; the pass reloads once it settles. */
  digestPending: boolean;
}

export interface NewsIntelLoadOptions {
  recordBaselineSample: boolean;
  digestPending: boolean;
}

export interface NewsCategoryLoadResult<TItem> {
  key: string;
  items: TItem[];
}

export interface RunNewsLoadPassOptions<TFeeds, TDigest, TItem> {
  categories: readonly NewsCategorySpec<TFeeds>[];
  categoryConcurrency: number;
  digestPromise: Promise<TDigest | null>;
  fallbackDigest?: TDigest | null;
  digestGraceMs: number;
  loadCategory: (
    category: NewsCategorySpec<TFeeds>,
    digest: TDigest | null,
    options: NewsCategoryLoadOptions,
  ) => Promise<TItem[]>;
  loadIntel?: (
    digest: TDigest | null,
    options: NewsIntelLoadOptions,
  ) => Promise<TItem[]>;
  onCategoryError?: (key: string | undefined, reason: unknown) => void;
  onDigestRefreshError?: (key: string | undefined, reason: unknown) => void;
}

export interface RunNewsLoadPassResult<TDigest, TItem> {
  categoryItemsByKey: Map<string, TItem[]>;
  intelItems: TItem[];
  initialDigest: NewsDigestSnapshot<TDigest>;
  finalDigest: TDigest | null;
}

type Delay = (ms: number) => Promise<void>;

/**
 * Order-independent signature of a resolved news work-list.
 *
 * `loadAllData()` uses it to tell a trigger that genuinely changes WHAT news to
 * load (tab switch, mission preset, panel toggle, source toggle) from one that
 * changes nothing (viewport entry, scroll, playback exit). Nothing about the news
 * load is viewport-gated, so re-running it on every trigger only re-fetched the
 * digest — twice per page load in production, because loadAllData's drain loop
 * re-runs the whole task list when a second call arrives while the first is in
 * flight (#5376).
 *
 * It must cover EVERY input the load filters on, or a change the signature can't
 * see becomes a change the user can't get. Both inputs are here: the category set,
 * and the disabled-source set that `loadNewsCategory` filters each category's feeds
 * by. Nothing in the settings source toggle reloads news itself, so leaving sources
 * out meant a source switched off stayed on screen until the 20-minute refresh.
 *
 * The two are serialized as separate arrays rather than concatenated, so a
 * category key can never combine with a source name to spoof a different pair.
 *
 * `disabledSources` is REQUIRED, with no empty default: a caller that forgets it
 * would silently rebuild the source-blind signature this exists to replace, and
 * that failure is invisible at runtime.
 */
export function newsWorkListSignature(
  categories: readonly { key: string }[],
  disabledSources: Iterable<string>,
): string {
  return JSON.stringify([
    [...new Set(categories.map(category => category.key))].sort(),
    [...new Set(disabledSources)].sort(),
  ]);
}

const defaultDelay: Delay = (ms) => new Promise(resolve => {
  setTimeout(resolve, Math.max(0, ms));
});

export async function resolveInitialNewsDigest<TDigest>(
  digestPromise: Promise<TDigest | null>,
  graceMs: number,
  delay: Delay = defaultDelay,
  fallbackDigest: TDigest | null = null,
): Promise<NewsDigestSnapshot<TDigest>> {
  const trackedDigest = digestPromise.then(
    value => ({ status: 'fulfilled' as const, value }),
    reason => ({ status: 'rejected' as const, reason }),
  );

  const timeout = delay(graceMs).then(() => ({ status: 'timeout' as const }));
  const first = await Promise.race([trackedDigest, timeout]);

  if (first.status === 'rejected') {
    return { digest: fallbackDigest, pending: false };
  }

  if (first.status === 'fulfilled') {
    return { digest: first.value ?? fallbackDigest, pending: false };
  }

  return { digest: fallbackDigest, pending: true };
}

export async function loadNewsCategoryBatches<TFeeds, TDigest, TItem>(
  categories: readonly NewsCategorySpec<TFeeds>[],
  categoryConcurrency: number,
  digestSnapshot: NewsDigestSnapshot<TDigest>,
  loadCategory: (
    category: NewsCategorySpec<TFeeds>,
    digest: TDigest | null,
    options: NewsCategoryLoadOptions,
  ) => Promise<TItem[]>,
): Promise<Array<PromiseSettledResult<NewsCategoryLoadResult<TItem>>>> {
  const concurrency = Math.max(1, Math.min(categoryConcurrency, Math.max(1, categories.length)));
  const results: Array<PromiseSettledResult<NewsCategoryLoadResult<TItem>>> = [];
  const recordBaselineSample = !digestSnapshot.pending;
  const digestPending = digestSnapshot.pending;

  for (let i = 0; i < categories.length; i += concurrency) {
    const chunk = categories.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(async category => ({
        key: category.key,
        items: await loadCategory(category, digestSnapshot.digest, { recordBaselineSample, digestPending }),
      })),
    );
    results.push(...chunkResults);
  }

  return results;
}

export async function runNewsLoadPass<TFeeds, TDigest, TItem>(
  options: RunNewsLoadPassOptions<TFeeds, TDigest, TItem>,
): Promise<RunNewsLoadPassResult<TDigest, TItem>> {
  const digestPromise = options.digestPromise.catch(() => null);
  const initialDigest = await resolveInitialNewsDigest(
    digestPromise,
    options.digestGraceMs,
    undefined,
    options.fallbackDigest ?? null,
  );
  const categoryResults = await loadNewsCategoryBatches(
    options.categories,
    options.categoryConcurrency,
    initialDigest,
    options.loadCategory,
  );
  const categoryItemsByKey = new Map<string, TItem[]>();
  categoryResults.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      categoryItemsByKey.set(result.value.key, result.value.items);
    } else {
      options.onCategoryError?.(options.categories[idx]?.key, result.reason);
    }
  });

  let intelItems = options.loadIntel
    ? await options.loadIntel(initialDigest.digest, {
      recordBaselineSample: !initialDigest.pending,
      digestPending: initialDigest.pending,
    })
    : [];
  let finalDigest = initialDigest.digest;

  if (initialDigest.pending) {
    // Settle every preset category against the digest this load ended with:
    // the ones it carries render from it, and the ones it does not (every one,
    // when it never arrived) take the stale or outage path they waited on.
    // Cross-edition panels read other editions' digests, not this one.
    finalDigest = await digestPromise;
    const digestCategories = options.categories.filter(({ isCustom }) => !isCustom);
    const digestResults = await loadNewsCategoryBatches(
      digestCategories,
      options.categoryConcurrency,
      { digest: finalDigest, pending: false },
      options.loadCategory,
    );
    digestResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        categoryItemsByKey.set(result.value.key, result.value.items);
      } else {
        options.onDigestRefreshError?.(digestCategories[idx]?.key, result.reason);
      }
    });

    if (options.loadIntel) {
      intelItems = await options.loadIntel(finalDigest, { recordBaselineSample: true, digestPending: false });
    }
  }

  return { categoryItemsByKey, intelItems, initialDigest, finalDigest };
}
