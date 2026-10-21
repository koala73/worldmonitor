// #4923 (a): persistent read-state — a returning user must see NEW tags
// for stories that arrived while away, instead of the first render
// blanket-marking everything seen. Extended per the PR #4926 review round:
// throttle, force-flush, quota-throw, wrong-shape, cloud-refresh, and the
// pure computeNewSinceVisit partition.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub browser globals BEFORE the module under test touches them.
const store = new Map<string, string>();
let setItemImpl = (k: string, v: string) => { store.set(k, String(v)); };
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => setItemImpl(k, v),
  removeItem: (k: string) => { store.delete(k); },
};
const windowHandlers = new Map<string, (event?: unknown) => void>();
(globalThis as Record<string, unknown>).window = {
  addEventListener: (name: string, fn: (event?: unknown) => void) => { windowHandlers.set(name, fn); },
  dispatchEvent: () => true,
};
const documentHandlers = new Map<string, () => void>();
(globalThis as Record<string, unknown>).document = {
  visibilityState: 'hidden',
  addEventListener: (name: string, fn: () => void) => { documentHandlers.set(name, fn); },
};

const { activityTracker, READ_STATE_KEY } = await import('../src/services/activity-tracker.ts');
const { computeNewSinceVisit } = await import('../src/utils/new-since-visit.ts');

