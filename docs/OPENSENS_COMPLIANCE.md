# OpenSens DAMD — Security & Compliance Checklist

## A. Crawling / Social Connector Compliance

| Check | Status | Notes |
|---|---|---|
| No ToS-violating scraping | ✅ | All data via official APIs or open datasets. No HTML scraping. |
| robots.txt respected | ✅ | Only API endpoints called; no web page crawling. |
| GDELT: non-commercial research | ✅ | GDELT used for aggregate signal only; cite per their ToU. |
| Mastodon: public posts only | ✅ | Only `/api/v1/timelines/public` — no auth, no private posts. |
| Reddit: gated/opt-in | ✅ | Requires explicit user opt-in + valid OAuth2 credentials. |
| X: gated/opt-in | ✅ | Requires explicit opt-in + paid Bearer token. |
| Rate limits honoured | ✅ | Each connector enforces minimum inter-request delays. |
| Retry-After headers respected | ⚠ | Planned; stubs should implement before production. |
| No personal data stored | ✅ | Only aggregate keyword counts + sentiment bins retained. |
| No raw post content stored | ✅ | Text processed in-memory; only derived signals persisted. |
| Data deletion compliance (X) | ⚠ | X requires deletion webhook support; not yet implemented in stub. |

## B. Privacy

| Check | Status | Notes |
|---|---|---|
| No PII collected | ✅ | No usernames, IDs, emails, or device fingerprints. |
| Aggregate-only signals | ✅ | Keyword counts, sentiment bins, event counts per tile. |
| No location tracking | ✅ | Lat/lon used only for upstream API calls; not stored in logs. |
| GDPR-compatible | ✅ | No EU personal data processed. |
| Server-side only API calls | ✅ | All upstream fetches in Edge Functions; API keys never sent to browser. |

## C. SSRF / Security

| Check | Status | Notes |
|---|---|---|
| Origin allowlist | ✅ | `api/_cors.js` — only worldmonitor.app / localhost / Tauri origins. |
| No user-supplied URLs proxied | ✅ | All upstream URLs are hardcoded in Edge functions. No user-controlled fetch targets. |
| No secret keys in client bundle | ✅ | All credentials in server-side env vars only. |
| Input validation | ✅ | `parseLatLon()`, `clamp()` applied to all numeric parameters. |
| Bot middleware | ✅ | `middleware.ts` blocks crawlers on `/api/*`. |
| API key guard on auth routes | ✅ | `api/_api-key.js` pattern available for gated connectors. |
| CSP headers | ✅ | `vercel.json` CSP covers new endpoints (no new origins added). |
| Dependency injection of `fetch` | ⚠ | Production stubs use global `fetch`; consider injection for testability. |

## D. Data Quality & Uncertainty

| Check | Status | Notes |
|---|---|---|
| Wind labeled "pre-screening only" | ✅ | Disclaimer in every `wind` response and UI panel. |
| Confidence scores returned | ✅ | `meta.confidence: 'low'|'medium'|'high'` in all responses. |
| Fallback paths labeled | ✅ | `routingSource: 'haversine-fallback'`, PV fallback warning in `meta.warnings`. |
| Explicit assumptions | ✅ | `assumptions` object in every response; editable in AssumptionsPanel. |
| Last-update time displayed | ✅ | `meta.cachedAt` in every response; rendered in each panel. |

## E. AGPL-3.0 Network Deployment Note

This project is licensed under **AGPL-3.0-only**. The "network use is distribution" clause of the AGPL means:

- If you operate this software as a **network service** (e.g., a hosted web app), you **must** make the complete corresponding source code available to users of that service.
- This applies even if you only make **modifications** to the original code.
- The recommended approach: publish your fork publicly (e.g., on GitHub) and link to the source from the app's footer.
- **OpenSens additions in this PR are derivative works** and therefore also AGPL-3.0. Any deployment must provide source access.
- Third-party data sources have their own licenses (see `OPENSENS_DATA_SOURCES.md`) which are compatible with AGPL deployment for the listed use cases.

**What must be open-sourced when served over the network:**
- All TypeScript/JavaScript source code (frontend + Edge functions)
- Configuration files (variant configs, panel configs)
- Build scripts
- This documentation

**What does NOT need to be open-sourced under AGPL:**
- Your own deployment configuration (environment variables, secrets)
- Infrastructure-as-code for your specific deployment
- Data you collect that is not part of the software itself

When in doubt, consult a qualified open-source attorney.
