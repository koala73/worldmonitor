---
title: "Published citation anchors need identity-based ids and visible scroll targets"
date: 2026-09-08
category: design-patterns
module: crawlable corpus, sources page generator
problem_type: design_pattern
component: frontend
severity: medium
applies_when:
  - "Publishing fragment URLs as machine-readable citations — JSON-LD ListItem.url, speakable selectors, sitemap fragments, or an llms.txt pointer"
  - "Disambiguating a slug collision by iteration order over a collection that is displayed sorted, so an insertion or rename can reorder it"
  - "Adding scroll-to-anchor navigation to a page carrying sticky or fixed chrome above the anchored region"
  - "Writing a test that asserts an anchor id exists in the rendered HTML"
tags:
  - citation-integrity
  - stable-anchors
  - scroll-margin
  - json-ld
  - structured-data
  - vacuous-guard
  - seo
  - geo
related_components:
  - testing_framework
---

# Published citation anchors need identity-based ids and visible scroll targets

## Context

`/sources/` is a generated static page listing World Monitor's whole provider catalog. Round 7 of the GEO audit found its schema.org `ItemList` announcing all of the catalog's elements as **bare strings**, with 43 of the display names repeated (`renderSourcesIndex()` in `scripts/crawlable-sources-page.mjs`). The repeats were not duplicate data: they are one publisher reached through several hosts — Yahoo Finance through three, Euronews through eight language editions — each of which is a distinct catalog entry that a display name alone cannot tell apart. A parser reading that list had 748 opaque labels, no way to key on them, and no way to distinguish the eight Euronews entries from each other.

