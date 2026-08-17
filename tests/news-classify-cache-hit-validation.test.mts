// Regression coverage for #3753 — parseClassifyCacheHit, the runtime
// validator enrichWithAiCache runs on every getCachedJsonBatch hit before
// `level`/`category` reach a typed ParsedItem
// (server/worldmonitor/news/v1/list-feed-digest.ts).
//
// ParsedItem.category is declared `string`, but the LLM classify cache is
// Redis-backed JSON: `unwrapEnvelope(parsed).data` returns `unknown`, so a
// stale schema, unrelated payload, or hand-edited Redis value parses fine as
// JSON while carrying a non-string `category`. The pre-fix code cast the
// hit straight to `{ level?: string; category?: string }` and only checked
// truthiness (`!hit.category`) — a truthy non-string (a number, an object,
// an array) sailed through the assertion and got assigned onto
// `item.category` untyped. This asymmetry is exactly why
// buildStoryTrackHsetFields (same file) needed a defensive
// `typeof item.category === 'string'` guard downstream — the type was never
// actually enforced at the point of assignment.
//
// parseClassifyCacheHit tightens the invariant at the cache-read boundary:
// it returns null unless BOTH `level` and `category` are actually strings,
// so a caller can never assign a non-string onto ParsedItem.category. Emptiness
// (a valid-shape hit with `category: ''`) is intentionally NOT rejected here
// — that stays enrichWithAiCache's `!hit.category` truthiness check, so this
// test file locks the split: shape-validation lives in the parser, value
// policy (empty) lives in the caller.
//
// `_skip` is the exception to that split, and the tests below pin the real
// behaviour rather than the intuitive one. The parser does not special-case
// the sentinel — `{ level: '_skip', category: 'x' }` is a valid shape — but
// no deployed writer emits that row. Both relay skip-writes are
// `{ level: '_skip', timestamp }` with NO `category` (scripts/ais-relay.cjs
// :3892 and :3968), and classify-event.ts's negative path stores the bare
// string NEG_SENTINEL, never an object. So every production `_skip` row is
// rejected by the shape check and caught by enrichWithAiCache's `!hit`,
// which makes its `hit.level === '_skip'` comparison unreachable for real
// data. Same outcome either way (both `continue`), but the distinction
// matters if the reject path ever gets logged or metered: skips are normal,
// high-volume traffic and must not be counted as corruption.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { parseClassifyCacheHit } = __testing__;

describe('parseClassifyCacheHit — valid shapes', () => {
  it('valid string level + category → returns the pair unchanged', () => {
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: 'critical', category: 'conflict' }),
      { level: 'critical', category: 'conflict' },
    );
  });

  it('extra unrelated fields on the cache row do not block validation', () => {
    // The classify cache row may carry additional fields (confidence,
    // model, timestamp, ...) that ParsedItem doesn't need. Validation only
    // cares about level/category shape.
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: 'high', category: 'security', confidence: 0.87, model: 'x' }),
      { level: 'high', category: 'security' },
    );
  });

  it('does not special-case the `_skip` sentinel when a category is present', () => {
    // The parser is shape-only: it neither rejects nor privileges the
    // sentinel. Note this row shape is hypothetical — no deployed writer
    // pairs `_skip` with a category (see the real-shape test below).
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: '_skip', category: 'general' }),
      { level: '_skip', category: 'general' },
    );
  });

  it('empty-string category is a valid shape (emptiness is a caller-side policy, not a shape violation)', () => {
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: 'info', category: '' }),
      { level: 'info', category: '' },
    );
  });

  it('empty-string level is a valid shape too', () => {
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: '', category: 'conflict' }),
      { level: '', category: 'conflict' },
    );
  });
});

