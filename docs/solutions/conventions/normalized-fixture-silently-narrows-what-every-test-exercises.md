---
title: "Normalized fixtures lie: a fixture captured in cleaned-up form silently narrows what every test using it exercises"
date: 2026-08-08
category: conventions
module: "cross-strait-activity Japan MOD adapter (scripts/cross-strait-activity/adapters.mjs) and its shared test fixture"
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing or updating an HTML/XML/JSON fixture that stands in for markup or a payload fetched from a live third-party source"
  - "A parser, scraper, or adapter test suite passes green while the live source returns an empty-result or index-empty error in production"
  - "A shared fixture backs many test call sites (fan-out), so one cleaned-up capture silently sets the coverage ceiling for everything built on it"
  - "Reviewing a fixture that was hand-edited or normalized relative to the original live capture, especially one whose own history says it 'keeps the publisher's real markup'"
  - "Debugging why a defect shipped despite a large, fully-green test suite covering the affected code path"
symptoms:
  - "japan-mod source stuck in transportStatus 'error' with errorCodes ['JMOD_INDEX_EMPTY'] against a live HTTP 200 response"
  - "93 cross-strait-activity tests passed across 23 call sites sharing one fixture, giving zero signal of the anchor-parsing defect"
  - "Live capture measured 103 open `<a ` tags vs 98 `</a>` closing tags; the shared fixture closed every anchor the publisher's real markup does not"
related_components:
  - background_job
  - development_workflow
tags:
  - fixtures
  - test-fidelity
  - html-parsing
  - scraper
  - cross-strait-activity
  - japan-mod
  - false-green
  - seed-error
---

# Normalized fixtures lie

## Context

The Japan Joint Staff homepage (`https://www.mod.go.jp/js/`) opens every news-list `<a>` and never emits a matching `</a>`. `scanHtmlAnchors` in `scripts/cross-strait-activity/adapters.mjs` emitted an anchor only when it saw an explicit `</a>`, so `parseJapanModIndex` (`scripts/cross-strait-activity/adapters.mjs:1583`) found zero release links in a perfectly healthy HTTP 200, and the `japan-mod` source published as failed for six days.

The parser was never exercised against that markup, because the fixture that 23 test call sites drive — `tests/fixtures/cross-strait-activity/jmod-homepage.html` — carried a `</a>` on every news item that the publisher does not send.

What made this durable is that nothing inside the repository could reveal it:

- `japan-mod` published `transportStatus: 'error'` with `errorCodes: ['JMOD_INDEX_EMPTY']` and a null `lastSuccessAt`, while the upstream request itself was fine — 200, 31,773 bytes.
- `parseNonEmptyJapanModIndex` threw `JMOD_INDEX_EMPTY` on that 200 (`scripts/cross-strait-activity/adapters.mjs:1624`):
  ```js
  function parseNonEmptyJapanModIndex(html) {
    const rows = parseJapanModIndex(html);
    if (rows.length === 0) throw new Error('JMOD_INDEX_EMPTY');
    return rows;
  }
  ```
- The failure reproduced identically on the direct and the proxy transport, so the proxy fallback added a day earlier could not clear it.
- The entire cross-strait suite was green throughout. Nothing in CI pointed at the parser.

## Guidance

**A test fixture captured in normalized form silently narrows what every test using it exercises.** A capture tidied on the way in — by a browser's "copy outerHTML", by a formatter, or by a well-meaning hand-edit — no longer represents what the upstream actually sends, and every test driving it is green against markup that does not exist in production.

Note the mechanism, because it is not the familiar one. A vacuous guard fails open because its *input shrank* and its assertion is a negative that an empty input satisfies. This is the opposite shape: the fixture was complete and well-formed, the assertions were positive and genuinely checked it, and the suite was still green against bytes the publisher never sends. The input did not shrink; it was never representative.

Five practices follow.

**Never let a capture be tidied on the way into `tests/fixtures/`.** Save the response body byte-for-byte — `curl -s <url> -o fixture.html`, not a browser's "copy outerHTML" and not an editor's format-on-save. Browsers serve you their *repaired* DOM, which is precisely the markup the parser will never receive.

**Record the capture's provenance in the fixture itself** — URL, capture date, byte count, and what was trimmed. For example, `tests/fixtures/cross-strait-activity/jmod-homepage-unterminated.html:1`:

