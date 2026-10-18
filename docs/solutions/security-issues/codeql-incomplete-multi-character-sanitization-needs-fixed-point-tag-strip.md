---
title: CodeQL incomplete-multi-character-sanitization is only cleared by a fixed-point tag strip
date: 2026-10-06
category: security-issues
module: disease-outbreaks
problem_type: security_issue
component: background_job
severity: high
symptoms:
  - "CodeQL js/incomplete-multi-character-sanitization (high) flagged the .replace(/<[^>]+>/g, '') line in cleanRssDescription on PR #8940"
  - "The alert fired only because the PR edited the line; the same single-pass strip already existed on main"
  - "Chaining .replace(/</g, '') after the tag strip was still flagged on the same line"
  - "A single alternation regex /<[^>]+>|</g was still flagged on the same line"
  - "A unit test showed /<[^>]+>/ leaves an unclosed tag start such as '<script src=x' unchanged"
root_cause: missing_validation
resolution_type: code_fix
related_components: [testing_framework]
tags: [codeql, code-scanning, sanitization, html-stripping, regex, rss, disease-outbreaks, seeder]
---

# CodeQL incomplete-multi-character-sanitization is only cleared by a fixed-point tag strip

## Problem

PR #8940 edited `cleanRssDescription` in `scripts/_disease-outbreaks-helpers.mjs`. CodeQL (GitHub code scanning) then raised a high-severity `js/incomplete-multi-character-sanitization` alert on the tag-strip line: "This string may still contain <script, which may cause an HTML element injection vulnerability."

The pattern was not new. Before the PR, the function already ran one pass of `.replace(/<[^>]+>/g, '')`. CodeQL reported it as a new alert only because the PR touched that line.

The real gap in a single pass is the **unclosed tag start**. `/<[^>]+>/` needs a closing `>`, so `Cases rose <script src=x` comes out of the strip unchanged. Nested input such as `a<<b>script>` is not a gap for this regex: one pass already reduces it to text with no `<`, and the nested-input test passed against the single-pass code.

The panel escapes these descriptions before rendering them (`src/components/DiseaseOutbreaksPanel.ts`, `escapeHtml(o.summary…)`). The same strings also reach MCP and API consumers unescaped, so the alert was fixed instead of dismissed.

## Symptoms

- The CodeQL check on PR #8940 failed with `js/incomplete-multi-character-sanitization` (severity high) on the `.replace(/<[^>]+>/g, '')` line.
- No test failed. Only the code-scanning check and the `gate` status that aggregates it were red.

## What Didn't Work

Each attempt cost one CI round of about 10 minutes, because CodeQL runs only in CI.

1. **Chaining `.replace(/</g, '')` after the tag strip.** This removes every stray `<`, which closes the real gap. CodeQL still flagged the tag-strip line: the query judges that `replace` call on its own and gives no credit to a later call in the chain.
2. **Merging both into one alternation, `.replace(/<[^>]+>|</g, '')`.** The output was identical and CodeQL still flagged it. It is still one non-repeating pass of a multi-character pattern.

The query is shape-based. It accepts a replace that repeats until the string stops changing. Showing the output is safe some other way does not clear it.

## Solution

Before:

```js
export function cleanRssDescription(rawDesc) {
  return decodeHtmlEntities(rawDesc || '')
    .replace(/<[^>]+>/g, '').trim().slice(0, 300);
}
```

After (PR #8940):

```js
// Strip until nothing changes, then drop any `<` an unclosed tag start
// ("<script src=x") leaves: the result is plain text.
function stripTags(html) {
  let text = html;
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, '');
  } while (text !== previous);
  return text.replace(/</g, '');
}

export function cleanRssDescription(rawDesc) {
  return stripTags(decodeHtmlEntities(rawDesc || ''))
    .replace(TYPOGRAPHIC_ENTITY_RE, (entity) => decodeHtmlEntities(entity))
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
```

CodeQL passed on this version and CI was green on PR #8940 (open, unmerged as of this writing).

A regression test in `tests/disease-outbreaks-entity-decode.test.mjs` pins both inputs:

```js
// A tag regex needs the closing `>`; an unclosed tag start survives it.
// Descriptions are plain text, so no `<` is left after the strip.
it('leaves no tag start behind', () => {
  assert.equal(cleanRssDescription('Cases rose <script src=x'), 'Cases rose script src=x');
  assert.equal(cleanRssDescription('a<<b>script>alert(1)<</b>/script>b'), 'ascript>alert(1)/script>b');
});
```

## Why This Works

The two parts of `stripTags` do different jobs:

- **The fixed-point loop** is the shape CodeQL recognizes as complete. For this regex it changes no output; it exists to clear the alert.
- **The trailing `.replace(/</g, '')`** closes the real gap. No number of `/<[^>]+>/` passes removes `<script src=x`, because there is no `>` to match. With every remaining `<` gone, the output cannot open an element.

The loop alone passes CodeQL but leaves `<script src=x`. The `<` removal alone fixes the output but fails CodeQL, as both failed attempts showed.

The function keeps its single-pass entity-decode contract (#5436): entities are decoded once, before the tag strip, so `&amp;lt;script&amp;gt;` becomes the literal text `&lt;script&gt;` and is not stripped as markup. The loop runs only the tag regex and never decodes again, so it cannot turn escaped text into live markup. The entity-decode suite pins this.

## Prevention

- **Write an HTML tag strip as a fixed-point loop from the start**, followed by `.replace(/</g, '')` when the output is plain text. CodeQL checks the shape, not the safety of the result, so a chained or alternation fix costs a CI round for nothing.
- **Other single-pass strips remain.** `grep -rnE "replace\(/<\[\^>\]\*?\+?>/g" scripts server src api` found 31 matches in 25 files outside the disease-outbreaks helper on 2026-10-06, including `scripts/build-crawlable-corpus.mjs`, `api/_md-url-twin.ts`, `server/worldmonitor/news/v1/list-feed-digest.ts` and many `scripts/seed-*.mjs` files. Editing any of those lines raises the same alert, so convert the line when you touch it.
- **Pin the unclosed-start case in a test** whenever you write or convert a strip:

  ```js
  assert.equal(strip('Cases rose <script src=x'), 'Cases rose script src=x');
  ```

- **When the strip runs after entity decoding**, also assert that `&amp;lt;script&amp;gt;` comes out as the text `&lt;script&gt;`, so the single-decode contract from #5436 holds.