describe('persisted read-state (#4923)', () => {
  beforeEach(() => {
    store.clear();
    setItemImpl = (k, v) => { store.set(k, String(v)); };
    activityTracker.clear();
    activityTracker._reloadReadStateForTests();
  });

  it('reads the previous visit timestamp from localStorage', () => {
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 1_751_000_000_000 }));
    activityTracker._reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 1_751_000_000_000);
  });

  it('returns 0 for missing, corrupt, wrong-shape, and far-future state', () => {
    assert.equal(activityTracker.getPreviousVisitTime(), 0);

    store.set(READ_STATE_KEY, '{not json');
    activityTracker._reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 0, 'corrupt JSON degrades to 0');

    store.set(READ_STATE_KEY, JSON.stringify({ v: 1 }));
    activityTracker._reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 0, 'valid JSON missing lastVisitAt degrades to 0');

    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: Date.now() + 60 * 60 * 1000 }));
    activityTracker._reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 0, 'clock-skew guard: far-future timestamp ignored');
  });

  it('markAsSeen persists lastVisitAt so the NEXT session knows this one happened', () => {
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['a']);
    const before = Date.now();
    activityTracker.markAsSeen('panel');
    const raw = store.get(READ_STATE_KEY);
    assert.ok(raw, 'read-state must be written');
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.v, 1);
    assert.ok(parsed.lastVisitAt >= before, 'lastVisitAt must be fresh');
  });

  it('throttles repeat writes within the persist interval', () => {
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['a']);
    activityTracker.markAsSeen('panel');
    const first = store.get(READ_STATE_KEY);
    store.delete(READ_STATE_KEY);
    activityTracker.markAsSeen('panel'); // within 30s window
    assert.equal(store.has(READ_STATE_KEY), false, 'second write inside the throttle window is skipped');
    assert.ok(first, 'first write happened');
  });

  it('visibilitychange:hidden force-flushes past the throttle — but ONLY after genuine interaction', () => {
    activityTracker.register('panel'); // lazy-installs lifecycle listeners
    const onVisibility = documentHandlers.get('visibilitychange');
    assert.ok(onVisibility, 'visibilitychange listener installed on first register');

    // No interaction yet: the flush must persist NOTHING (#4926 review P1
    // — a minted "now" here marked away-stories seen without acknowledgement).
    activityTracker.updateItems('panel', ['a']);
    activityTracker.markItemsSeen('panel', ['a']);
    onVisibility!();
    assert.equal(store.has(READ_STATE_KEY), false, 'zero-interaction session persists nothing');

    activityTracker.markAsSeen('panel');
    store.delete(READ_STATE_KEY);
    onVisibility!();
    assert.ok(store.has(READ_STATE_KEY), 'post-interaction flush bypasses the throttle');
  });

  it('localStorage quota/privacy failures degrade silently', () => {
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['a']);
    setItemImpl = () => { throw new Error('QuotaExceededError'); };
    assert.doesNotThrow(() => activityTracker.markAsSeen('panel'));
    assert.equal(activityTracker.getNewCount('panel'), 0, 'in-memory state still updated');
  });

  it('cloud-prefs-applied refresh adopts a NEWER cross-device visit, never an older one', () => {
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 1_000 }));
    activityTracker._reloadReadStateForTests();
    activityTracker.register('panel'); // installs the cloud-applied listener
    const onApplied = windowHandlers.get('wm:cloud-prefs-applied');
    assert.ok(onApplied, 'cloud-prefs-applied listener installed');

    // Newer cloud value advances the marker.
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 2_000 }));
    onApplied!({ detail: { keys: [READ_STATE_KEY] } });
    assert.equal(activityTracker.getPreviousVisitTime(), 2_000);

    // Older cloud value must NOT roll the marker back.
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 500 }));
    onApplied!({ detail: { keys: [READ_STATE_KEY] } });
    assert.equal(activityTracker.getPreviousVisitTime(), 2_000, 'monotonic across devices');

    // Unrelated keys are ignored.
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 9_000 }));
    onApplied!({ detail: { keys: ['worldmonitor-theme'] } });
    assert.equal(activityTracker.getPreviousVisitTime(), 2_000);
  });

  it('markItemsSeen marks a subset and leaves the rest counted as new', () => {
    let reported = -1;
    activityTracker.register('panel');
    activityTracker.onChange('panel', (n) => { reported = n; });
    activityTracker.updateItems('panel', ['old1', 'old2', 'fresh']);
    activityTracker.markItemsSeen('panel', ['old1', 'old2']);
    assert.equal(activityTracker.getNewCount('panel'), 1, 'the unseen item stays new');
    assert.equal(reported, 1, 'onChange reports the remaining count');
    assert.equal(activityTracker.shouldHighlight('panel', 'fresh'), true);
    assert.equal(activityTracker.shouldHighlight('panel', 'old1'), false);
  });

  it('markItemsSeen on an unregistered panel is a safe no-op', () => {
    assert.doesNotThrow(() => activityTracker.markItemsSeen('never-registered', ['x']));
    assert.equal(activityTracker.getNewCount('never-registered'), 0);
  });

  it('a second updateItems keeps subset-seen state intact', () => {
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['old1', 'fresh']);
    activityTracker.markItemsSeen('panel', ['old1']);
    const newIds = activityTracker.updateItems('panel', ['old1', 'fresh']);
    assert.deepEqual(newIds, ['fresh'], 'only the never-seen item reports as new');
  });
});

describe('computeNewSinceVisit (pure partition, #4926 review)', () => {
  const clusters = [
    { id: 'old-story', firstSeen: new Date('2026-07-05T08:00:00Z') },
    { id: 'away-story', firstSeen: new Date('2026-07-05T12:00:00Z') },
    { id: 'fresh-story', firstSeen: '2026-07-05T13:30:00Z' },
  ];
  const prevVisit = new Date('2026-07-05T10:00:00Z').getTime();

  it('returning user: stories first seen after the previous visit are NEW, older are seen', () => {
    const { newIds, seenIds } = computeNewSinceVisit(clusters, prevVisit);
    assert.deepEqual(newIds, ['away-story', 'fresh-story']);
    assert.deepEqual(seenIds, ['old-story']);
  });

  it('first-ever visit (prev=0): everything is seen — old behavior preserved', () => {
    const { newIds, seenIds } = computeNewSinceVisit(clusters, 0);
    assert.deepEqual(newIds, []);
    assert.equal(seenIds.length, 3);
  });

  it('unparseable firstSeen falls into seen (never a stuck NEW tag)', () => {
    const { newIds, seenIds } = computeNewSinceVisit(
      [{ id: 'weird', firstSeen: 'not-a-date' }],
      prevVisit,
    );
    assert.deepEqual(newIds, []);
    assert.deepEqual(seenIds, ['weird']);
  });
});