```html
<!-- Verbatim trim of https://www.mod.go.jp/js/ (2026-08-08, 31,773 bytes, HTTP 200).
     Nothing inside the kept regions is reformatted: the publisher opens every
     news-list <a> and never closes it, so the <li> is what bounds the link. -->
```

The word "verbatim" and a byte count are cheap to write and make the next reviewer's question — "is this what the page sends?" — answerable without a network call.

**When a parser reports empty on a 200, run the real parser against real bytes before touching transport.** Two commands settle the transport-vs-content question outright:

```bash
curl -sS "https://www.mod.go.jp/js/" -o /tmp/live.html && wc -c /tmp/live.html
node -e "import('./scripts/cross-strait-activity/adapters.mjs').then(m =>
  console.log(m.parseJapanModIndex(require('fs').readFileSync('/tmp/live.html','utf8')).length))"
```

Non-zero bytes with matching links plus zero parsed rows means the fixture is lying, and no amount of retrying, proxying, or re-routing will help. This is the concrete form of a standing rule already in the auto memory: test the real function against real data (auto memory [claude]).

**Treat "the fixture said it was fine" as a finding, not a relief.** When production disagrees with a green suite, the fixture is a suspect. Diff its *behavior* against a fresh capture — parse both, compare row counts — rather than diffing the files, which will differ in a hundred irrelevant ways.

**Pin the malformed shape explicitly once you know it exists.** A capture in the repo is a snapshot; a test naming the invariant survives the next re-capture. The suite now has a test whose only job is to assert the publisher's actual markup parses (`tests/cross-strait-activity.test.mts:787`), plus companions for each recovery boundary: stray end tags on a closed anchor (`:633`), the omitted-`</li>` sibling case (`:682`), nested lists inside the anchor (`:707`, `:872`), forged bounds in `<script>` raw text (`:726`), the sibling publisher sharing the same scanner (`:748`), and a truncated response (`:767`).

## Why This Matters

The pre-existing parser was correct for the markup it had ever been shown and wrong for the markup the publisher serves. Running both parser versions against both fixture shapes makes the mechanism visible in four lines:

```
PRE-FIX  parser x normalized (2026-08-02-shaped) fixture:      9 rows   <- what CI saw
PRE-FIX  parser x live-shaped (unterminated) fixture:          0 rows   <- what production saw
POST-FIX parser x live-shaped (unterminated) fixture:          5 rows
POST-FIX parser x current (de-normalized) primary fixture:     9 rows
```

The first of those four lines is the whole failure. The fixture and the parser shared an assumption — that a news-list anchor is terminated — so the test could not detect that the assumption was false. A fixture is not a neutral input; it is a second, implicit specification of the upstream, and when it disagrees with reality every assertion built on it inherits the disagreement. Twenty-three call sites all inherited this one.

What makes the class dangerous is that the normalization is invisible at the point of use. The fixture looked like a real capture, was introduced by a fix that specifically claimed to preserve real markup — the header shipped in #5904 / #6013 (`5b1974b6c`, 2026-08-02) read "Header nav and news list keep the publisher's real markup" — and was reviewed as such. Nothing in the file or in any test said "these nine closing tags were added." The only way to find out was to fetch the page and diff behavior, not bytes.

Fan-out sets the blast radius. This fixture backs 23 call sites in `tests/cross-strait-activity.test.mts`, including the shared `japanMinistryFetch` stub (`:69`, referenced 13 times) that whole groups of integration tests inherit without ever naming the fixture. A wrong assumption in a fixture with that reach is not one wrong test — it is a suite-wide blind spot.

## When to Apply

Apply this whenever a fixture stands in for a live third-party payload, and especially when any of these hold:

- A parser or adapter suite is green while the live source errors or returns empty in production.
- One fixture backs many call sites, so it sets the coverage ceiling for everything built on it.
- A fixture was hand-edited relative to its original capture — most of all when its own header claims fidelity it may not have.
- A defect shipped despite a large, fully-green suite covering the affected path.

The transport-first reflex is the tell that this class is in play. When a source goes quiet, transport is the first place engineers look and the last place this defect lives.

## Examples

### The dead ends, and why each was reasonable

