# Phase 2I: Research Migration - Research

**Researched:** 2026-02-19
**Domain:** Research domain migration to sebuf (arXiv papers, GitHub trending repos, Hacker News items) -- handler with 3 RPCs, service module, consumer rewiring, legacy deletion
**Confidence:** HIGH

## Summary

Research is the 7th domain migration in the sebuf series (2C through 2I). It follows the established 2-plan pattern but introduces two novel aspects: (1) this is the first handler with **3 RPCs** (all prior domains had 1-2), and (2) one of the three RPCs (ListArxivPapers) requires **server-side XML parsing** of arXiv Atom XML, reusing the `fast-xml-parser` pattern established in the aviation migration (2H).

The research domain has a unique characteristic: the three legacy service files (`src/services/arxiv.ts`, `src/services/github-trending.ts`, `src/services/hackernews.ts`) exist but are **not imported by any UI component, App.ts, or the services barrel export**. They are orphan modules -- defined but never wired into the application. The legacy API endpoints (`api/arxiv.js`, `api/github-trending.js`, `api/hackernews.js`) are similarly orphaned (they exist as Vercel edge functions, callable via URL, but no service module or UI code calls them through `API_URLS`). However, `API_URLS` in `src/config/variants/base.ts` defines URL builders for `arxiv`, `githubTrending`, and `hackernews` pointing to these legacy endpoints. The legacy services use those URLs via circuit breakers. This means the migration has a simpler consumer rewiring story than prior domains -- there are no active UI consumers to rewire, only dead service files to replace and dead legacy endpoints to delete.

The three upstream APIs have distinct characteristics: arXiv returns Atom XML (needs `fast-xml-parser`), GitHub trending uses an unofficial JSON API (`api.gitterapp.com` with a herokuapp fallback), and Hacker News uses the official Firebase JSON API (2-step: fetch story IDs, then batch-fetch item details). The handler must implement all three as separate RPC methods on a single `ResearchServiceHandler` interface, returning proto-typed responses. Each must gracefully return empty results on any failure (established pattern from 2F-01).

**Primary recommendation:** Implement a single handler file with 3 RPC methods. Use `fast-xml-parser` for arXiv XML parsing (same config pattern as aviation). For the service module, since there are no active consumers, it can be minimal -- just export the 3 fetch functions backed by the generated client, with types re-exported from the generated client (no legacy shape mapping needed since the proto types are already clean). The "consumer rewiring" plan is primarily deletion of dead code.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-05 | Research domain proto (arXiv papers, GitHub trending, Hacker News) with service RPCs and HTTP annotations | Proto files already exist and are fully defined (`service.proto`, `research_item.proto`, `list_arxiv_papers.proto`, `list_trending_repos.proto`, `list_hackernews_items.proto`). Generated server and client code present. Handler implementation is the remaining work. |
| SERVER-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | Handler must implement 3 RPCs: `listArxivPapers` (proxies `export.arxiv.org` Atom XML API, parses with fast-xml-parser), `listTrendingRepos` (proxies `api.gitterapp.com` JSON API with fallback), `listHackernewsItems` (proxies `hacker-news.firebaseio.com` Firebase JSON API with 2-step fetch). All return proto-shaped responses, empty on failure. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fast-xml-parser | 5.x (5.3.6 installed) | Parse arXiv Atom XML server-side | Already in project deps (used by aviation handler), pure JS, edge-compatible, no DOM dependency |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | All other infrastructure is existing project code (generated server/client, circuit breaker) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fast-xml-parser | DOMParser (browser) | Not available in edge runtime; entire purpose of migration is server-side processing |
| fast-xml-parser | Regex extraction | arXiv Atom XML has nested elements (authors, categories, links) -- regex is fragile |
| api.gitterapp.com | GitHub REST API (search/repositories?sort=stars) | Official but rate-limited to 10 req/min unauthenticated; gitterapp specifically scrapes trending page |

**Installation:**
```bash
# No new dependencies needed -- fast-xml-parser already installed
```

## Architecture Patterns