The fix (issue #7869, PR #7881 — open and unmerged as of this writing) gave every provider card a stable `id` and gave every `ListItem` a `url` addressing one specific card:

- `sourceCardAnchors()` at `scripts/crawlable-sources-page.mjs` builds the per-provider anchor map, keyed on `provider` (the catalog's own unique key), not on the display name.
- The card markup interpolates the id in `renderSourcesIndex()`, in the same `scripts/crawlable-sources-page.mjs`.
- The JSON-LD gives each element a `url` built from the page URL plus that card's fragment, in `renderSourcesIndex()`, alongside `'@type': 'ListItem'` and a 1-based `position`. The shipped shape is in the Examples section below.

That work is where the lesson lives. Adding the ids turned two properties that had been purely cosmetic — *where* a fragment lands on screen, and *which* card a given fragment names — into correctness properties. Both broke in the first version, both were caught in code review, and both are now pinned by tests proven to fail before the fix.

## Guidance

**When you publish an HTML fragment URL as machine-readable data, you have published a citation. Test it as a citation, not as an id.**

Concretely, three claims must hold, and none of them follows from "the id exists in the rendered HTML":

### 1. The fragment must resolve to the *right* thing, not merely to something

Two provider keys can slugify alike — `a.b` and `a-b` both reduce to `a-b` under the generator's `[^a-zA-Z0-9]+` transform (`sourceCardAnchors()` in `scripts/crawlable-sources-page.mjs`) — so the anchor scheme needs a disambiguator. **Four shapes were written before one was correct, and each of the first three failed the same way for reasons that look different.**

**Shape 1 — an arrival-ordered counter** (`provider-a-b`, `provider-a-b-2`). The counter handed the bare id to whichever collider the loop reached first, and the catalog is sorted by `displayName`, so renaming any unrelated provider could reshuffle which collider owned it. Caught in the pre-merge code review.

**Shape 2 — suffix only a base with more than one claimant.** Count the claimants of each base in a first pass; hand out the bare id when a base has exactly one, a key digest when it has several. This removes the *ordering* dependence, and it is what the fix for shape 1 shipped as. It is still wrong, and subtly enough that a full reviewer roster passed it: publish `a.b` while it is the only claimant and it gets the bare `provider-a-b`; add `a-b` to the catalog a month later and the base now has two claimants, so **the anchor already indexed for `a.b` changes**. Caught by an automated reviewer on the pull request itself, after the human-authored review had signed off.

**Shape 3 — an unconditional digest**, with a `used`/`suffix` fallback for the case where two keys produced the same anchor. This is a pure function of the key *except* down the fallback, which numbered by arrival order — and the comment claimed the invariant held "regardless". A cross-model reviewer did not argue about whether that was reachable; it went and found a pair. `a-b-c-d-e-f.g.h-i-j-k-l-m-n-o-p-com` and `a.b-c.d-e-f-g-h.i.j.k-l-m-n-o-p-com` share a slug *and* a 24-bit SHA-1 prefix, so the fallback fired and reversing the two swapped which one owned the bare anchor.

**Shape 4 — no fallback at all**, which is what shipped (`sourceCardAnchors()` in `scripts/crawlable-sources-page.mjs`):

```js
const key = String(provider.provider ?? '');
const anchor = `provider-${slugBase(key)}-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
const owner = seen.get(anchor);
if (owner !== undefined && owner !== key) {
  throw new Error(`Source card anchor collision: ${owner} and ${key} both map to #${anchor}`);
}
```

The digest is 64 bits and a genuine cross-key collision throws rather than renumbering. A loud build failure is the right response to a 2^-64 event; silently handing one provider's published citation to another is not.

One correction worth recording, because it cuts against the reflex to widen a hash the moment someone says "collision": the risk was **not** the naive birthday figure. A 24-bit prefix collision among 748 keys is ~1.65% likely, but an *anchor* collision needs the slugs to match too, and all 748 slugs are distinct — so the fallback was unreachable on the real catalog, and would only have become reachable once two keys slugified alike. The defect was never the odds. It was that the code asserted a guarantee it did not have, and the guarantee is what future work would have relied on.

The through-line is worth stating plainly, because it is the part that generalizes: **shapes 1 and 2 both let the rest of the catalog leak into an individual anchor.** Shape 1 leaked iteration order; shape 2 leaked catalog membership. Each fix removed one channel and left the other open. The property you actually need is stronger than "deterministic" or "order-independent" — it is that the anchor is a pure function of its own key and reads nothing else, which is a claim you can test directly rather than enumerate exceptions to. Paying seven characters on every anchor is what buys it; conditioning the suffix on anything about the catalog is what keeps re-opening the hole.

### 2. The fragment must land somewhere the reader can actually see

Two stacked `position: sticky` elements sit above the card grid:

- `.sources-page header` — `position: sticky; top: 0`, 146px tall (`renderSourcesIndex()` in `scripts/crawlable-sources-page.mjs`)
- `.catalog-controls` — `position: sticky; top: 68px`, bottom edge at 167px (`renderSourcesIndex()` in `scripts/crawlable-sources-page.mjs`)

A provider card is `min-height: 180px` (`renderSourcesIndex()` in `scripts/crawlable-sources-page.mjs`). Following `#provider-x` scrolled the card to viewport y = -0.06 — measured in Chromium against the generated page before the offset landed — leaving 167 of its 180px buried under chrome. The fix is `scroll-margin-top: 176px` on `.provider-card`, in the same rule. Below 720px `.catalog-controls` goes `static` and only the header stickies, so 176px is generous there rather than wrong.

### 3. Anchors must survive every change to the rest of the catalog

Same root property as (1), stated as the invariant you can actually run. Not one check but a family, because each member catches a different leak: generate over the catalog and over its reverse (ordering); generate with a colliding entry present and absent (membership — the one shape 2 fails); generate the same key alone and among neighbours (everything else). A single "is deterministic" assertion passes on all three broken shapes, because each of them *is* deterministic — given the same catalog.

### The test shape that catches them

The obvious test — and the one the first version of this test wrote — asserts that every ListItem url's fragment appears somewhere in the page. That test passes on a permuted anchor map, on a buried card, and on an order-dependent counter. The stronger assertions actually shipped:

- **Right card, not just some card.** `tests/crawlable-corpus.test.mjs` builds a `cardProviderByAnchor` map from the rendered `<article class="provider-card" id="..." data-provider="...">` markup and asserts each anchor's `data-provider` equals `corpusData.sourceCatalog[index].provider`. The test's own comment states why: "an anchor map that permuted its urls across the catalog would satisfy 'every fragment resolves' while sending every citation to the wrong source."
- **Rendered stylesheet clears the chrome.** `tests/crawlable-corpus.test.mjs` reads the `extraStyles` the page generator *returns* — not the module's source text — matches the `.provider-card { ... }` rule, and asserts `scroll-margin-top` is `>= 167`. Reading the rendered style block is what makes a future header resize that re-buries the anchors fail.
- **Independence from the rest of the catalog.** `tests/crawlable-corpus.test.mjs` pins each way an anchor must not move, as separate assertions: colliding keys stay distinct; reversing the catalog changes nothing; adding a *later* collider changes nothing (the assertion that shape 2 fails); and the same key alone versus among neighbours yields the same string. Writing them as four named claims rather than one "is deterministic" check is what made the shape-2 gap visible as a specific missing assertion.
- **Character class.** The `keeps every anchor inside the character class...` test pins every anchor to `/^provider-[a-z0-9-]+$/`. The card markup interpolates the id without `escapeHtml` — as it does for `data-source-domain`, `data-source-kind` and `data-source-country` — so the slug's character class, not the caller, is what makes that safe.

## Why This Matters

An anchor in a nav menu is cosmetic. A human who lands in the wrong place scrolls, and nothing is lost.

An anchor published in JSON-LD is a **citation an assistant or a search index will store and repeat**. At that point "resolves" and "resolves to the right thing, visibly" stop being the same claim, and the failure modes stop being self-correcting:

- A **repointed anchor** is worse than a dead one. A 404-ish dead fragment degrades to the top of the page; a fragment that now names a *different* provider attributes one publisher's data to another, in a citation that has already been crawled and stored. Nothing in the build, the tests, or the browser reports an error.
- A **buried anchor** defeats the entire purpose of adding the url. The reason the ItemList carries a url at all is so `numberOfItems` "publishes a count of things a reader can go and look at" (`sourceCardAnchors()` in `scripts/crawlable-sources-page.mjs`). A citation that scrolls a reader to 13 visible pixels of a 180px card has technically resolved and practically failed.
- **Ordering coupling is invisible until it bites.** Measured over the live catalog, all 748 provider keys slugify to 748 distinct bases, so no collision path runs today. The suite does not assert that — it pins the weaker invariant that no two anchors collide (`tests/crawlable-corpus.test.mjs`, the generated-corpus test's `two entries must never share one anchor`) — and the 748-of-748 figure is an observation, not enforced coverage. Which is the point: an order-coupled scheme sits there passing every test until the day two keys collide, and the damage is then silent and already indexed.

The unifying point: adding a machine-readable url to something moves it from the "presentation" budget to the "data contract" budget. Presentation defects are absorbed by the human; data-contract defects propagate.

## When to Apply

- **You are adding `url` values to `ListItem`, `ItemList`, `FAQPage`, `HowTo`, `speakable`, or any other JSON-LD node that points at an in-page fragment.** Everything above applies verbatim.
- **You are generating ids from slugs and need a collision disambiguator.** Never use arrival order, index position, or a counter — not as the scheme, and not as the fallback nobody expects to reach. Derive the suffix from the entity's own stable key so the id is a pure function of identity, size the digest so a collision is a hash break rather than a coincidence, and make that case throw. A fallback that renumbers is the same defect wearing a smaller probability.
- **Your page has any `position: sticky` chrome above the anchored region.** Sum the sticky stack's bottom edge, set `scroll-margin-top` above it, and assert the value in a test that reads rendered CSS.
- **You are about to write a test that asserts an anchor exists.** That is the weak form. Ask what a *permuted* anchor map, a *reordered* input, or a *taller header* would do to it — and if the answer is "still passes", the test has no teeth.
- **Not needed** for anchors that are purely internal navigation (a table-of-contents jump within an article, a tab deep-link) and are never emitted as machine-readable data. Those stay in the cosmetic budget.

## Examples

### Order-dependent counter → identity-derived digest

**Rejected shape 1** — order-dependent; `provider-a-b` migrates between providers when the sort order changes:

```js
const seen = new Map();
const n = (seen.get(base) ?? 0) + 1;
seen.set(base, n);
const anchor = n === 1 ? `provider-${base}` : `provider-${base}-${n}`;
```

**Rejected shape 2** — order-independent but membership-dependent; the bare id is reassigned the day a second claimant appears:

```js
const claimants = new Map();
for (const provider of sourceCatalog) {
  const base = slugBase(provider.provider);
  claimants.set(base, (claimants.get(base) ?? 0) + 1);
}
// ...later, per provider:
const preferred = claimants.get(base) === 1
  ? `provider-${base}`                       // <- changes when a collider joins
  : `provider-${base}-${digest(provider.provider)}`;
```

**Shipped** (`sourceCardAnchors()` in `scripts/crawlable-sources-page.mjs`) — no first pass, no conditional, no reference to any other entry:

```js
const anchors = new Map();
const used = new Set();
for (const provider of sourceCatalog) {
  const key = String(provider.provider ?? '');
  const anchor = `provider-${slugBase(key)}-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
  const owner = seen.get(anchor);
  if (owner !== undefined && owner !== key) {
    throw new Error(`Source card anchor collision: ${owner} and ${key} both map to #${anchor}`);
  }
  seen.set(anchor, key);
  anchors.set(provider.provider, anchor);
}
```

The loop body derives `anchor` from `key` and nothing else — that is the whole property, and it is visible at a glance in a way "we handle collisions correctly" never is. `seen` exists only to detect a genuine cross-key collision and throw; it is never an input to the value.

### Weak anchor test → citation-grade test

**Weak** (passes on a permuted map, a buried card, and an order-dependent counter):

```js
for (const url of urls) {
  assert.ok(body.includes(`id="${url.slice(url.indexOf('#') + 1)}"`));
}
```

**Strong, (i) right card** (`tests/crawlable-corpus.test.mjs`):

```js
const cardProviderByAnchor = new Map(
  [...sourcesPage.matchAll(/<article class="provider-card" id="([^"]+)" data-provider="([^"]*)"/g)]
    .map((match) => [match[1], unescapeAttribute(match[2])]),
);
providerAnchors.forEach((anchor, index) => {
  const expected = corpusData.sourceCatalog[index].provider;
  assert.ok(cardProviderByAnchor.has(anchor), `${anchor} must name a card in the rendered page, ...`);
  assert.equal(cardProviderByAnchor.get(anchor), expected,
    `the ListItem for ${expected} must point at that provider's own card`);
});
```

The test decodes the rendered attribute rather than re-escaping the expected value, because the generator's `escapeHtml` also covers `'` (L'Orient Today) and a second copy of that table in the test would be one more thing to keep in step (`tests/crawlable-corpus.test.mjs`).

**Strong, (ii) visible landing** (`tests/crawlable-corpus.test.mjs`) — reads the returned `extraStyles`, not the module source:

```js
const { jsonLd, extraStyles } = await renderCatalog(CATALOG);
assert.ok(itemListOf(jsonLd).itemListElement.every((element) => element.url.includes('#provider-')));
const rule = extraStyles.match(/\.provider-card \{([^}]*)\}/);
assert.ok(rule, 'the page must still ship a .provider-card rule');
const offset = rule[1].match(/scroll-margin-top:\s*(\d+)px/);
assert.ok(offset, '.provider-card must set scroll-margin-top or every ListItem url lands under the sticky bars');
assert.ok(Number(offset[1]) >= 167,
  `scroll-margin-top must clear the sticky bars' 167px, got ${offset[1]}px`);
```

**Strong, (iii) independence from the rest of the catalog** (`tests/crawlable-corpus.test.mjs`). The two assertions that matter most are the ones about *change over time*, not about a single render:

```js
// reordering moves nothing
const reversed = sourceCardAnchors([...colliders].reverse());
for (const { provider } of colliders) {
  assert.equal(reversed.get(provider), forward.get(provider),
    `${provider} must keep its anchor when the catalog is reordered`);
}

// adding a LATER collider moves nothing either — the case shape 2 gets wrong
const alone = sourceCardAnchors([{ provider: 'a.b' }]);
assert.equal(forward.get('a.b'), alone.get('a.b'),
  'adding a colliding provider must not change an anchor that was already published');

// and an anchor does not depend on the catalog at all
assert.equal(
  sourceCardAnchors([{ provider: 'finance.yahoo.com' }]).get('finance.yahoo.com'),
  sourceCardAnchors([{ provider: 'zzz' }, { provider: 'finance.yahoo.com' }, { provider: 'aaa' }]).get('finance.yahoo.com'),
  'an anchor must not depend on which other providers are present',
);
```

The same block pins the degenerate case too: two unsluggable keys (`'---'`, `'!!!'`) both fall back to the `source` base and still get distinct anchors, because the digest distinguishes them.

### The JSON-LD the anchors feed

`renderSourcesIndex()` in `scripts/crawlable-sources-page.mjs` — every element is a `ListItem` with a dense 1-based `position` and a fragment url, and `numberOfItems` now counts addressable things:

```js
mainEntity: {
  '@type': 'ItemList',
  numberOfItems: sourceCatalog.length,
  itemListOrder: 'https://schema.org/ItemListUnordered',
  itemListElement: sourceCatalog.map((provider, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: provider.displayName,
    url: `${pageUrl}#${cardAnchors.get(provider.provider)}`,
  })),
},
```

The fixture at `tests/crawlable-corpus.test.mjs` deliberately uses two catalog entries sharing the display name "Yahoo Finance" (`finance.yahoo.com` and `query1.finance.yahoo.com`), and the assertion at `tests/crawlable-corpus.test.mjs` requires one distinct name but two distinct urls — the case the whole change exists to serve.

## Related

- Issue #7869 — round-7 GEO residue (uncached sitemaps, `/sources` ItemList strings, YouTube gap, measurement notes)
- PR #7881 — `fix(seo): cache the root sitemaps, close the /sources ItemList, cite the press (#7869)` (open, unmerged as of 2026-09-08)
- `scripts/crawlable-sources-page.mjs` — `sourceCardAnchors()` and its docstring, which records the same reasoning at the call site
- `tests/crawlable-corpus.test.mjs` — the `GEO residue #7869 (sources ItemList)` describe block

### Sibling learnings

- [`unique-match-is-not-identity-verify-attribution-against-an-authoritative-field`](../conventions/unique-match-is-not-identity-verify-attribution-against-an-authoritative-field.md) — the closest conceptual sibling. Different domain (SEC EDGAR company resolution), same abstract fix: derive the identifying value from an authoritative source rather than an incidental one. Not prior art for this defect.
- [`pinned-value-allowlist-freezes-a-snapshot-not-the-invariant`](./pinned-value-allowlist-freezes-a-snapshot-not-the-invariant.md) — same anti-pattern family. "A guard that pins today's known-wrong values is not the invariant" rhymes with "an id-exists test is not the invariant"; that one is about JSON-LD `@id` contract gates across surfaces, this one about anchor identity on a single page.
- [`closed-world-classification-gate-for-config-completeness`](./closed-world-classification-gate-for-config-completeness.md) — same producer file (`scripts/crawlable-sources-page.mjs`), unrelated concern (catalog domain classification). Context only.

A fresh search of all 119 docs under `docs/solutions/` found no existing entry governing anchor-suffix determinism or scroll-offset behaviour under sticky chrome; both halves of this learning are new ground.