describe('parseClassifyCacheHit — rejects malformed category', () => {
  it('missing category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high' }), null);
  });

  it('numeric category → null (the exact #3753 failure shape)', () => {
    // Pre-fix: `!hit.category` on `42` is false (truthy), so the old code
    // let this through and assigned the number onto item.category.
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: 42 }), null);
  });

  it('object category → null', () => {
    assert.strictEqual(
      parseClassifyCacheHit({ level: 'high', category: { name: 'conflict' } }),
      null,
    );
  });

  it('array category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: ['conflict'] }), null);
  });

  it('boolean category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: true }), null);
  });

  it('null category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: null }), null);
  });
});

describe('parseClassifyCacheHit — rejects malformed level', () => {
  it('missing level → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ category: 'conflict' }), null);
  });

  it('numeric level → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 3, category: 'conflict' }), null);
  });

  it('object level → null', () => {
    assert.strictEqual(
      parseClassifyCacheHit({ level: { rank: 'critical' }, category: 'conflict' }),
      null,
    );
  });
});

describe('parseClassifyCacheHit — rejects malformed cache values wholesale', () => {
  it('undefined (cache miss) → null', () => {
    assert.strictEqual(parseClassifyCacheHit(undefined), null);
  });

  it('null → null', () => {
    assert.strictEqual(parseClassifyCacheHit(null), null);
  });

  it('a bare string (e.g. a legacy non-JSON-object cache row) → null', () => {
    assert.strictEqual(parseClassifyCacheHit('critical'), null);
  });

  it('a bare number → null', () => {
    assert.strictEqual(parseClassifyCacheHit(42), null);
  });

  it('a top-level array → null', () => {
    assert.strictEqual(parseClassifyCacheHit(['critical', 'conflict']), null);
  });

  it('an empty object → null', () => {
    assert.strictEqual(parseClassifyCacheHit({}), null);
  });

  it('the REAL relay `_skip` row (no category) → null, so the caller never sees the sentinel', () => {
    // scripts/ais-relay.cjs:3892 and :3968 both write exactly this shape.
    // It has no `category`, so the shape check rejects it and
    // enrichWithAiCache's `!hit` catches it before its `hit.level ===
    // '_skip'` comparison can ever be true. Locking this here so a future
    // reject-path log/metric is not written on the assumption that skips
    // arrive as parsed hits — they do not.
    assert.strictEqual(parseClassifyCacheHit({ level: '_skip', timestamp: 1 }), null);
  });
});

// The cases above verify the guard; this block verifies the guard is
// actually WIRED IN. Without it, reverting the one call-site line in
// enrichWithAiCache back to the unchecked `as { level?: string; category?:
// string }` cast — a merge resolved the wrong way, a "simplify this" edit —
// leaves parseClassifyCacheHit defined, exported, fully covered, and
// completely bypassed, with every test above still green. enrichWithAiCache
// reads Redis directly and is not exported, so a source-level wiring
// assertion is the cheap lock; same approach as the
// "list-feed-digest story-identity wiring" block in tests/story-identity.test.mjs.
describe('parseClassifyCacheHit — call-site wiring (mutation lock)', () => {
  const digestSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../server/worldmonitor/news/v1/list-feed-digest.ts'),
    'utf-8',
  );

  // assert.ok on a precomputed boolean, not assert.match/doesNotMatch on
  // `digestSrc` — those dump the whole ~60KB file into the failure output.
  it('enrichWithAiCache routes every cache hit through the validator', () => {
    assert.ok(
      // Deliberately not anchored on `const hit =` or the trailing semicolon,
      // so renaming the local or reformatting the line does not fail this.
      /parseClassifyCacheHit\(cached\.get\(key\)\)/.test(digestSrc),
      'enrichWithAiCache must read the classify cache through parseClassifyCacheHit — ' +
        'the validator is dead weight unless the call site uses it (#3753)',
    );
  });

  it('the unchecked cache-result type assertion is not reintroduced', () => {
    assert.ok(
      !/cached\.get\(key\)\s+as\s/.test(digestSrc),
      'cache hits must not be type-asserted back to `{ level?, category? }` — ' +
        'that unchecked cast IS the #3753 bug this PR fixed',
    );
  });
});