### Recommended Project Structure
```
api/
  server/
    worldmonitor/
      research/
        v1/
          handler.ts          # Plan 01: ResearchServiceHandler with 3 RPCs
  [[...path]].ts              # Plan 01: Mount research routes (add import + spread)
  arxiv.js                    # Plan 02: DELETE (legacy XML proxy)
  github-trending.js          # Plan 02: DELETE (legacy JSON proxy)
  hackernews.js               # Plan 02: DELETE (legacy JSON proxy)

src/
  services/
    research/
      index.ts                # Plan 02: Port/adapter service module (3 fetch functions)
    arxiv.ts                  # Plan 02: DELETE (legacy service, unused)
    github-trending.ts        # Plan 02: DELETE (legacy service, unused)
    hackernews.ts             # Plan 02: DELETE (legacy service, unused)
  config/
    variants/
      base.ts                 # Plan 02: Remove arxiv/githubTrending/hackernews from API_URLS and REFRESH_INTERVALS
```

### Pattern 1: Multi-RPC Handler (3 methods on one interface)
**What:** The handler implements `ResearchServiceHandler` which has 3 methods: `listArxivPapers`, `listTrendingRepos`, `listHackernewsItems`. Each method is independent and proxies a different upstream API.
**When to use:** When a service proto defines multiple RPCs on a single service.
**Key insight:** Each method has its own try/catch returning empty on failure. They do NOT share state or cross-call.

```typescript
// api/server/worldmonitor/research/v1/handler.ts
import { XMLParser } from 'fast-xml-parser';
import type {
  ResearchServiceHandler,
  ServerContext,
  ListArxivPapersRequest,
  ListArxivPapersResponse,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
  ListHackernewsItemsRequest,
  ListHackernewsItemsResponse,
} from '../../../../../src/generated/server/worldmonitor/research/v1/service_server';

export const researchHandler: ResearchServiceHandler = {
  async listArxivPapers(_ctx, req): Promise<ListArxivPapersResponse> {
    try {
      // ... fetch + parse arXiv XML
    } catch {
      return { papers: [], pagination: undefined };
    }
  },
  async listTrendingRepos(_ctx, req): Promise<ListTrendingReposResponse> {
    try {
      // ... fetch gitterapp JSON
    } catch {
      return { repos: [], pagination: undefined };
    }
  },
  async listHackernewsItems(_ctx, req): Promise<ListHackernewsItemsResponse> {
    try {
      // ... fetch HN Firebase API
    } catch {
      return { items: [], pagination: undefined };
    }
  },
};
```

### Pattern 2: ArXiv Atom XML Parsing with fast-xml-parser
**What:** Parse arXiv Atom XML response into proto-shaped `ArxivPaper[]`. The arXiv API returns Atom XML (not RSS) with `<entry>` elements containing `<title>`, `<summary>`, `<author>/<name>`, `<category term="..."/>`, `<published>`, and `<link>` elements.
**When to use:** In the `listArxivPapers` handler method.

```typescript
const xmlParser = new XMLParser({
  ignoreAttributes: false,  // Need attributes for <category term="..."> and <link href="...">
  attributeNamePrefix: '@_',
  isArray: (_name: string, jpath: string) => {
    // Force arrays for elements that can appear 1+ times
    return /\.(entry|author|category|link)$/.test(jpath);
  },
});

function parseArxivAtom(xml: string): ArxivPaper[] {
  const parsed = xmlParser.parse(xml);
  const feed = parsed?.feed;
  if (!feed) return [];

  const entries = feed.entry ?? [];
  return entries.map((entry: any) => {
    const id = (entry.id || '').split('/').pop() || '';
    const authors = (entry.author ?? []).map((a: any) => a.name || '');
    const categories = (entry.category ?? []).map((c: any) => c['@_term'] || '');
    const published = entry.published ? new Date(entry.published).getTime() : 0;
    const links = entry.link ?? [];
    const altLink = links.find((l: any) => l['@_rel'] === 'alternate');
    const url = altLink?.['@_href'] || entry.id || '';

    return {
      id,
      title: (entry.title || '').trim(),
      summary: (entry.summary || '').trim(),
      authors,
      categories,
      publishedAt: published,
      url,
    };
  });
}
```

**CRITICAL DIFFERENCE from aviation:** Aviation uses `ignoreAttributes: true` because FAA XML doesn't need attributes. ArXiv Atom XML uses attributes extensively (`<category term="cs.AI"/>`, `<link href="..." rel="alternate"/>`), so `ignoreAttributes` must be `false`.

### Pattern 3: GitHub Trending API with Fallback
**What:** Fetch from `api.gitterapp.com` (primary) with fallback to `gh-trending-api.herokuapp.com`.
**When to use:** In the `listTrendingRepos` handler method.
**Key concern:** Both are unofficial APIs that could go down at any time. The handler must gracefully return empty.

