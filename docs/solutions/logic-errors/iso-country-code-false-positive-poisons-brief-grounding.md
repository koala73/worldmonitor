---
title: A bare ISO alpha-2 token is never a country mention
date: 2026-09-05
category: logic-errors
module: crawlable-corpus
problem_type: logic_error
component: brief_system
severity: high
symptoms:
  - "Australia's prerendered country page published a brief about Sudan, grounded on \"Sudanese anti-war forces reject AU backing for El Burhan dialogue\""
  - "Ethiopia's brief opened on an AI outage timed \"2pm ET\"; Bolivia's said \"Peru (BO)\"; Togo's discussed a UN world-map vote"
  - "Briefs rendered literal ** markdown and headings reading \"WHAT THIS MEANS FOR NO\""
  - "A GEO audit read the half-enriched corpus as an unrun pipeline and asked to run enrichment across the remaining ~184 pages"
  - "A brief presenting a 24/48/72h outlook was published off three articles from one newsroom"
root_cause: logic_error
resolution_type: code_fix
related_components: [tooling, documentation]
tags: [iso-code-matching, country-grounding, shared-matcher, publisher-families, llm-grounding, prerendered-pages, render-guard, geo, crawlable-corpus]
---

# A bare ISO alpha-2 token is never a country mention

## Problem

The 196 prerendered `/countries/<slug>/` pages published LLM-generated "Recent developments" briefs grounded on other countries' news. Three hand-copied country matchers had drifted, and the loosest of them — the one feeding the pages crawlers and AI search engines read — accepted a bare uppercase ISO alpha-2 token as proof that a headline was about that country. Every two-letter code is either an English word or somebody else's acronym, so `AU` matched "African Union (AU)", `ET` matched a timestamp "2pm ET", and `TG`, `BO`, `CM`, `GM` matched whatever prose happened to contain them.

## Symptoms

Four wrong-country briefs are still readable in the committed snapshot at `docs/snapshots/crawlable-live-pulse-2026-09-04.json`. Each was grounded on exactly one headline, and each headline matched only through the ISO-code token:

| Page | Grounding headline (single source) | Published brief opened with |
| --- | --- | --- |
| Australia | "Sudanese anti-war forces reject AU backing for El Burhan dialogue" (Dabanga Sudan) | "Sudanese anti-war forces have publicly rejected African Union (AU) backing…" |
| Ethiopia | "ChatGPT, Grok, and Claude all went down at the same time" (The Verge AI) | "…a simultaneous outage struck ChatGPT, Grok, and Claude…" |
| Bolivia | "Arrest of Jhonsson Pulpo Unlikely to Slow Peru's Extortion Crisis" (InSight Crime) | "Peru (BO) faces a deepening extortion crisis…" |
| Togo | "UN to vote on adopting new world map that shows Africa's true scale" (Guardian World) | "TG is a net energy-independent nation…" |

Two more defects rode along on the same pages:

- **Markdown leaked as text.** The corpus injects the brief as text, so the model's `**entity**` rendered as literal asterisks, on 7 of 11 sampled briefs.
- **The ISO code stood in for the country name.** The server resolved the prompt's country name as `TIER1_COUNTRIES[code] || code`, so every non-tier-1 country got its code. That produced the heading "WHAT THIS MEANS FOR NO" and body prose like "TG is a net energy-independent nation".

