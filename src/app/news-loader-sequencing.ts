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
  allowDigestPendingFallback: boolean;
  recordBaselineSample: boolean;
}

export interface NewsIntelLoadOptions {
  recordBaselineSample: boolean;
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
  allowPendingPerFeedFallback?: boolean;
  hasDigestCategory: (digest: TDigest, key: string) => boolean;
  loadCategory: (
    category: NewsCategorySpec<TFeeds>,
    digest: TDigest | null,
    options: NewsCategoryLoadOptions,
  ) => Promise<TItem[]>;
  loadIntel?: (
    digest: TDigest | null,
    allowDigestPendingFallback: boolean,
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
  allowPendingPerFeedFallback = true,
): Promise<Array<PromiseSettledResult<NewsCategoryLoadResult<TItem>>>> {
  const concurrency = Math.max(1, Math.min(categoryConcurrency, Math.max(1, categories.length)));
  const results: Array<PromiseSettledResult<NewsCategoryLoadResult<TItem>>> = [];
  const allowDigestPendingFallback = allowPendingPerFeedFallback && digestSnapshot.pending && digestSnapshot.digest === null;
  const recordBaselineSample = !digestSnapshot.pending;

  for (let i = 0; i < categories.length; i += concurrency) {
    const chunk = categories.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(async category => ({
        key: category.key,
        items: await loadCategory(category, digestSnapshot.digest, {
          allowDigestPendingFallback,
          recordBaselineSample,
        }),
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
  const allowPendingPerFeedFallback = options.allowPendingPerFeedFallback ?? true;
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
    allowPendingPerFeedFallback,
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
    ? await options.loadIntel(
      initialDigest.digest,
      allowPendingPerFeedFallback && initialDigest.pending && initialDigest.digest === null,
      { recordBaselineSample: !initialDigest.pending },
    )
    : [];
  let finalDigest = initialDigest.digest;

  if (initialDigest.pending) {
    finalDigest = await digestPromise;
    if (finalDigest) {
      const latestDigest = finalDigest;
      const digestCategories = options.categories.filter(
        ({ key, isCustom }) => !isCustom && options.hasDigestCategory(latestDigest, key),
      );
      const digestResults = await loadNewsCategoryBatches(
        digestCategories,
        options.categoryConcurrency,
        { digest: latestDigest, pending: false },
        options.loadCategory,
        allowPendingPerFeedFallback,
      );
      digestResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          categoryItemsByKey.set(result.value.key, result.value.items);
        } else {
          options.onDigestRefreshError?.(digestCategories[idx]?.key, result.reason);
        }
      });

      if (options.loadIntel && options.hasDigestCategory(latestDigest, 'intel')) {
        intelItems = await options.loadIntel(latestDigest, false, { recordBaselineSample: true });
      }
    }
  }

  return { categoryItemsByKey, intelItems, initialDigest, finalDigest };
}
