---
title: A section on two discovery surfaces needs one renderer and an idempotent splice
date: 2026-09-05
category: architecture-patterns
module: agent discovery surfaces, llms.txt generation
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A generated block must live inside a hand-maintained file whose surrounding prose has to survive regeneration"
  - "The same section must stay byte-identical across two or more published surfaces (a generated corpus and a hand-written index)"
  - "Adding a family of routes that agent or LLM discovery files are expected to enumerate"
  - "A build script writes more than one output and its --check mode must name every stale file"
  - "A guard should prove a discovery surface covers a whole route family rather than a pinned list of URLs"
tags: [llms-txt, agent-discovery, idempotent-splice, generated-block, single-owner, build-scripts, sitemap-parity, geo]
---

# A section on two discovery surfaces needs one renderer and an idempotent splice

## Context

World Monitor ships two agent discovery files. `public/llms.txt` is a hand-maintained index, and `public/llms-full.txt` is a hand-authored brief followed by a `## Generated corpus` tail emitted by `scripts/build-llms-full.mjs`. Issue #7746 found that the 13 `/compare/` routes, emitted from the `COMPARISON_PAGES` registry in `scripts/build-comparison-pages.mjs`, appeared zero times in either file or on the homepage, even though they were in `sitemap-main.xml`, server-rendered, and linked from the corpus nav.

The gap is structural, not clerical. A generated tail can only carry what its generator knows about, and a hand-maintained index only carries what someone remembered to type. A page family that ships from a registry falls between the two forever. PR #7761 (open, unmerged as of this writing) closes it by giving one script ownership of the section on both surfaces.

The repo had already solved the neighbouring problem once (session history): `scripts/build-ai-search.mjs` regenerates the `## Data Coverage` block and the `Last updated:` line inside the hand-authored `public/ai-search.md` and preserves the prose around them (`scripts/build-ai-search.mjs:13-15`). That work also fixed the direction of travel — `llms.txt` is the hand-maintained source and `llms-full.txt` derives from it via `readVersionHeader` — which is the direction this fix follows.

## Guidance

When a discovery surface is split between a generated tail and a hand-maintained index, apply all five rules together:

- **One owner, both surfaces.** `renderComparisons()` builds the `## Comparisons` block once (`scripts/build-llms-full.mjs:182`) from `comparisonDiscoveryEntries(SITE_ORIGIN)`. `buildLlmsFullText` places that same block first in the generated tail (`scripts/build-llms-full.mjs:229`), and `withComparisonsSection` splices the identical string into the hand-maintained index (`scripts/build-llms-full.mjs:198`). The two surfaces cannot disagree because there is only one renderer.
- **Splice idempotently at a stable anchor.** Replace the section in place when its heading exists, otherwise insert it before the anchor heading (`## Live Instances`, `scripts/build-llms-full.mjs:33`). Idempotence is what makes `--check` a meaningful byte diff rather than a coin flip. Assert the fixed point in a unit test, and confirm it end to end by running the generator twice and diffing (session history).
- **Fail loudly on malformed input.** A duplicated heading and a missing anchor both throw (`scripts/build-llms-full.mjs:203`, `scripts/build-llms-full.mjs:214`), as does a registry page with no `summary` (`scripts/build-comparison-pages.mjs:584`). A splice that silently does nothing is worse than the absence it was written to fix.
- **Render every co-owned output before writing or judging any.** `writeLlmsFull` builds both strings first, then compares and writes (`scripts/build-llms-full.mjs:270-283`), so `--check` names every stale file in one run and a render failure never leaves the pair half-written.
- **Guard the population against the sitemap, not a pinned list.** The tests derive the expected set from `sitemap-main.xml`, so a 14th comparison page is covered the day it ships.

Two adjacent traps are worth naming. Adding a bare `https://www.worldmonitor.app` literal inside `scripts/` trips the source-attribution manifest gate (a stale-manifest-entry error for the www host saying its references no longer match the source tree), surfacing as several failures across the product-facts and published-snapshot suites rather than as one named check. The `npm ci` postinstall that recomputes inventory facts warns and proceeds on that error, so the only signal there is an easy-to-miss console line. Import `SITE_ORIGIN` from `scripts/discover-content-corpus-pages.mjs:5` instead, which carries only Node built-in imports. Separately, any workflow that regenerates these files must stage both of them; the monthly refresh now adds `public/llms.txt` alongside the rest (`.github/workflows/resilience-snapshot-refresh.yml:98`). That cron runs `npm ci --ignore-scripts` and dates its output in UTC, so generator ordering inside the job matters and a local-time date would churn the file (session history).

## Why This Matters

Discovery files are the surface AI engines read when they have not crawled the site deeply. A page family that scores well on citability and is reachable by crawl can still be invisible to an assistant answering from `llms.txt`. The failure is silent: nothing errors, nothing 404s, the sitemap looks complete.

Splitting ownership makes the silence permanent. Manual sync degrades on the first rename, and a second generator writing the same section would drift the moment the two renderers diverged. Single ownership plus an idempotent splice converts a maintenance promise into a byte comparison a CI gate can enforce.