```typescript
const GITTER_API = 'https://api.gitterapp.com/repositories';
const FALLBACK_API = 'https://gh-trending-api.herokuapp.com/repositories';

async function fetchTrendingRepos(language: string, period: string): Promise<GithubRepo[]> {
  // Try primary
  const params = new URLSearchParams({ language, since: period });
  let response = await fetch(`${GITTER_API}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    // Try fallback
    response = await fetch(`${FALLBACK_API}/${language}?since=${period}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
  }

  const data = await response.json();
  if (!Array.isArray(data)) return [];
  return data.map(mapToProtoRepo);
}
```

### Pattern 4: Hacker News 2-Step Fetch with Bounded Concurrency
**What:** HN Firebase API requires two steps: (1) fetch story IDs from `/{type}stories.json`, (2) batch-fetch individual items from `/item/{id}.json`. Concurrency is bounded to avoid fan-out.
**When to use:** In the `listHackernewsItems` handler method.
**Directly ported from:** `api/hackernews.js` (legacy endpoint).

```typescript
const HN_BASE = 'https://hacker-news.firebaseio.com/v0';
const MAX_CONCURRENCY = 10;

async function fetchHNItems(feedType: string, limit: number): Promise<HackernewsItem[]> {
  const type = ALLOWED_TYPES.has(feedType) ? feedType : 'top';
  const idsResp = await fetch(`${HN_BASE}/${type}stories.json`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!idsResp.ok) return [];

  const ids: number[] = await idsResp.json();
  if (!Array.isArray(ids)) return [];
  const limitedIds = ids.slice(0, limit);

  // Fetch in bounded batches
  const items: HackernewsItem[] = [];
  for (let i = 0; i < limitedIds.length; i += MAX_CONCURRENCY) {
    const batch = limitedIds.slice(i, i + MAX_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const resp = await fetch(`${HN_BASE}/item/${id}.json`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) return null;
          return await resp.json();
        } catch { return null; }
      })
    );
    for (const r of results) {
      if (r) items.push(mapToProtoItem(r));
    }
  }
  return items;
}
```

### Pattern 5: Service Module for Research (Port/Adapter)
**What:** Since the research domain has no active consumers (the legacy services were never imported by UI code), the service module can be minimal. It wraps the generated `ResearchServiceClient`, provides 3 fetch functions, and re-exports types.
**When to use:** Plan 02.

```typescript
// src/services/research/index.ts
import {
  ResearchServiceClient,
  type ArxivPaper,
  type GithubRepo,
  type HackernewsItem,
} from '@/generated/client/worldmonitor/research/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Re-export proto types (no legacy mapping needed -- proto types are clean)
export type { ArxivPaper, GithubRepo, HackernewsItem };

const client = new ResearchServiceClient('');

const arxivBreaker = createCircuitBreaker<ArxivPaper[]>({ name: 'ArXiv Papers' });
const trendingBreaker = createCircuitBreaker<GithubRepo[]>({ name: 'GitHub Trending' });
const hnBreaker = createCircuitBreaker<HackernewsItem[]>({ name: 'Hacker News' });

export async function fetchArxivPapers(category = 'cs.AI'): Promise<ArxivPaper[]> {
  return arxivBreaker.execute(async () => {
    const resp = await client.listArxivPapers({ category, query: '', pagination: { pageSize: 50, cursor: '' } });
    return resp.papers;
  }, []);
}

export async function fetchTrendingRepos(language = 'python', period = 'daily'): Promise<GithubRepo[]> {
  return trendingBreaker.execute(async () => {
    const resp = await client.listTrendingRepos({ language, period, pagination: { pageSize: 50, cursor: '' } });
    return resp.repos;
  }, []);
}

export async function fetchHackernewsItems(feedType = 'top'): Promise<HackernewsItem[]> {
  return hnBreaker.execute(async () => {
    const resp = await client.listHackernewsItems({ feedType, pagination: { pageSize: 30, cursor: '' } });
    return resp.items;
  }, []);
}
```

### Anti-Patterns to Avoid
- **Using DOMParser in handler:** Not available in edge runtime. The legacy `src/services/arxiv.ts` uses `DOMParser` -- this must not be copied to the handler. Use `fast-xml-parser` instead.
- **Ignoring XML attributes for arXiv:** Unlike FAA XML (no useful attributes), arXiv Atom XML stores critical data in attributes (`<category term="cs.AI"/>`, `<link href="..." rel="alternate"/>`). Must set `ignoreAttributes: false`.
- **Unbounded concurrency for HN items:** The legacy endpoint caps concurrency at 10. Without this, fetching 60 items spawns 60 simultaneous fetches.
- **Logging fetch failures:** Per 2F-01, handler returns empty on ANY failure -- blocking/errors are expected, not logged.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| XML parsing | Regex-based extraction of arXiv Atom | `fast-xml-parser` with `ignoreAttributes: false` | Atom XML has nested author, category, link elements with attributes -- regex is fragile |
| Circuit breaker | Custom retry/timeout | `createCircuitBreaker` from `@/utils` | Established project pattern |
| HTTP client | Raw fetch with error handling | Generated `ResearchServiceClient` (in service module) | Type-safe, handles serialization |
| Concurrency control | Unbounded Promise.all for HN items | Bounded batch loop (MAX_CONCURRENCY = 10) | Prevents fan-out; direct port of legacy pattern |

**Key insight:** The arXiv XML parsing is the only genuinely complex technical challenge. GitHub trending and HN are straightforward JSON proxies. The handler is a composition of 3 independent proxy functions, not a single complex data pipeline.

## Common Pitfalls

### Pitfall 1: ArXiv XML Attribute Handling
**What goes wrong:** Setting `ignoreAttributes: true` (copy-paste from aviation handler config) causes `<category term="cs.AI"/>` to lose its `term` attribute, and `<link href="..." rel="alternate"/>` to lose both `href` and `rel`. Papers end up with empty categories and no URL.
**Why it happens:** Aviation handler uses `ignoreAttributes: true` because FAA XML doesn't have useful attributes. arXiv Atom XML is attribute-heavy.
**How to avoid:** Set `ignoreAttributes: false` and `attributeNamePrefix: '@_'` in the parser config. Access attributes via `entry.category[n]['@_term']` and `entry.link[n]['@_href']`.
**Warning signs:** Papers returned with empty `categories` array and empty `url` field.

### Pitfall 2: ArXiv isArray Configuration
**What goes wrong:** When only one paper has one author, fast-xml-parser returns `author` as a single object instead of an array. Code that maps `entry.author.map(...)` throws.
**Why it happens:** Same single-vs-array ambiguity as aviation's Ground_Delay. ArXiv papers can have 1 author, 1 category, or 1 link.
**How to avoid:** Use `isArray` option to force array wrapping for `entry`, `author`, `category`, and `link` elements.
**Warning signs:** Handler works for multi-author papers but crashes for single-author papers.

### Pitfall 3: GitHub Trending API Instability
**What goes wrong:** `api.gitterapp.com` is an unofficial scraper that can go down or change its response format without warning. The fallback `gh-trending-api.herokuapp.com` may also be dead (Heroku free tier was sunset in 2022).
**Why it happens:** Both are community-maintained, not official GitHub APIs.
**How to avoid:** The handler must return empty on failure (established pattern). The fallback is best-effort. If both fail, empty array is returned. Consider that this API may be permanently unavailable -- the service module's circuit breaker handles this gracefully.
**Warning signs:** Trending repos panel always empty. Not an error -- expected degradation per 2D-01/2F-01 patterns.

### Pitfall 4: HN Firebase Batch Timing
**What goes wrong:** Fetching story IDs succeeds but individual item fetches hit rate limits or timeouts when requesting too many concurrently.
**Why it happens:** Firebase API has per-IP rate limiting. 60 concurrent fetches can trigger throttling.
**How to avoid:** Use bounded concurrency (MAX_CONCURRENCY = 10) with sequential batches, exactly as the legacy `api/hackernews.js` does. Individual item fetch timeout is 5 seconds (shorter than the 10-second stories list timeout).
**Warning signs:** Some batches return nulls; total item count is less than requested.

### Pitfall 5: ArXiv Atom Namespace Handling
**What goes wrong:** ArXiv Atom XML uses the Atom namespace (`xmlns="http://www.w3.org/2005/Atom"`) and arxiv namespace (`xmlns:arxiv="http://arxiv.org/schemas/atom"`). fast-xml-parser may prefix element names with namespace prefixes.
**Why it happens:** XML namespace handling varies by parser configuration.
**How to avoid:** By default, fast-xml-parser does not process namespaces (it treats them as regular attributes). This is the desired behavior -- element names remain `entry`, `author`, `title`, etc., without namespace prefixes. Do NOT enable `processEntities` or namespace processing options.
**Warning signs:** Elements not found by expected names (e.g., looking for `entry` but finding `atom:entry`).

### Pitfall 6: Orphan Consumer Cleanup Scope
**What goes wrong:** Missing cleanup of `API_URLS.arxiv`, `API_URLS.githubTrending`, `API_URLS.hackernews` entries in `src/config/variants/base.ts` and corresponding `REFRESH_INTERVALS` entries. These become dead code referencing deleted endpoints.
**Why it happens:** The legacy services import `API_URLS` for their URL builders. When the service files are deleted, these config entries become orphaned. Easy to forget because they're in a separate file.
**How to avoid:** Explicitly delete the three `API_URLS` entries and three `REFRESH_INTERVALS` entries in Plan 02 alongside the service file deletions.
**Warning signs:** `API_URLS.arxiv` still present in config after migration -- lint may not catch it since it's just an unused property.

## Code Examples

### Example 1: arXiv Atom XML Sample Structure

This is the XML structure the handler must parse (simplified):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: cat:cs.AI</title>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Some Paper Title</title>
    <summary>Paper abstract text...</summary>
    <author><name>John Doe</name></author>
    <author><name>Jane Smith</name></author>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <published>2024-01-15T00:00:00Z</published>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/2401.12345v1" title="pdf" type="application/pdf"/>
  </entry>
</feed>
```

### Example 2: GitHub Trending API Response Shape

```json
[
  {
    "author": "openai",
    "name": "some-repo",
    "url": "https://github.com/openai/some-repo",
    "description": "A description",
    "language": "Python",
    "languageColor": "#3572A5",
    "stars": 15000,
    "forks": 2000,
    "currentPeriodStars": 500,
    "builtBy": [{"username": "user1", "href": "...", "avatar": "..."}]
  }
]
```

Maps to proto `GithubRepo`:
```typescript
function mapToProtoRepo(raw: any): GithubRepo {
  return {
    fullName: `${raw.author}/${raw.name}`,
    description: raw.description || '',
    language: raw.language || '',
    stars: raw.stars || 0,
    starsToday: raw.currentPeriodStars || 0,
    forks: raw.forks || 0,
    url: raw.url || `https://github.com/${raw.author}/${raw.name}`,
  };
}
```

### Example 3: HN Firebase API Item Shape

```json
{
  "id": 12345,
  "title": "Show HN: Something cool",
  "url": "https://example.com",
  "score": 150,
  "by": "someuser",
  "time": 1706000000,
  "descendants": 45,
  "type": "story"
}
```

Maps to proto `HackernewsItem`:
```typescript
function mapToProtoItem(raw: any): HackernewsItem {
  return {
    id: raw.id || 0,
    title: raw.title || '',
    url: raw.url || '',
    score: raw.score || 0,
    commentCount: raw.descendants || 0,
    by: raw.by || '',
    submittedAt: (raw.time || 0) * 1000,  // HN uses seconds, proto uses milliseconds
  };
}
```

**Note:** HN `time` is Unix seconds. Proto `submitted_at` is Unix epoch milliseconds (per project convention). Multiply by 1000.

### Example 4: Gateway Wiring (api/[[...path]].ts)

```typescript
// Add these imports:
import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server';
import { researchHandler } from './server/worldmonitor/research/v1/handler';

// Add to allRoutes:
const allRoutes = [
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),  // NEW
];
```

## Data Flow Analysis

### Current (Legacy) Flow -- ArXiv
```
Browser                    Vercel Edge (api/arxiv.js)    ArXiv API
  |                          |                             |
  |-- GET /api/arxiv ------->|-- fetch export.arxiv.org -->|
  |<-- raw XML --------------|<-- Atom XML ----------------|
  |                          |
  | DOMParser(xml)           |  (xml proxied unchanged)
  | parseArxivXML()          |
  |                          |
  v                          |
  ArxivPaper[]               |
