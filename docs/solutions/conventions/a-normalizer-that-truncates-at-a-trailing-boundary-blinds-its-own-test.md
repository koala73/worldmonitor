---
title: "A normalizer that truncates at a trailing boundary blinds its own test"
date: 2026-08-20
category: conventions
module: test and CI verification infrastructure
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing a test that compares two documents after stripping boilerplate, banners, or a navigation section"
  - "Adding a guard that normalizes its input by splitting on a marker before asserting equality"
  - "Locking a generated or archived artifact against the live source it was copied from"
  - "Reviewing any assertion whose inputs pass through a preprocessing step you wrote in the same commit"
symptoms:
  - "A mutation that appends content at end-of-file leaves the comparison test green"
  - "The guard is green on both the correct tree and the mutated one, and the diff between them is entirely inside the ignored region"
  - "`split(MARKER)[0]` or `slice(0, indexOf(MARKER))` appears in a test helper whose marker is the document's last section"
root_cause: test_isolation
resolution_type: test_fix
related_components:
  - documentation
  - development_workflow
  - testing_framework
tags:
  - mutation-testing
  - vacuous-tests
  - normalizers
  - positive-control
  - legal-docs
---

## Context

> **Update (#6983, 2026-08-20):** the archive pages this entry describes were replaced by git history plus a
> content digest per document (`shared/legal.ts` → `LEGAL_DOCUMENT_DIGESTS`, `tests/legal-version.test.mts`).
> The lesson below is why that successor test ships two positive controls — one proving a new clause changes the
> digest, one proving an editorial note does not. The normalizer moved; the trap it can fall into did not.

#6976 needed `users.termsVersion` to resolve to real text, so `tests/terms-version-archive.test.mts` compares the archived snapshot `docs/legal/terms-2026-07-27.mdx` against the live `docs/terms.mdx` clause for clause. Any substantive edit to the Terms should fail until it is paired with a new date and a new archive file.

Two things legitimately differ between the two documents and had to be excluded before comparing: the archive's `<Note>` banner, and the `## Previous versions` index that the live page grows with each release (an archived snapshot must not list itself). The first draft excluded the index the obvious way:

```ts
const ARCHIVE_BOUNDARY = '## Previous versions';

function normalizeBody(mdx: string): string {
  const clauses = mdx.split(ARCHIVE_BOUNDARY)[0];   // <-- drops the whole tail
  return clauses.replace(/^---\n[\s\S]*?\n---\n/, '')
    // ...strip comments, blank lines
}
```

All six cases passed. Then the mutation check: append a clause at end-of-file and confirm the suite goes red.

```
== M1: clause appended at EOF ==
ℹ pass 6
ℹ fail 0
```

It survived. `## Previous versions` was the document's **final** section, so `split(BOUNDARY)[0]` discarded not just the index but everything after it — and "everything after it" is exactly where an appended clause lands. The test could not see the mutation because its own preprocessing had already deleted it.

## Guidance

**Excise the region you mean to ignore. Never truncate to it.** Match the section from its heading to the start of the next one, so the excision is bounded on both sides:

```ts
/**
 * Excises exactly the index section, heading through the next `## `. Splitting
 * on the heading instead would drop the whole tail of the document, and a
 * clause appended after it would compare equal to an archive that never had it
 * — the first draft of this test did exactly that and let a mutation through.
 */
const ARCHIVE_INDEX_SECTION = /^## Previous versions\n[\s\S]*?(?=^## )/m;

function normalizeBody(mdx: string): string {
  return mdx
    .replace(ARCHIVE_INDEX_SECTION, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<Note>[\s\S]*?<\/Note>/g, '')
    // ...trim, drop blank lines
}
```

A lookahead-bounded excision has a precondition the truncating version does not: **the ignored section must be followed by another section.** If it is last, the lookahead never matches, the `.replace()` silently no-ops, and the index leaks back into the comparison — a different failure, but still one nobody would notice.

So the excision needs a positive control. Move the section off the end of the document (`## Previous versions` now sits above `## Contact`) and assert that placement:

```ts
it('the version index is not the last section, so the excision stays bounded', () => {
  const headings = [...liveTerms.matchAll(/^## .+$/gm)].map(m => m[0]);
  assert.notEqual(
    headings.at(-1),
    ARCHIVE_BOUNDARY,
    `"${ARCHIVE_BOUNDARY}" must be followed by another "## " section — as the final heading it would `
      + 'swallow the rest of the file and let clause edits pass unnoticed',
  );
});
```

That case protects the *normalizer*, not the documents. It is the only thing standing between a future editor moving one section to the end of the file and silently restoring the original blind spot.

## Why This Matters

The usual vacuous-test failure modes are in the fixture (unproducible input) or the assertion (asserting an empty list). This one is upstream of both: the assertion was correct and the fixture was real, and the test was still unfalsifiable because a helper written in the same commit deleted the evidence before the comparison ran.

That makes it invisible to review. Reading the test top to bottom, `split(BOUNDARY)[0]` reads as "compare the clauses, ignore the version index" — which is precisely the intent. Only executing a mutation reveals that the implementation ignores far more than the name suggests. Reviewing normalizers by reading them does not work; you have to run something through them that should not survive.

The stakes here are specific: this suite is the only thing keeping a recorded `termsVersion` honest. A blind comparison means the Terms can be edited under a version number that already has an archive claiming different text — worse than having no archive at all, because the record now asserts something false.

## When to Apply

Any time an assertion's inputs pass through preprocessing:

- Comparison guards that strip frontmatter, banners, generated headers, timestamps, or nav sections before diffing
- Generated-artifact freshness checks that normalize before comparing to source
- Log or output scanners that filter lines before matching
- Any helper using `split(MARKER)[0]`, `slice(0, indexOf(MARKER))`, or `takeWhile`-style truncation on content you do not fully control

The tell is directional: truncation (`[0]`, `slice(0, i)`) keeps a prefix and discards an unbounded tail. Excision (`replace(section, '')`) removes a bounded region and keeps everything else. Prefer excision, and when the excision has a structural precondition, assert that precondition as its own case.

## Examples

The full mutation set run against the fixed version — all four killed, where the first draft killed only two:

| Mutation | First draft | Fixed |
|---|---|---|
| Clause appended at EOF | **survived** | killed |
| Clause edited mid-document (`USD 100` → `USD 5`) | killed | killed |
| `Last updated` bumped with no new archive | killed | killed |
| Version index moved to be the last section | *(n/a — it already was)* | killed |

The fourth mutation is the positive control. It exists only because the third has a precondition, and it is the case that would have caught the original bug had it been written first.

Related: [verify the verifier — mutation-test every layer built to catch silent failure](verify-the-verifier-mutation-test-every-detection-layer.md) covers the adjacent case where the *detection layer* is never mutated. This doc is the narrower one: the detection layer is fine, and its input preprocessing is what cannot fail.
