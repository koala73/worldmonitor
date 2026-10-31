---
title: "Restate inventory counts from the facts generator; the claim gate does not catch every wording"
date: 2026-10-24
category: conventions
module: "public source-count copy (scripts/generate-public-product-facts.mjs RESTATED_FACT_PHRASES, index.html JSON-LD, consent screens; PR #9622)"
problem_type: convention
component: documentation
severity: medium
applies_when:
  - "Adding or editing any public sentence that states how many sources, providers, hosts or feeds World Monitor tracks"
  - "A generator starts rewriting text inside an inline <script> block of committed HTML"
  - "Quoting a source total from the get_sources MCP tool in launch copy"
related_components:
  - tooling
  - testing_framework
tags: [inventory-counts, volatile-inventory-claims, docs-stats, product-facts, json-ld, csp, script-hash, source-attribution]
---

# Restate inventory counts from the facts generator; the claim gate does not catch every wording

## Context

On 2026-10-24 public copy gave five different source totals. The registry measured 774 attributed providers across 789 observed source hosts (469 feed hosts), and `docs/about.mdx` and `public/ai-search.md` already said so. The other surfaces did not:

- Homepage `SoftwareApplication` JSON-LD in `index.html`: "500+ curated RSS news feeds backed by 574 active providers across 578 observed upstream hosts"
- `ARCHITECTURE.md`, the `public/llms-full.txt` brief and the "what is" blog post: "578+ observed upstream hosts"
- Both OAuth consent screens (`mcp-grant.html`, `api/oauth/authorize.js`): "100+ global sources"
- The new-data-source issue template: "100+ feeds"

`scripts/docs-stats.mjs` exists to reject hand-typed totals in acquisition copy, and `index.html` is one of its scan roots. It passed all of these. `ENGLISH_VOLATILE_INVENTORY_CLAIM_RE` matches a number, an optional run of listed adjectives, then a listed noun. "active", "attributed", "upstream" and "RSS" are not in the adjective list, and "hosts", "outlets" and "publishers" are not in the noun list. So "574 active providers" and "578 observed upstream hosts" are invisible to it.

## Guidance

### 1. State a count only through `RESTATED_FACT_PHRASES`

`scripts/generate-public-product-facts.mjs` keeps a per-file table, `RESTATED_FACT_PHRASES`, of exact phrases whose leading numerals it rewrites from measured values. This generalizes the restater that already kept `docs/about.mdx` current. Each entry is `{ pattern, occurrences, keys }`:

- `pattern` matches the whole phrase, digits included, for example `/\b\d+ attributed providers across \d+ observed source hosts\b/g`. It must carry the `g` flag: `restateFacts` counts with `source.match(pattern)` and rewrites with `source.replace(pattern, …)`, and without `g` both see only the first occurrence.
- `occurrences` must match exactly. Copy that loses its wording fails generation with `<path>: expected N match(es) of <pattern>` instead of silently going stale.
- `keys` fill the numerals in order from `RESTATED_FACT_VALUES`: `depthProofStats` (`providers`, `feeds`, `mapLayers`…) plus `sourceHosts` (the attribution scan's `activeHosts`).

`npm run product:facts` and every `prebuild` rewrite the files, and `--check` reports `<path> is stale` when one drifts. To add a surface, write the sentence in a registered phrase shape with the current numbers and add an entry for its path. A file that already has a transform (the JSON-LD files in `applicationJsonLdGroups`) composes `restateFacts(path, …)` into that transform, because the generator allows one transform per file.

Copy that does not need an exact figure (an issue template) uses semantic wording such as "hundreds of feeds".

### 2. Do not fix the gap by widening the claim regex

Adding `active|attributed|upstream|RSS|source` to the adjective list and `hosts|outlets|publishers` to the noun list flagged nine lines. Several were ordinary prose, not inventory claims:

- `docs/methodology/news-digest-and-briefing.mdx`: "because two outlets can write the same short headline"
- `docs/methodology/shortages.mdx`: "two outlets plus a regulator, three outlets"
- `docs/incident-feed.mdx`: "Up to eight outlets"

It also flagged the generator-restated phrases themselves. The regex cannot tell a derived number from a hand-typed one, so restating is the enforcement and the regex is a backstop for the wordings it knows.

### 3. A generator-rewritten inline JSON-LD block needs the static nonce

`tests/deploy-config.test.mjs` hashes every inline `<script>` without `nonce="wm-static-bootstrap"`, including `type="application/ld+json"` data blocks. It requires each hash to be in the CSP `script-src`, which is mirrored in `vercel.json`, `docker/nginx.conf` and `docker/nginx-security-headers.conf`. Restating a count inside an un-nonced block changes its hash, so test "CSP script-src trusts every un-nonced inline script in committed HTML" fails on every registry change.

Give the block `nonce="wm-static-bootstrap"`, as the other generated JSON-LD blocks have had since #7513, and delete its old `'sha256-…'` token from all three CSP copies.

### 4. Quote providers and hosts by their measured names

- **Providers:** 774 on 2026-10-24, from `catalogProviderIdentities(manifest).size`.
- **Hosts:** 789 active source hosts, from `activeHosts`. This is the figure published in `public/ai-search.md` and `docs/source-attribution.mdx`.
- **Not `observedHosts`:** 916, the raw inventory length, which includes hosts the ledger excludes. Don't publish it as a host total.
- **The MCP `get_sources` trap:** its `summary.providerCount` is 789. Its output schema describes that field as active upstream hosts, not providers. Copy that quotes it as "789 providers" or "789 sources" overstates the provider count.

## Why This Matters

Hand-typed totals rot at different speeds on every surface that carries them. Here a sign-in screen understated coverage nearly eightfold while the homepage metadata cited an older total. Anyone checking a launch post against the README or the consent screen sees the contradiction. A count that comes from the generator changes everywhere at once and fails `--check` when its wording breaks.

## When to Apply

- Any new sentence with a source, provider, host or feed total, on any public surface: homepage, docs, llms files, blog, consent screens, ARCHITECTURE.md.
- Any generator change that edits text inside an inline script or JSON-LD block in committed HTML.
- Marketing copy or video captions that take figures from `get_sources`.

## Examples

Before, in the `index.html` JSON-LD `featureList` (un-nonced block, hash pinned in the CSP):

```text
"500+ curated RSS news feeds backed by 574 active providers across 578 observed upstream hosts (ACLED, …)"
```

After (nonced block, numerals restated from the registry):

```text
"469 news and OSINT feeds from 774 attributed providers across 789 observed source hosts (ACLED, …)"
```

The registering entry:

```js
['index.html', [
  { pattern: /\b\d+ news and OSINT feeds from \d+ attributed providers across \d+ observed source hosts\b/g, occurrences: 1, keys: ['feeds', 'providers', 'sourceHosts'] },
]],
```

`tests/public-product-facts.test.mjs` test **"states the measured source inventory on every surface that quotes it"** reads each surface and requires the phrase built from `buildSourceAttributionStats()`. It also bans the old "578+ observed upstream hosts", "574 active providers" and "100+ global sources" wordings.

The exact-occurrence guard has no dedicated test. It lives in `restateFacts`, which throws `<path>: expected N match(es) of <pattern>, found M` during generation, so `npm run product:facts` and every `prebuild` fail when a registered phrase loses its wording.

Related: [every quotable homepage answer carries its own build-measured figure](../best-practices/every-quotable-homepage-answer-carries-its-own-build-measured-figure.md) covers the same principle for the pro-test welcome page's i18next tokens.