describe('NewsPanel first-render wiring (source-textual)', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/NewsPanel.ts'),
    'utf-8',
  );

  it('first render consults the pure partition instead of blanket-marking seen', () => {
    assert.match(src, /computeNewSinceVisit\(/, 'must use the tested pure partition');
    assert.match(src, /getPreviousVisitTime\(\)/, 'must read the persisted previous visit');
    assert.match(src, /markItemsSeen\(/, 'must use subset-seen, not markAsSeen(all)');
    assert.doesNotMatch(src, /First render: mark all items as seen/, 'old blanket branch must be gone');
  });

  it('away-item NEW ribbons are not gated on the 2-minute arrival window', () => {
    assert.match(src, /newSinceAwayIds\.has\(cluster\.id\)/, 'ribbon persists for away items until seen');
  });

  it('read-state key is cloud-synced', () => {
    const syncSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/utils/sync-keys.ts'),
      'utf-8',
    );
    assert.match(syncSrc, /'wm-read-state-v1'/);
  });
});

describe('acknowledgement model (#4926 external review P1)', () => {
  it('REGRESSION: F5 before any interaction keeps away-stories NEW (markItemsSeen persists nothing)', () => {
    store.clear();
    activityTracker.clear();
    // Session 1: previous visit was yesterday; first render partitions and
    // programmatically marks old items seen. User hits F5 WITHOUT ever
    // scrolling/clicking.
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 1_000 }));
    activityTracker._reloadReadStateForTests();
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['old', 'away']);
    activityTracker.markItemsSeen('panel', ['old']);
    assert.equal(store.get(READ_STATE_KEY), JSON.stringify({ v: 1, lastVisitAt: 1_000 }),
      'programmatic bootstrap marking must not advance the persisted visit');

    // Session 2 (the reload): previous visit is STILL yesterday.
    activityTracker.clear();
    activityTracker._reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 1_000, 'away stories stay NEW after F5');
  });

  it('genuine interaction advances the persisted visit to the interaction time', () => {
    store.clear();
    activityTracker.clear();
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 1_000 }));
    activityTracker._reloadReadStateForTests();
    activityTracker.register('panel');
    activityTracker.updateItems('panel', ['a']);
    const before = Date.now();
    activityTracker.markAsSeen('panel');
    const persisted = JSON.parse(store.get(READ_STATE_KEY)!);
    assert.ok(persisted.lastVisitAt >= before, 'interaction persists the acknowledgement time');
  });

  it('register() re-reads storage so a cloud value landing pre-first-render is seen (#4926-2)', () => {
    store.clear();
    activityTracker.clear();
    activityTracker._reloadReadStateForTests();
    assert.equal(activityTracker.getPreviousVisitTime(), 0);
    // Cloud blob applies between module load and first panel registration.
    store.set(READ_STATE_KEY, JSON.stringify({ v: 1, lastVisitAt: 5_000 }));
    activityTracker.register('late-panel');
    assert.equal(activityTracker.getPreviousVisitTime(), 5_000, 'first partition must see the cloud visit');
  });
});

describe('sandboxed-storage safety (#4926 external review #3)', () => {
  it('a THROWING localStorage accessor degrades to session-only instead of crashing', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: access denied'); },
    });
    try {
      assert.doesNotThrow(() => activityTracker._reloadReadStateForTests());
      assert.equal(activityTracker.getPreviousVisitTime(), 0);
      activityTracker.register('panel');
      activityTracker.updateItems('panel', ['a']);
      assert.doesNotThrow(() => activityTracker.markAsSeen('panel'));
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });
});