The downstream symptom that triggered the work: a GEO audit (issue #7748) read the sparse corpus as an unrun pipeline and asked for the enrichment to be run across the remaining ~184 pages.

## What Didn't Work

**Treating the gap as an unrun pipeline.** The freeze cannot produce more pages by running more. Every country is grounded on one `full` news digest capped at 20 items per category. A production probe on 2026-09-05 (importing `mintSession` and `authedGet` from the freeze under `WM_SEED_ENV_FILE`) measured the real ceiling. These figures were measured against production that day and cannot be replayed from the repo; only the 48-versus-68 pair is recorded in code:

| Grounding pool | Countries named, of 194 |
| --- | --- |
| Old matcher, `full` digest only | 42 |
| Names + aliases + demonyms, `full` only | 48 |
| Names + aliases + demonyms, five `en` variants pooled | 68 |

The other two enrichment sources are thinner still: the intel timeline covers 20 countries over 90 days (18 of them within 10 days), and the advisories route carries dated, linked rows for 43. Roughly a third of the corpus is the ceiling from existing data, so the audit's ask was unsatisfiable as written. `scripts/freeze-crawlable-live-pulse.mjs:227` records the 48-versus-68 measurement beside the constant it justifies.

**Re-testing frozen headline rows by title at build time.** A build-time title-only re-match would have dropped 34 of 131 frozen rows, most of them legitimate matches whose country name appears in the snippet rather than the title. Rejected: the fix belongs where the full text is still available, not downstream of it.

**Counting raw source labels for the two-publisher floor.** The first floor was `sources.length < 2` — a row count. Egypt's brief cleared it on three articles from a single newsroom, all labelled "Egypt Independent". A confident 24/48/72h forecast off one outlet is exactly the trust liability the floor exists to prevent.

## Solution

Fix opened in PR #7762, unmerged as of this writing.

### One matcher, shared by all three surfaces

`shared/country-mention.js` is now the only country-mention matcher. It is plain ESM on purpose: the freeze runs under bare `node` with no TypeScript loader, and the server bundles it into an edge function.

Before, in the freeze's local copy (`git show origin/main:scripts/freeze-crawlable-live-pulse.mjs`), the code token was matched for every country outside a hand-listed exception set:

```js
const AMBIGUOUS_ENGLISH_ISO_CODES = new Set([
  'AI', 'AM', 'AS', 'AT', 'BE', 'BY', 'DO', 'ID', 'IN', 'IS',
  'IT', 'LA', 'ME', 'MY', 'NO', 'SO', 'TO',
]);

function matchesCountryText(text, code, name) {
  if (name) { /* display-name word match */ }
  if (AMBIGUOUS_ENGLISH_ISO_CODES.has(code)) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeMatchRegExp(code)}(?=$|[^A-Za-z0-9])`).test(text);
}
```

`AU`, `ET`, `CM`, `GM`, `BO` and `TG` are not on that list, which is the whole bug. A denylist of "ambiguous" codes is unmaintainable because the ambiguity is not a property of the code, it is a property of every English sentence that might contain it.

After, the direction is inverted — an allowlist of one (`shared/country-mention.js:35`, `shared/country-mention.js:250`):

```js
/** ISO codes that appear as bare uppercase tokens in ordinary English news. */
export const CODE_TOKEN_ALLOWLIST = new Set(['US']);
…
if (CODE_TOKEN_ALLOWLIST.has(terms.code) && matchesCasedToken(text, terms.code)) return true;
```

The recall the code token was standing in for now comes from real language (`shared/country-mention.js:189-205`, `shared/country-mention.js:238-252`):

- **Display names**, matched on normalized text — NFKD, diacritics stripped, lowercased, punctuation collapsed (`normalizeMentionText`, `shared/country-mention.js:160`). "Côte d'Ivoire" and "Cote d'Ivoire" land in the same token space.
- **Curated aliases and overrides**, because ICU renders names no headline uses: "Myanmar (Burma)", "Congo - Kinshasa", "Bosnia & Herzegovina". `NAME_OVERRIDES` (`shared/country-mention.js:38`) replaces those wholesale; `NAME_ALIASES` (`shared/country-mention.js:57`) adds UK, Britain, UAE, DRC, Ivory Coast, Türkiye, East Timor and the rest.
- **Demonyms, matched case-sensitively on raw text** (`DEMONYMS`, `shared/country-mention.js:97`). "Polish" is a country and "polish" is a verb; "Thai" is a country and "thai" is a cuisine. Genuinely ambiguous demonyms are deliberately absent — "American", "Congolese", "Dominican", "Guinean", "Korean", "Georgian", "Macedonian".
- **Exclusion phrases scrubbed before matching** (`NAME_EXCLUSIONS`, `shared/country-mention.js:79`). Scrubbing rather than negative lookaround is what makes the prefix cases work: blanking "south sudan" also blanks the start of "South Sudanese", so it never reaches Sudan's "Sudanese". Names are scrubbed from the normalized text (where "Guinea-Bissau" is already "guinea bissau"); demonyms are scrubbed from the raw text with hyphens and whitespace treated alike (`shared/country-mention.js:220-235`).

The three call sites now import it: the freeze at `scripts/freeze-crawlable-live-pulse.mjs:623`, the server's anonymous grounding at `server/worldmonitor/intelligence/v1/_country-brief-context.ts:166`, and the MCP `get_country_brief` tool at `api/mcp/registry/rpc-tools.ts:1598-1601`. The MCP copy was the worst of the three: it pushed `countryCode.toLowerCase()` into the term list and matched with an `i`-flagged regex, so "rally in Europe" grounded India.

### Every country gets its name

`server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:185`:

```js
// before
const countryName = TIER1_COUNTRIES[req.countryCode.toUpperCase()] || req.countryCode;
// after
const countryName = TIER1_COUNTRIES[countryCode] || displayNameForIso2(countryCode) || req.countryCode;
```

The server retains `displayNameForIso2` from the merged PR #7759. The matcher uses `countryDisplayName` for English search terms and rejects ICU code echoes. Cached briefs generated under the old name and the old matcher are evicted by a cache-key bump from `v6` to `v7` on both the anonymous and premium key shapes (`server/worldmonitor/intelligence/v1/_country-brief-context.ts:64` and `:67`).

### A publisher floor, not a row count

`scripts/crawlable-developments.mjs:35-46`:

```js
export const MIN_BRIEF_GROUNDING_PUBLISHERS = 2;