**Retrying the empty index through the proxy** (#6302, `4417d1e05`, merged 2026-08-07). The reasoning was defensible in the abstract: a 200 carrying no allowlisted release could be a relocated news list or a challenge page served with a 200, so give the configured proxy one bounded chance. `shouldProxyJapanModFailure` still admits it today (`scripts/cross-strait-activity/adapters.mjs:1700`):

```js
if (code === 'SOURCE_ERROR' || code === 'TIMEOUT' || code === 'JMOD_INDEX_EMPTY') return true;
```

It could never have recovered this outage. `fetchJapanIndexOutcome` fetches the same URL over the proxy and re-runs the same parser on the result — a content-shaped failure reproduces byte-for-byte on both transports, because the content was never the problem. The contract still advertises `fallbackPolicy: 'direct_then_proxy_on_transport_or_empty_content'` (`scripts/cross-strait-activity/adapters.mjs:142`); the `_or_empty_content` half of that policy is inert against a parser defect and is worth revisiting separately.

**Three earlier rounds of transport remedies.** Issues #5714, #5777, and #5776 (`793ebe578`, 2026-07-28) each chased a transport explanation — destination allowlisting, proxy profiles, truthful `blocked` classification — for what turned out to be a per-path Cloudflare WAF rule, where `/js/` answers 200 and `/js/index.html` answers 403 (auto memory [claude]). Same reflex as #6302, one layer down.

**The Wayback Machine could not settle provenance.** Did the publisher change its markup after 2026-08-01, or was the capture tidied on the way into the repo? There is no archival answer — the only snapshot in range was a ~5.5 KB JavaScript shell with zero anchors. The fixture header records that honestly rather than guessing. It does not matter to the fix (either way the fixture no longer matched the page), but it matters to prevention, and the doc should not invent an answer.

**A first fix attempt that bounded an anchor at any unmatched end tag.** It cleared the Japan MOD case and broke well-formed input: a stray `</div>` inside a properly closed anchor truncated the row and handed it the `<time>` element's text as its title, discarding the `<h5>` that followed. Caught in review before it shipped; now pinned by a regression test (`tests/cross-strait-activity.test.mts:633`).

### The diagnosis that broke it open

Fetch the live page and run the real parser against those exact bytes. `curl` returned 200 / 31,773 bytes, and `grep -o 'href="[^"]*pdf[^"]*"'` over the body showed five valid release links. `parseJapanModIndex(liveHtml)` on the same bytes returned zero rows. Real bytes contain the links; the real parser finds none — that contradiction localises the defect to the parser in one step, after days in which the fixture had said everything was fine.

### The fix

`scanHtmlAnchors` (`scripts/cross-strait-activity/adapters.mjs:1065`) now tracks every open element document-wide plus the anchor's opening depth, so an end tag resolves three ways instead of one.

Before — an anchor existed only between `<a>` and `</a>`, and nothing else could end it:

```js
for (const tag of scanHtmlTags(source)) {
  // ...template handling...
  if (tag.name !== 'a') continue;   // every non-anchor tag discarded
  if (tag.isClosing) {
    if (current) { anchors.push({ /* ... */ }); current = null; }
  } else if (!tag.isSelfClosing) {
    current = { openingTag: tag.openingTag, bodyStart: tag.end + 1 };
  }
}
```

After — non-anchor tags maintain a stack, and the anchor records the depth it opened at (`scripts/cross-strait-activity/adapters.mjs:1074`, `:1158`):

```js
const openedIndex = htmlStackLastIndex(openElements, tag.name);
if (openedIndex === -1) continue;                 // unmatched — closes nothing
truncateHtmlStack(openElements, openedIndex);
if (current && openedIndex < current.openDepth) { // an ancestor closed: this is the bound
  anchors.push({
    openingTag: current.openingTag,
    body: source.slice(current.bodyStart, tag.start),
  });
  current = null;
}
```

The three cases are: it closes a descendant (`openedIndex >= current.openDepth`, keep going), it closes an element that already enclosed the anchor (that is where the anchor's content ends), or it matches nothing at all and is ignored exactly as a browser ignores it (`scripts/cross-strait-activity/adapters.mjs:1124`). The unmatched case carries as much weight as the bounding case — it is what keeps the earlier draft's `</div>` regression out.

Two supporting rules ride along. A publisher that drops `</a>` drops `</li>`; without recovery the anchor would run to the `</ul>` and report the *next* item's `<time>` as its own publication day — a release filed under another release's date, silently. A `<li>` that reopens the anchor's enclosing item now ends it, scoped by the innermost `ul`/`ol`/`menu` so a list the anchor itself opened still nests (`closesEnclosingListItem`, `scripts/cross-strait-activity/adapters.mjs:640`); only `li` is recovered, because `dd`/`dt`/`tr`/`td` need the table and definition-list scope rules that `startTagImplicitlyCloses` already declines to guess at (`:560`). And a new `<a>` still abandons an unterminated prior one (`:1150`) — nothing bounded it, so where its body stops is unknowable.

The fixture was corrected in the same change: the nine fabricated `</a>` closers were removed from `tests/fixtures/cross-strait-activity/jmod-homepage.html`, and its header now records what happened and what could not be determined. A second fixture, `jmod-homepage-unterminated.html`, is the verbatim 2026-08-08 trim the parser was actually measured against.

**Verification.** `tests/cross-strait-activity.test.mts` declares 93 `it(` blocks, 13 of them added by this fix, and ran green; the sibling cross-strait suites reported 136/136 green in the same session. The behavioral proof is an end-to-end `fetchCrossStraitActivitySnapshot` run (`scripts/cross-strait-activity/adapters.mjs:2533`) against the live 2026-08-08 bytes: `japan-mod` moved from `transportStatus: "error"` / `errorCodes: ["JMOD_INDEX_EMPTY"]` / `lastSuccessAt: null` to `"fresh"` with five candidates carrying the publisher's own dates and titles.

**Merge state:** opened as #6344 from branch `fix/jmod-unterminated-anchor-discovery`. Unmerged as of this writing — none of it is reachable from `main` yet, so treat every "now behaves as" statement above as describing the PR branch rather than shipped behavior.

### The same failure one level up

After the fix was redesigned around ancestor-closing, two of the new tests silently stopped pinning anything: the redesign had made their guards non-behavioral, and each still passed with its guard deleted. Only a mutation run surfaced it. Both were repaired, and both repairs are recorded in the test comments:

- `tests/cross-strait-activity.test.mts:660` — "treats a self-closed non-void start tag as an element it opened" needed an *enclosing* `<div>` to become observable at all. Its comment now says so outright: "The enclosing div is what makes this observable: without it the unmatched end tag would simply be ignored, and the assertion would pass either way."
- `tests/cross-strait-activity.test.mts:900` — "does not let a stray end tag stand in for the missing bound" had been written with a fixture supplying two independent paths to the verdict (a `<br>` *and* a `</br>`), so it passed for the wrong reason. It now uses `</br>` alone, and its sibling at `:633` covers the closed-anchor variant separately.

This is the same fixture-fidelity failure translated up a level: there, the captured input did not represent the upstream; here, the constructed input did not isolate the behavior under test. In both cases the test was green and the green meant nothing.

The final battery ran 11 mutants and killed 9. The two survivors were verified to leave measured output unchanged across four markup shapes and are commented in the source as stack hygiene rather than guards — the void-element skip (`scripts/cross-strait-activity/adapters.mjs:1088`, "Behaviour does not depend on it") and the stale-item pop (`:1110`, "measured output is identical with and without this pop"). A surviving mutant documented as unobservable is a different thing from a surviving mutant nobody looked at.

**Mutation-test new guards after a design change, not just after writing them.** A guard written against one design can become non-behavioral when the design shifts under it while the test stays green. Deleting the guard and re-running is the cheapest check that a test still has teeth (auto memory [claude]).

## Related

- `docs/solutions/test-failures/deterministic-gdelt-bulk-fixtures.md` — the adjacent fixture-fidelity failure on the time axis: a static fixture whose embedded timestamps drifted out of the window the code under test evaluates. Same shape, different dimension.
- `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md` — the mutation-testing discipline that surfaced the second-order failure above.
- `docs/solutions/conventions/mutate-each-call-site-a-global-mutant-hides-per-site-holes.md` — the companion rule on fan-out: a shared test asset creates an illusion of coverage across many call sites.
- `docs/solutions/integration-issues/vendor-sdk-hidden-retries-nested-retry-ladder.md` and `docs/solutions/integration-issues/umami-answers-http-200-when-it-drops-a-bot-write.md` — two more cases where a healthy-looking 200 concealed a content-level failure.
- PR #6344 — the fix this learning came from.
- Issues #5714, #5777, #5776 and PR #6302 (`4417d1e05`) — the transport-remedy attempts that preceded this diagnosis.
- #5904 / #6013 (`5b1974b6c`, 2026-08-02) — the fix that introduced the primary fixture, whose header claimed it kept the publisher's real markup.
- See `CONCEPTS.md` → *Idealized Capture* for the vocabulary entry, and *Vacuous Guard* for the neighbouring-but-distinct failure mode.
