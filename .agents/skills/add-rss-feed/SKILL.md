---
name: add-rss-feed
description: Add or change a WorldMonitor news/RSS feed — catalog entry, RSS proxy allowlist mirrors, source tier, propaganda-risk review, and attribution. Use when adding a feed URL, a publisher, or a domain that the RSS proxy must fetch.
metadata:
  internal: true
---

# Add an RSS feed

Source: [CONTRIBUTING.md#adding-rss-feeds](../../../CONTRIBUTING.md#adding-rss-feeds) and [#source-attribution-ledger](../../../CONTRIBUTING.md#source-attribution-ledger).

## Editorial checks first

1. The feed is reliable and actively maintained.
2. Assign a source tier (1-4) by editorial reliability. RSS tiers live in `shared/source-tiers.json` with a byte-identical mirror in `scripts/shared/source-tiers.json` (Railway reads the mirror). `server/_shared/source-tiers.ts` only merges that JSON with the Telegram and X overlays.
3. Flag state affiliation or propaganda risk in `SOURCE_PROPAGANDA_RISK` (`shared/source-provenance.ts`).
4. Pick the category (geopolitics, defense, energy, tech, ...).

## Wire it

1. Add the feed to `shared/news-catalog.json`, the single source of truth. Browser and server catalogs are derived views (`shared/news-catalog.ts`); do not hand-edit them in `src/config/feeds.ts`. Copy the `placements` shape of a neighbouring feed in the same category.
2. The RSS proxy refuses hosts outside its allowlist (SSRF guard). Add every new feed host to all four mirrors with identical content:
   - `shared/rss-allowed-domains.json` (source of truth)
   - `scripts/shared/rss-allowed-domains.json`
   - `api/_rss-allowed-domains.js` (literal array; Edge cannot import JSON)
   - `shared/rss-allowed-domains.cjs` and `scripts/shared/rss-allowed-domains.cjs` re-export the JSON and normally need no edit.
3. A new outbound host needs a `shared/source-attribution-manifest.json` row: `npm run sources:check`, then `npm run sources:generate`.
4. If the publisher links articles on a different host than the feed host (delivery hosts such as feedburner), check `tests/news-publisher-delivery-hosts.test.mts` for the publisher-family requirement.

## Verify

- `node scripts/run-data-tests.mjs tests/feed-catalog-drift.test.mts tests/edge-functions.test.mjs` (allowlist coverage and mirror parity), then `npm run test:related`.
- `npm run generate` if derived files are stale.
- To check only a new feed live, call the exported `fetchFeed`: `node -e "import('./scripts/validate-rss-feeds.mjs').then(m => m.fetchFeed('<feed-url>')).then(x => console.log('ok', String(x).length))"`. `npm run test:feeds` fetches the whole catalog. PR CI never runs either on purpose (contributor-controlled URLs would be an SSRF surface).
- A panel showing "No news available" with HTTP 403 "Domain not allowed" in the console means a missing allowlist entry.