There is a known compromise here. `--check` derives its `llms.txt` expectation from the artifact it is checking, the pattern warned about in the check-gate doc linked below. It is acceptable in this one case because everything outside the spliced block is deliberately hand-maintained, and the block itself is compared against a fresh render of the registry rather than against its own prior output. Adopt the pattern only when both halves of that sentence hold.

A second, smaller compromise: the splice bounds its span by heading, where the `ai-search.md` splice uses sentinel comments because mutation testing showed a renamed heading can silently widen or duplicate a heading-bounded span (session history). Comment sentinels would be visible noise in a file agents read verbatim, so the heading stays and the guard closes the gap instead: every compare URL must appear exactly once in `llms.txt`, which is what a stale block under a renamed heading would break.

## When to Apply

- A generated file and a hand-maintained file must both carry the same list.
- A page family ships from a registry and needs an entry on a discovery surface per route.
- A `--check` gate exists and you need the comparison to be a stable byte diff.
- A workflow or cron job regenerates one of a pair of co-owned artifacts.
- You are about to hardcode a site origin inside `scripts/`.

## Examples

The splice's replace-in-place branch (`scripts/build-llms-full.mjs:205-210`; the first-insert branch below it slices around the anchor offset instead):

```js
if (headings.length === 1) {
  const start = headings[0].index;
  const nextHeading = text.indexOf('\n## ', start + COMPARISONS_HEADING.length);
  const end = nextHeading === -1 ? text.length : nextHeading;
  return `${text.slice(0, start)}${block}\n${text.slice(end)}`;
}
```

Both outputs rendered before either is judged (`scripts/build-llms-full.mjs:270-272`):

```js
const outputs = [
  { relativePath: LLMS_TXT_PATH, next: withComparisonsSection(read(rootDir, LLMS_TXT_PATH)) },
  { relativePath: OUTPUT_PATH, next: buildLlmsFullText({ rootDir }) },
]
```

The guards in `tests/seo-geo-residue.test.mjs` (`describe('GEO residue #7746 (compare discoverability)')`) cover five distinct properties: every sitemap `/compare/` URL is linked exactly once from `llms.txt` and present in the generated corpus; the committed `llms.txt` section equals a fresh render, sits between `## AI Search Answer Blocks` and `## Live Instances`, and appears exactly once; entries match the sitemap set exactly with unique 60 to 240 character summaries; the splice unit test exercises first-insert, in-place replace, missing anchor, and duplicate heading; and the human-facing mirrors (the homepage FAQ answer and its locale catalogs, `home.md`, `ai-search.md`, and the refresh workflow's staging list) all carry the link. Write new entries as `https://www.worldmonitor.app/...` with a trailing slash, as the sitemap does; an earlier audit round flagged apex links in these files that 301 to www (session history, unverified here).

Two sibling precedents already in the repo confirm the shape. `withOpenApiByteSize` patches the OpenAPI byte-size annotation into `llms.txt` and throws unless its anchor occurs exactly once (`scripts/build-openapi-json.mjs:71-76`). `scripts/build-ai-search.mjs:13-15` regenerates only the `## Data Coverage` block of `public/ai-search.md` and preserves the surrounding prose verbatim.

One CI trap cost a round trip, and it had cost the `ai-search.md` work a round trip a month earlier (session history). The `CODE` awk filter in `.github/workflows/test.yml:110` drops every `.md` path, so a guard asserting that `public/home.md` links the comparison hub could never run on a `home.md`-only PR. The fix was a carve-out beside the existing `public/ai-search.md` one (`.github/workflows/test.yml:106-109`), simulated in `tests/ci-code-path-filter.test.mjs`. That awk program is single-quoted in the shell, so its comments must contain no apostrophes (`.github/workflows/test.yml:96-97`). Confirm from the PR's `statusCheckRollup` that `unit` actually ran rather than skipped; in the `ai-search.md` session `gh pr checks --watch` exited 0 while the run was failing (session history).

## Related

- [A check gate that rebuilt its expectation from the artifact it was checking](../logic-errors/a-check-gate-that-rebuilt-its-expectation-from-the-artifact-it-was-checking.md)
- [A gate exemption is only as strong as the job that enforces it](../workflow-issues/a-gate-exemption-is-only-as-strong-as-the-job-that-enforces-it.md)
- [Publish a formula by tracing each term to its producer](../conventions/publish-a-formula-by-tracing-each-term-to-its-producer.md) — the earlier `llms-full.txt` single-sourcing fix
- [Pinned-value allowlist freezes a snapshot, not the invariant](../design-patterns/pinned-value-allowlist-freezes-a-snapshot-not-the-invariant.md)
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md)
- [Verification grep must cover every file type it claims](../conventions/verification-grep-must-cover-every-file-type-it-claims.md)
- Issues: #7746 (this fix, PR #7761, open at time of writing), #7610 (built the compare pages), #7743 and #7744 (open siblings editing the same registry), #7749 (remaining `llms-full.txt` residue: no table of contents, duplicate `##` anchors)