export function briefGroundingPublisherCount(rows) {
  if (!Array.isArray(rows)) return 0;
  return countPublisherFamilies(rows.map((row) => row?.source));
}

export function hasBriefGrounding(rows) {
  return briefGroundingPublisherCount(rows) >= MIN_BRIEF_GROUNDING_PUBLISHERS;
}
```

`countPublisherFamilies` comes from `shared/publisher-families.js:273`, the existing family table from issue #6428. Three "Egypt Independent" rows are one family; so are "BBC World" and "BBC Africa". The floor is applied twice, at the freeze before a brief is even requested (`scripts/freeze-crawlable-live-pulse.mjs:946-951`) and again at build over the committed snapshot (`scripts/crawlable-developments.mjs:149-151`), so a snapshot frozen before a rule existed renders under the same rule as one frozen after it.

### A wider grounding pool

The freeze now pools five digest variants for country matching and de-duplicates by URL, with `full` first so its rows win ties (`scripts/freeze-crawlable-live-pulse.mjs:233`, pooling loop at `:863-872`):

```js
const COUNTRY_DIGEST_VARIANTS = Object.freeze(['full', 'tech', 'finance', 'commodity', 'happy']);
```

The global homepage strip still reads `full` alone; only the per-country pool widens.

### Publish-time shape rules

`normalizeFrozenDevelopments` (`scripts/crawlable-developments.mjs:130`) is idempotent and runs at both ends. It strips `**`, `__` and ATX heading hashes from every published string — headline titles, brief text, timeline titles and summaries — drops a model preamble before the first contract section unless that preamble carries a `[n]` citation, repairs `WHAT THIS MEANS FOR <CODE>` to the country name when the code is this page's own, and withholds a brief below the publisher floor while keeping its dated headlines. A malformed `sources` field is deliberately handed back untouched (`scripts/crawlable-developments.mjs:146-148`) so the renderer's shape validation reds the build instead of the rule quietly withholding a broken row.

### A guard on rendered output

The corpus retains `formatCrawlableIntelBrief` and `assertCountryBriefPresentation` from merged PR #7759. The formatter replaces country headings with the page name. The guard rejects literal `**` and matches ISO headings regardless of case, while allowing names such as El Salvador.

The frozen-data normalizer also matches headings regardless of case, so `What this means for NO` becomes `WHAT THIS MEANS FOR NORWAY` in the dataset. The matcher excludes `Turks and Caicos` before matching Turkey's `Turks` demonym. Regression tests cover both cases.

## Why This Works

The matcher's job is to decide whether a headline is *about* a country. A two-letter uppercase token carries almost no evidence for that: in a corpus of world news, `AU` is far more likely to be the African Union, `ET` a US time zone, `GM` a carmaker, and `CM` an Indian chief minister than any of them is an ISO region code. The old design tried to enumerate the collisions and got 17 of them, missing the six that actually fired. Inverting to an allowlist means the failure mode is a missed mention, which costs one page a brief, instead of a false mention, which publishes another country's news under a wrong byline on an indexed page.

Names and demonyms recover the recall honestly, and they recover more of it than the code token ever did: pooling the digest variants under the new matcher named 68 of 194 countries against the old matcher's 42. The case-sensitivity split matters because the two term classes have opposite risk profiles. A display name is safe to fold case (nothing else is spelled "Kazakhstan"), while a demonym collides with common lowercase words, so it must be matched as written.

The publisher floor addresses a different failure. Correct grounding still leaves the question of whether one article can support a three-horizon forecast on a page people may act on. Counting families rather than labels closes the obvious evasion, since a single newsroom can publish under many bylines.

Finally, the render guard closes the class the input rules cannot. `normalizeBriefText` can only clean the markers it knows about; the guard asserts on what a reader actually sees, in the rendered `<main>` of every page, and it would have caught both the `**` leak and the coded heading before deploy.

## Prevention

- **Never match a bare ISO-3166 alpha-2 token as a country mention.** Encode this as an allowlist, not a denylist. `tests/country-mention.test.mjs:29` pins the allowlist itself with `assert.deepEqual([...CODE_TOKEN_ALLOWLIST], ['US'])`, and `:33-40` replays four of the six live contaminations (AU, ET, CM, GM; the Bolivia and Togo headlines matched through snippets the snapshot does not keep) plus the classic prose collisions:

  ```js
  assert.equal(mentions('AU', 'Sudanese anti-war forces reject AU backing for El Burhan dialogue'), false);
  assert.equal(mentions('ET', 'ChatGPT, Grok and Claude all went down at 2pm ET'), false);
  assert.equal(mentions('CM', "Punjab faces greater threat from other provinces: CM Maryam"), false);
  assert.equal(mentions('GM', 'GM vs. Ford: a century-old rivalry'), false);
  assert.equal(mentions('TV', 'TV ratings slump'), false);
  assert.equal(mentions('IN', 'Rally IN Europe ends'), false);
  assert.equal(mentions('NO', 'NO deal reached in talks'), false);
  assert.equal(mentions('AT', 'Explosion AT refinery injures three'), false);
  ```

- **Test a matcher with the real contamination, not synthetic strings.** Every wrong-country brief that shipped is now a named assertion. The neighbour-country pairs are pinned in both directions (`tests/country-mention.test.mjs:74-101`): "South Sudan" must not reach Sudan but "Sudan and South Sudan reopen border" must, "Guinea-Bissau" belongs to GW and not GN, "Democratic People's Republic of Korea" belongs to KP and not KR.

- **Case-sensitivity is part of the assertion.** `tests/country-mention.test.mjs:68` and `:70` pin the two that motivated the rule: `mentions('PL', 'How to polish the silverware')` is false, `mentions('TH', 'best thai restaurants')` is false.

- **Sweep the whole corpus, not just the examples.** Two fixture-driven tests run over every country the corpus indexes (`tests/country-mention.test.mjs:124-138`): every code yields at least one name term, and no name term is a bare two-letter code, an ICU echo, or an un-normalized string containing `(`, `)`, `&` or `-`.

- **Count publisher families, never source labels, for any "N independent sources" rule.** `tests/crawlable-developments.test.mjs:137` asserts `briefGroundingPublisherCount` returns 1 for three "Egypt Independent" rows, and `:139` returns 1 for `['BBC World', 'BBC Africa']`.

- **Guard rendered output, not just inputs.** `tests/crawlable-corpus.test.mjs:5392` asserts the build throws on both `**` and `__` in `<main>`, on "WHAT THIS MEANS FOR NO" and on a trailing-colon variant, while passing "WHAT THIS MEANS FOR EL SALVADOR", "WHAT THIS MEANS FOR UK", a `__` inside an `href`, and a `**` inside a `<script>`.

- **One shared module per grounding surface, with the drift written down.** The module header in `shared/country-mention.js:1-32` names all three call sites and the bugs the freeze and MCP copies carried (the server copy shared the freeze's code-token rule), so the next person to add a fourth surface sees why importing is not optional.

- **Measure the grounding pool before promising coverage.** The probe that produced the 42/48/68 table took one script and settled an unsatisfiable ask. The measurement lives beside the constant it justifies at `scripts/freeze-crawlable-live-pulse.mjs:227`.

### Verification

`npm run build:crawlable-corpus` on the committed 2026-09-04 snapshot produced 196 pages with zero literal markers and zero coded headings. Re-running the publish floor over that snapshot independently reproduces the brief accounting:

| Frozen briefs in the snapshot | Published after the floor | Withheld |
| --- | --- | --- |
| 40 | 22 | 18 |

The withheld set contains all four wrong-country briefs (AU, BO, ET, TG) and Egypt. Every withheld brief was grounded on exactly one publisher family. Suites: `tests/country-mention.test.mjs`, `tests/crawlable-developments.test.mjs`, `tests/crawlable-corpus.test.mjs`, `tests/freeze-crawlable-live-pulse.test.mjs`, `tests/mcp-country-brief-grounding.test.mjs`, `tests/country-intel-brief-cache-key.test.mjs`.

## Related Issues

- Issue #7748 — the GEO audit that asked for enrichment across the remaining pages, and the matcher work it turned into.
- Issue #7738 — literal markdown markers and the "WHAT THIS MEANS FOR NO" headings.
- Issue #6428 — the publisher-family table `shared/publisher-families.js` the brief floor now counts against.
- Issue #7615 — the original per-country developments capture this hardens.
- PR #7762 — the fix, open and unmerged as of this writing.
- `docs/corrections.mdx` — the public correction row for the withdrawn briefs.

## Related

- [Unique match is not identity — verify attribution against an authoritative field](../conventions/unique-match-is-not-identity-verify-attribution-against-an-authoritative-field.md): the same failure shape from entity resolution — a low-precision identifier producing one confident, wrong match; its "ambiguity resolves to nothing" rule is this doc's allowlist-of-one.
- [Corroboration counts publisher families](../best-practices/corroboration-counts-publisher-families.md): the family table the brief floor now counts against; the crawlable-corpus freeze is a second consumer of it.
- [A pinned-value allowlist freezes a snapshot, not the invariant](../design-patterns/pinned-value-allowlist-freezes-a-snapshot-not-the-invariant.md): why a hand-listed set of "ambiguous" codes, or a guard pinned to the one marker an audit happened to see, cannot hold.