```

### Target (Sebuf) Flow -- ArXiv
```
Browser                    Vercel Edge (Handler)           ArXiv API
  |                          |                             |
  |-- POST /api/research/ -->|-- fetch export.arxiv.org -->|
  |   /v1/list-arxiv-papers  |<-- Atom XML ----------------|
  |                          |                             |
  |                          | fast-xml-parser.parse(xml)  |
  |                          | mapToProtoShape()           |
  |                          |                             |
  |<-- JSON (proto-typed) ---|                             |
  |                          |
  | ResearchServiceClient    |
  | (no mapping needed)      |
  |                          |
  v                          |
  ArxivPaper[]               |
```

### Current Flow -- GitHub Trending
```
Browser                    Vercel Edge (api/github-trending.js)   Gitter API
  |                          |                                      |
  |-- GET /api/github- ----->|-- fetch api.gitterapp.com ---------> |
  |   trending               |<-- JSON ----------------------------|
  |<-- JSON (proxied) -------|                                      |
  |                          | (or fallback to herokuapp)           |
```

### Current Flow -- Hacker News
```
Browser                    Vercel Edge (api/hackernews.js)   HN Firebase
  |                          |                                  |
  |-- GET /api/hackernews -->|-- fetch /{type}stories.json ---> |
  |                          |<-- [id1, id2, ...] --------------|
  |                          |                                  |
  |                          |-- batch /item/{id}.json -------> |
  |                          |<-- story JSON -------------------|
  |                          |                                  |
  |<-- JSON (assembled) -----|  (concurrency bounded at 10)    |
