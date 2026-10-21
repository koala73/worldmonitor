import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadNewsCategoryBatches,
  newsWorkListSignature,
  resolveInitialNewsDigest,
  runNewsLoadPass,
  type NewsCategorySpec,
} from '../src/app/news-loader-sequencing';

interface TestDigest {
  categories: Record<string, unknown>;
  label?: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const neverDelay = () => new Promise<void>(() => {});

describe('news loader digest sequencing', () => {
  it('starts category work with pending-fallback permission before a slow digest settles', async () => {
    const digest = deferred<TestDigest | null>();
    let digestSettled = false;
    const digestPromise = digest.promise.then(value => {
      digestSettled = true;
      return value;
    });

    const initialDigest = await resolveInitialNewsDigest(
      digestPromise,
      0,
      async () => {},
    );

    assert.deepEqual(initialDigest, { digest: null, pending: true });

    const categories: Array<NewsCategorySpec<string[]>> = [
      { key: 'politics', feeds: ['Reuters'] },
      { key: 'energy', feeds: ['Oil Monitor'] },
    ];
    const starts: string[] = [];
    const results = await loadNewsCategoryBatches(
      categories,
      1,
      initialDigest,
      async (category, digestSnapshot, options) => {
        starts.push(`${category.key}:${options.allowDigestPendingFallback}`);
        assert.equal(digestSnapshot, null);
        assert.equal(options.allowDigestPendingFallback, true);
        assert.equal(options.recordBaselineSample, false);
        assert.equal(digestSettled, false);
        return [`${category.key}-item`];
      },
    );

    assert.deepEqual(starts, ['politics:true', 'energy:true']);
    assert.deepEqual(
      results.map(result => result.status === 'fulfilled' ? result.value : result),
      [
        { key: 'politics', items: ['politics-item'] },
        { key: 'energy', items: ['energy-item'] },
      ],
    );
    assert.equal(digestSettled, false);

    digest.resolve({ categories: {} });
    await digestPromise;
  });

  it('preserves the fast digest path when the digest resolves within the first-paint grace', async () => {
    const digest: TestDigest = { categories: { politics: {} } };
    const initialDigest = await resolveInitialNewsDigest(
      Promise.resolve(digest),
      250,
      neverDelay,
    );

    assert.equal(initialDigest.digest, digest);
    assert.equal(initialDigest.pending, false);

    const results = await loadNewsCategoryBatches(
      [{ key: 'politics', feeds: ['Reuters'] }],
      1,
      initialDigest,
      async (_category, digestSnapshot, options) => {
        assert.equal(digestSnapshot, digest);
        assert.equal(options.allowDigestPendingFallback, false);
        assert.equal(options.recordBaselineSample, true);
        return ['digest-item'];
      },
    );

    assert.equal(results[0]?.status, 'fulfilled');
    assert.deepEqual(
      results[0]?.status === 'fulfilled' ? results[0].value : undefined,
      { key: 'politics', items: ['digest-item'] },
    );
  });

  it('treats a resolved null digest as unavailable rather than still pending', async () => {
    const initialDigest = await resolveInitialNewsDigest<TestDigest>(
      Promise.resolve(null),
      250,
      neverDelay,
    );

    assert.deepEqual(initialDigest, { digest: null, pending: false });

    await loadNewsCategoryBatches(
      [{ key: 'politics', feeds: ['Reuters'] }],
      1,
      initialDigest,
      async (_category, digestSnapshot, options) => {
        assert.equal(digestSnapshot, null);
        assert.equal(options.allowDigestPendingFallback, false);
        assert.equal(options.recordBaselineSample, true);
        return [];
      },
    );
  });

  it('treats a rejected digest as unavailable rather than throwing', async () => {
    const initialDigest = await resolveInitialNewsDigest<TestDigest>(
      Promise.reject(new Error('digest unavailable')),
      250,
      neverDelay,
    );

    assert.deepEqual(initialDigest, { digest: null, pending: false });

    await loadNewsCategoryBatches(
      [{ key: 'politics', feeds: ['Reuters'] }],
      1,
      initialDigest,
      async (_category, digestSnapshot, options) => {
        assert.equal(digestSnapshot, null);
        assert.equal(options.allowDigestPendingFallback, false);
        assert.equal(options.recordBaselineSample, true);
        return [];
      },
    );
  });

  it('uses a fallback digest when the live digest rejects within the grace window', async () => {
    const fallbackDigest: TestDigest = { label: 'cached', categories: { politics: {} } };
    const initialDigest = await resolveInitialNewsDigest<TestDigest>(
      Promise.reject(new Error('digest unavailable')),
      250,
      neverDelay,
      fallbackDigest,
    );

    assert.deepEqual(initialDigest, { digest: fallbackDigest, pending: false });
  });

  it('does not bypass the per-feed fallback switch while a digest is pending', async () => {
    const results = await loadNewsCategoryBatches(
      [{ key: 'politics', feeds: ['Reuters'] }],
      1,
      { digest: null, pending: true },
      async (_category, digestSnapshot, options) => {
        assert.equal(digestSnapshot, null);
        assert.equal(options.allowDigestPendingFallback, false);
        assert.equal(options.recordBaselineSample, false);
        return [];
      },
      false,
    );

    assert.equal(results[0]?.status, 'fulfilled');
  });

  it('orchestrates slow-digest fallback, late digest refresh, and Intel refresh', async () => {
    const digest = deferred<TestDigest | null>();
    let digestSettled = false;
    const digestPromise = digest.promise.then(value => {
      digestSettled = true;
      return value;
    });
    const categoryStarted = deferred<void>();
    const releaseInitialCategory = deferred<void>();
    const events: string[] = [];

    const runPromise = runNewsLoadPass<string[], TestDigest, string>({
      categories: [{ key: 'politics', feeds: ['Reuters'] }],
      categoryConcurrency: 1,
      digestPromise,
      digestGraceMs: 0,
      hasDigestCategory: (digestSnapshot, key) => key in digestSnapshot.categories,
      loadCategory: async (category, digestSnapshot, options) => {
        events.push(`${category.key}:${digestSnapshot ? 'digest' : 'fallback'}:${options.allowDigestPendingFallback}`);
        if (!digestSnapshot) {
          categoryStarted.resolve();
          await releaseInitialCategory.promise;
          assert.equal(options.allowDigestPendingFallback, true);
          assert.equal(options.recordBaselineSample, false);
          assert.equal(digestSettled, false);
          return [`${category.key}-fallback`];
        }
        assert.equal(options.allowDigestPendingFallback, false);
        assert.equal(options.recordBaselineSample, true);
        return [`${category.key}-digest`];
      },
      loadIntel: async (digestSnapshot, allowDigestPendingFallback, options) => {
        events.push(`intel:${digestSnapshot ? 'digest' : 'fallback'}:${allowDigestPendingFallback}`);
        assert.equal(options.recordBaselineSample, Boolean(digestSnapshot));
        return [digestSnapshot ? 'intel-digest' : 'intel-fallback'];
      },
    });

    await categoryStarted.promise;
    assert.equal(digestSettled, false);

    releaseInitialCategory.resolve();
    await Promise.resolve();
    digest.resolve({ categories: { politics: {}, intel: {} } });

    const result = await runPromise;

    assert.deepEqual(events, [
      'politics:fallback:true',
      'intel:fallback:true',
      'politics:digest:false',
      'intel:digest:false',
    ]);
    assert.deepEqual(result.categoryItemsByKey.get('politics'), ['politics-digest']);
    assert.deepEqual(result.intelItems, ['intel-digest']);
    assert.equal(result.initialDigest.pending, true);
    assert.deepEqual(result.finalDigest, { categories: { politics: {}, intel: {} } });
  });

  it('uses fallback digest during timeout and still refreshes when the live digest arrives', async () => {
    const digest = deferred<TestDigest | null>();
    const cachedDigest: TestDigest = { label: 'cached', categories: { politics: {}, intel: {} } };
    const liveDigest: TestDigest = { label: 'live', categories: { politics: {}, intel: {} } };
    const initialCategoryLoaded = deferred<void>();
    const events: string[] = [];

    const runPromise = runNewsLoadPass<string[], TestDigest, string>({
      categories: [{ key: 'politics', feeds: ['Reuters'] }],
      categoryConcurrency: 1,
      digestPromise: digest.promise,
      fallbackDigest: cachedDigest,
      digestGraceMs: 0,
      allowPendingPerFeedFallback: false,
      hasDigestCategory: (digestSnapshot, key) => key in digestSnapshot.categories,
      loadCategory: async (category, digestSnapshot, options) => {
        events.push(`${category.key}:${digestSnapshot?.label ?? 'none'}:${options.allowDigestPendingFallback}:${options.recordBaselineSample}`);
        assert.ok(digestSnapshot);
        if (digestSnapshot.label === 'cached') {
          assert.equal(options.allowDigestPendingFallback, false);
          assert.equal(options.recordBaselineSample, false);
          initialCategoryLoaded.resolve();
        } else {
          assert.equal(options.allowDigestPendingFallback, false);
          assert.equal(options.recordBaselineSample, true);
        }
        return [`${category.key}-${digestSnapshot.label}`];
      },
      loadIntel: async (digestSnapshot, allowDigestPendingFallback, options) => {
        events.push(`intel:${digestSnapshot?.label ?? 'none'}:${allowDigestPendingFallback}:${options.recordBaselineSample}`);
        assert.ok(digestSnapshot);
        assert.equal(allowDigestPendingFallback, false);
        assert.equal(options.recordBaselineSample, digestSnapshot.label === 'live');
        return [`intel-${digestSnapshot.label}`];
      },
    });

    await initialCategoryLoaded.promise;
    digest.resolve(liveDigest);
    const result = await runPromise;

    assert.deepEqual(events, [
      'politics:cached:false:false',
      'intel:cached:false:false',
      'politics:live:false:true',
      'intel:live:false:true',
    ]);
    assert.deepEqual(result.categoryItemsByKey.get('politics'), ['politics-live']);
    assert.deepEqual(result.intelItems, ['intel-live']);
    assert.equal(result.initialDigest.digest, cachedDigest);
    assert.equal(result.initialDigest.pending, true);
    assert.equal(result.finalDigest, liveDigest);
  });

  it('preserves fallback results when a pending digest resolves null', async () => {
    const digest = deferred<TestDigest | null>();
    const categoryStarted = deferred<void>();
    const events: string[] = [];

    const runPromise = runNewsLoadPass<string[], TestDigest, string>({
      categories: [
        { key: 'politics', feeds: ['Reuters'] },
        { key: 'energy', feeds: ['Oil Monitor'] },
      ],
      categoryConcurrency: 2,
      digestPromise: digest.promise,
      digestGraceMs: 0,
      hasDigestCategory: (digestSnapshot, key) => key in digestSnapshot.categories,
      loadCategory: async (category, digestSnapshot, options) => {
        events.push(`${category.key}:${digestSnapshot ? 'digest' : 'fallback'}:${options.allowDigestPendingFallback}`);
        assert.equal(digestSnapshot, null);
        assert.equal(options.allowDigestPendingFallback, true);
        assert.equal(options.recordBaselineSample, false);
        categoryStarted.resolve();
        return [`${category.key}-fallback`];
      },
      loadIntel: async (digestSnapshot, allowDigestPendingFallback, options) => {
        events.push(`intel:${digestSnapshot ? 'digest' : 'fallback'}:${allowDigestPendingFallback}`);
        assert.equal(digestSnapshot, null);
        assert.equal(allowDigestPendingFallback, true);
        assert.equal(options.recordBaselineSample, false);
        return ['intel-fallback'];
      },
    });

    await categoryStarted.promise;
    digest.resolve(null);
    const result = await runPromise;

    assert.deepEqual(events, [
      'politics:fallback:true',
      'energy:fallback:true',
      'intel:fallback:true',
    ]);
    assert.deepEqual(result.categoryItemsByKey.get('politics'), ['politics-fallback']);
    assert.deepEqual(result.categoryItemsByKey.get('energy'), ['energy-fallback']);
    assert.deepEqual(result.intelItems, ['intel-fallback']);
    assert.equal(result.initialDigest.pending, true);
    assert.equal(result.finalDigest, null);
  });
});

// The signature loadAllData() compares to decide whether to re-run the news
// load. Production issued TWO list-feed-digest requests per page load because
// the `news` task was unconditional and loadAllData's drain loop re-runs the
// whole task list when a second call overlaps the first (#5376). News is the one
// hydration task that is not viewport-gated, so scroll/viewport triggers — which
// change nothing about the work-list — must compare equal.
describe('newsWorkListSignature', () => {
  it('is stable across the same work-list in a different order', () => {
    assert.equal(
      newsWorkListSignature([{ key: 'politics' }, { key: 'energy' }, { key: 'intel' }]),
      newsWorkListSignature([{ key: 'intel' }, { key: 'politics' }, { key: 'energy' }]),
    );
  });

  it('changes when a category is added (tab switch / panel toggle)', () => {
    const before = newsWorkListSignature([{ key: 'politics' }, { key: 'energy' }], []);
    const after = newsWorkListSignature([{ key: 'politics' }, { key: 'energy' }, { key: 'startups' }], []);
    assert.notEqual(before, after);
  });

  it('changes when a category is removed', () => {
    const before = newsWorkListSignature([{ key: 'politics' }, { key: 'energy' }], []);
    const after = newsWorkListSignature([{ key: 'politics' }], []);
    assert.notEqual(before, after);
  });

  it('collapses duplicate keys so a repeated entry is not a change', () => {
    assert.equal(
      newsWorkListSignature([{ key: 'politics' }, { key: 'politics' }]),
      newsWorkListSignature([{ key: 'politics' }]),
    );
  });

  it('an empty work-list has its own signature, distinct from a populated one', () => {
    assert.notEqual(newsWorkListSignature([]), newsWorkListSignature([{ key: 'politics' }], []));
    // Stable across calls — an empty work-list must not look like a change to itself.
    assert.equal(newsWorkListSignature([]), newsWorkListSignature([], []));
  });

  // Keys are joined, not concatenated: two categories must not be able to
  // masquerade as one differently-named category.
  it('does not collide across different key partitions', () => {
    assert.notEqual(
      newsWorkListSignature([{ key: 'a' }, { key: 'b' }]),
      newsWorkListSignature([{ key: 'ab' }]),
    );
  });
});

// The load filters each category's feeds by ctx.disabledSources
// (data-loader.ts loadNewsCategory: `feeds.filter(f => !this.ctx.disabledSources.has(f.name))`),
// so two loads over the same categories with different disabled sets produce
// different headlines. The signature has to say so, or toggling a source off in
// settings leaves its headlines on screen until RefreshScheduler's 20-minute tick:
// nothing in the toggle path reloads news, and the next loadAllData() trigger
// would compare equal and skip (#5376 review).
describe('newsWorkListSignature — disabled sources', () => {
  const categories = [{ key: 'politics' }, { key: 'energy' }];

  it('changes when a source is disabled', () => {
    assert.notEqual(
      newsWorkListSignature(categories, []),
      newsWorkListSignature(categories, ['CNN World']),
    );
  });

  it('changes when a source is re-enabled', () => {
    assert.notEqual(
      newsWorkListSignature(categories, ['CNN World', 'BBC World']),
      newsWorkListSignature(categories, ['CNN World']),
    );
  });

  it('is stable across disabled-source ordering', () => {
    assert.equal(
      newsWorkListSignature(categories, ['BBC World', 'CNN World']),
      newsWorkListSignature(categories, ['CNN World', 'BBC World']),
    );
  });

  it('does not let a category key and a source name cross-contaminate', () => {
    assert.notEqual(
      newsWorkListSignature([{ key: 'politics' }, { key: 'energy' }], []),
      newsWorkListSignature([{ key: 'politics' }], ['energy']),
    );
  });
});