```

## Consumer Inventory (for Plan 02 rewiring)

### Legacy Service Files (ALL ORPHANED -- no external consumers)
- `src/services/arxiv.ts` -- Defines `fetchArxivPapers`, `fetchAllAIPapers`, `getArxivStatus`, `ArxivPaper` type. **Not imported anywhere.** Not in `src/services/index.ts` barrel. DELETE.
- `src/services/github-trending.ts` -- Defines `fetchGitHubTrending`, `fetchAIMLTrending`, `getGitHubTrendingStatus`, `GitHubRepo` type. **Not imported anywhere.** Not in barrel. DELETE.
- `src/services/hackernews.ts` -- Defines `fetchHackerNews`, `fetchTopTechStories`, `fetchShowHN`, `fetchAskHN`, `getHackerNewsStatus`, `HackerNewsStory` type. **Not imported anywhere.** Not in barrel. DELETE.

### Legacy API Endpoints (callable via URL but no code references)
- `api/arxiv.js` -- DELETE
- `api/github-trending.js` -- DELETE
- `api/hackernews.js` -- DELETE

### Config Entries to Clean Up
- `src/config/variants/base.ts` -- Remove `arxiv`, `githubTrending`, `hackernews` from `API_URLS` object
- `src/config/variants/base.ts` -- Remove `arxiv`, `githubTrending`, `hackernews` from `REFRESH_INTERVALS` object

### Types
- No research-related types in `src/types/index.ts` -- nothing to remove there
- Proto types (`ArxivPaper`, `GithubRepo`, `HackernewsItem`) are already clean and don't need legacy mapping wrappers

### Services Barrel Export
- `src/services/index.ts` does NOT export from arxiv, github-trending, or hackernews -- no barrel changes needed for removal
- Optionally: could add research re-exports to barrel, but since there are no consumers, this is unnecessary now

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Browser-side XML parsing via DOMParser (arxiv) | Server-side parsing via fast-xml-parser | This migration | Handler returns structured JSON; client no longer needs DOMParser |
| Raw XML/JSON proxy endpoints (`api/arxiv.js`, `api/github-trending.js`, `api/hackernews.js`) | Proto-typed JSON endpoints (`/api/research/v1/*`) | This migration | Type-safe, consistent error handling, graceful degradation |
| Separate legacy endpoints for each data source | Single service with 3 RPCs | This migration | Unified service pattern; single handler file |
| Client-side data normalization in service files | Server-side normalization in handler | This migration | Browser receives ready-to-use proto-typed data |

## Open Questions

1. **GitHub Trending API availability**
   - What we know: The legacy endpoint uses `api.gitterapp.com` (primary) and `gh-trending-api.herokuapp.com` (fallback). Heroku sunsetted free tier in November 2022, so the fallback is likely dead.
   - What's unclear: Whether `api.gitterapp.com` is still operational. It's an unofficial scraper.
   - Recommendation: Implement both primary and fallback in the handler (direct port from legacy). If both fail, return empty array. This matches the established graceful degradation pattern. If gitterapp is confirmed dead, we can remove it later but the empty-on-failure behavior means no user-facing error.

2. **ArXiv Atom XML namespace behavior with fast-xml-parser**
   - What we know: ArXiv XML uses Atom namespace. fast-xml-parser by default does not process namespaces.
   - What's unclear: Whether the `xmlns` attribute on `<feed>` or namespace-prefixed elements (e.g., `<arxiv:primary_category>`) will cause parsing issues.
   - Recommendation: Start with default namespace handling (ignore namespaces). If `arxiv:` prefixed elements are needed, access them as `arxiv:primary_category` property name. The core elements (`entry`, `title`, `summary`, `author`, `category`, `link`, `published`) are all in the default Atom namespace and should parse without prefix.

3. **Pagination in research RPCs**
   - What we know: All three request/response protos include `pagination` fields (`PaginationRequest`/`PaginationResponse`). However, the upstream APIs handle pagination differently: arXiv uses `start` + `max_results`, HN uses array slicing, GitHub trending has no pagination.
   - What's unclear: Whether the handler should implement real pagination or just use `page_size` as a limit.
   - Recommendation: Use `pagination.page_size` as the limit parameter (or default). Return `pagination: undefined` in responses (no cursor-based pagination). This matches the prediction handler pattern which also returns `pagination: undefined`. Real pagination can be added later if needed.

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** -- All source files examined directly:
  - `api/arxiv.js` (legacy XML proxy endpoint)
  - `api/github-trending.js` (legacy JSON proxy with fallback)
  - `api/hackernews.js` (legacy 2-step Firebase proxy)
  - `src/services/arxiv.ts` (legacy service with DOMParser, orphaned)
  - `src/services/github-trending.ts` (legacy service, orphaned)
  - `src/services/hackernews.ts` (legacy service, orphaned)
  - `src/config/variants/base.ts` (API_URLS and REFRESH_INTERVALS)
  - `proto/worldmonitor/research/v1/service.proto` (3 RPCs)
  - `proto/worldmonitor/research/v1/research_item.proto` (ArxivPaper, GithubRepo, HackernewsItem)
  - `proto/worldmonitor/research/v1/list_arxiv_papers.proto`
  - `proto/worldmonitor/research/v1/list_trending_repos.proto`
  - `proto/worldmonitor/research/v1/list_hackernews_items.proto`
  - `src/generated/server/worldmonitor/research/v1/service_server.ts` (ResearchServiceHandler)
  - `src/generated/client/worldmonitor/research/v1/service_client.ts` (ResearchServiceClient)
  - `api/[[...path]].ts` (catch-all gateway)
  - `api/server/worldmonitor/aviation/v1/handler.ts` (reference: fast-xml-parser pattern)
  - `api/server/worldmonitor/prediction/v1/handler.ts` (reference: simple JSON proxy pattern)
  - `api/server/worldmonitor/displacement/v1/handler.ts` (reference: complex handler pattern)
  - `src/services/aviation/index.ts` (reference: service module with type mapping)
  - `src/services/displacement/index.ts` (reference: service module pattern)
  - `src/services/prediction/index.ts` (reference: service module pattern)
  - `src/services/index.ts` (barrel -- confirms no research exports)

### Secondary (MEDIUM confidence)
- ArXiv API documentation (Atom XML format) -- structure inferred from `src/services/arxiv.ts` DOMParser code and known Atom feed structure
- HN Firebase API -- structure inferred from `api/hackernews.js` and documented at https://github.com/HackerNews/API

### Tertiary (LOW confidence)
- `api.gitterapp.com` availability -- unofficial API, may be down. Cannot verify without live request.
- `gh-trending-api.herokuapp.com` availability -- likely dead (Heroku free tier sunset 2022). Cannot verify without live request.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- fast-xml-parser already in project, proven in aviation handler, no new deps needed
- Architecture: HIGH -- follows established 2-plan migration pattern from 6 prior domains, identical handler/gateway/service-module structure
- Pitfalls: HIGH -- pitfalls identified from direct code analysis; XML attribute handling is the key novel risk; all other patterns are direct ports of working legacy code
- Consumer rewiring: HIGH -- comprehensive grep confirms all 3 legacy services are orphaned (no external consumers); cleanup is purely deletion with no UI impact

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable domain, no fast-moving dependencies)
