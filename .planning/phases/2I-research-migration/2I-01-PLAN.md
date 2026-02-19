---
phase: 2I-research-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/research/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements:
  - DOMAIN-05
  - SERVER-02

must_haves:
  truths:
    - "POST /api/research/v1/list-arxiv-papers returns JSON with papers array containing id, title, summary, authors, categories, publishedAt, url fields"
    - "POST /api/research/v1/list-trending-repos returns JSON with repos array containing fullName, description, language, stars, starsToday, forks, url fields"
    - "POST /api/research/v1/list-hackernews-items returns JSON with items array containing id, title, url, score, commentCount, by, submittedAt fields"
    - "All three RPCs return empty arrays (not errors) when upstream APIs fail"
  artifacts:
    - path: "api/server/worldmonitor/research/v1/handler.ts"
      provides: "ResearchServiceHandler with 3 RPC implementations"
      exports: ["researchHandler"]
    - path: "api/[[...path]].ts"
      provides: "Research routes mounted in catch-all gateway"
      contains: "createResearchServiceRoutes"
  key_links:
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/research/v1/handler.ts"
      via: "import researchHandler"
      pattern: "import.*researchHandler.*from.*handler"
    - from: "api/server/worldmonitor/research/v1/handler.ts"
      to: "src/generated/server/worldmonitor/research/v1/service_server.ts"
      via: "implements ResearchServiceHandler interface"
      pattern: "ResearchServiceHandler"
---

<objective>
Implement the research domain handler with 3 RPCs (arXiv, GitHub trending, Hacker News) and mount routes in the catch-all gateway.

Purpose: Server-side data processing for all three research sources -- arXiv XML parsing replaces browser-side DOMParser, GitHub trending and HN become proto-typed JSON endpoints.
Output: Working handler at api/server/worldmonitor/research/v1/handler.ts, routes mounted in gateway, sidecar rebuilt.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2I-research-migration/2I-RESEARCH.md

# Reference handlers (patterns to follow)
@api/server/worldmonitor/aviation/v1/handler.ts
@api/server/worldmonitor/prediction/v1/handler.ts

# Generated server types (handler interface)
@src/generated/server/worldmonitor/research/v1/service_server.ts

# Gateway to modify
@api/[[...path]].ts

# Sidecar build script
@scripts/build-sidecar-sebuf.mjs
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement ResearchServiceHandler with 3 RPCs</name>
  <files>api/server/worldmonitor/research/v1/handler.ts</files>
  <action>
Create `api/server/worldmonitor/research/v1/handler.ts` implementing the generated `ResearchServiceHandler` interface with 3 independent RPC methods.

**Imports:**
- `XMLParser` from `fast-xml-parser`
- Types from `../../../../../src/generated/server/worldmonitor/research/v1/service_server`: `ResearchServiceHandler`, `ServerContext`, `ListArxivPapersRequest`, `ListArxivPapersResponse`, `ArxivPaper`, `ListTrendingReposRequest`, `ListTrendingReposResponse`, `GithubRepo`, `ListHackernewsItemsRequest`, `ListHackernewsItemsResponse`, `HackernewsItem`

**RPC 1: listArxivPapers** -- Proxies arXiv Atom XML API
- URL: `https://export.arxiv.org/api/query?search_query=cat:${category}&start=0&max_results=${pageSize}` where `category` defaults to `'cs.AI'` if empty, `pageSize` from `req.pagination?.pageSize || 50`
- If `req.query` is non-empty, use `search_query=all:${query}+AND+cat:${category}` instead
- Fetch with `{ headers: { Accept: 'application/xml' }, signal: AbortSignal.timeout(15000) }`
- Parse response XML with `fast-xml-parser` configured as:
  ```
  const xmlParser = new XMLParser({
    ignoreAttributes: false,    // CRITICAL: arXiv uses attributes for category term, link href/rel
    attributeNamePrefix: '@_',
    isArray: (_name: string, jpath: string) => /\.(entry|author|category|link)$/.test(jpath),
  });
  ```
  **WARNING:** Do NOT copy `ignoreAttributes: true` from aviation handler. ArXiv Atom XML stores critical data in attributes (`<category term="cs.AI"/>`, `<link href="..." rel="alternate"/>`).
- Map parsed XML to `ArxivPaper[]`:
  - `id`: extract from `entry.id` string -- take last segment after last `/` (e.g., `http://arxiv.org/abs/2401.12345v1` -> `2401.12345v1`)
  - `title`: `(entry.title || '').trim().replace(/\s+/g, ' ')` (arXiv titles can have internal newlines)
  - `summary`: `(entry.summary || '').trim().replace(/\s+/g, ' ')`
  - `authors`: `(entry.author ?? []).map((a: any) => a.name || '')`
  - `categories`: `(entry.category ?? []).map((c: any) => c['@_term'] || '')`
  - `publishedAt`: `entry.published ? new Date(entry.published).getTime() : 0` (Unix epoch ms per project convention)
  - `url`: find link with `@_rel === 'alternate'`, use its `@_href`; fallback to `entry.id`
- Return `{ papers, pagination: undefined }`
- On ANY error: return `{ papers: [], pagination: undefined }`

**RPC 2: listTrendingRepos** -- Proxies GitHub trending JSON API with fallback
- Primary URL: `https://api.gitterapp.com/repositories?language=${language}&since=${period}`
  - `language` defaults to `'python'` if empty, `period` defaults to `'daily'` if empty
  - Fetch with `{ headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' }, signal: AbortSignal.timeout(10000) }`
- If primary fails (!response.ok), try fallback: `https://gh-trending-api.herokuapp.com/repositories/${language}?since=${period}`
  - Fetch with `{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }`
  - If fallback also fails, return empty
- Parse JSON response (array of objects), map to `GithubRepo[]`:
  - `fullName`: `${raw.author}/${raw.name}`
  - `description`: `raw.description || ''`
  - `language`: `raw.language || ''`
  - `stars`: `raw.stars || 0`
  - `starsToday`: `raw.currentPeriodStars || 0`
  - `forks`: `raw.forks || 0`
  - `url`: `raw.url || 'https://github.com/${raw.author}/${raw.name}'`
- Limit to `req.pagination?.pageSize || 50` items
- Return `{ repos, pagination: undefined }`
- On ANY error: return `{ repos: [], pagination: undefined }`

**RPC 3: listHackernewsItems** -- Proxies HN Firebase JSON API (2-step fetch)
- Step 1: Fetch story IDs from `https://hacker-news.firebaseio.com/v0/${feedType}stories.json`
  - `feedType` from request, validated against allowed set: `['top', 'new', 'best', 'ask', 'show', 'job']`, default to `'top'` if empty or not in set
  - Fetch with `{ signal: AbortSignal.timeout(10000) }`
  - If not ok or not an array, return empty
- Step 2: Batch-fetch individual items from `https://hacker-news.firebaseio.com/v0/item/${id}.json`
  - Slice IDs to `req.pagination?.pageSize || 30`
  - Use bounded concurrency: `MAX_CONCURRENCY = 10`
  - Loop over IDs in batches of 10, `Promise.all` each batch
  - Each individual fetch gets `AbortSignal.timeout(5000)` (shorter than story list timeout)
  - Filter out nulls and non-story results
- Map to `HackernewsItem[]`:
  - `id`: `raw.id || 0`
  - `title`: `raw.title || ''`
  - `url`: `raw.url || ''`
  - `score`: `raw.score || 0`
  - `commentCount`: `raw.descendants || 0`
  - `by`: `raw.by || ''`
  - `submittedAt`: `(raw.time || 0) * 1000` (HN uses Unix seconds, proto uses milliseconds)
- Return `{ items, pagination: undefined }`
- On ANY error: return `{ items: [], pagination: undefined }`

**Each RPC is wrapped in its own try/catch returning empty on failure** (established pattern from 2F-01). No error logging on upstream failures.

Export: `export const researchHandler: ResearchServiceHandler = { ... }`
  </action>
  <verify>
Run `npx tsc --noEmit -p tsconfig.api.json` -- must pass with no type errors in the handler file. Verify the file exists at the expected path.
  </verify>
  <done>Handler file implements ResearchServiceHandler with 3 typed RPC methods. All imports resolve. fast-xml-parser configured with ignoreAttributes: false for arXiv XML attribute parsing.</done>
</task>

<task type="auto">
  <name>Task 2: Mount research routes in gateway and rebuild sidecar</name>
  <files>api/[[...path]].ts</files>
  <action>
**Gateway wiring** -- Add research to the catch-all gateway (`api/[[...path]].ts`):

1. Add import for route creator:
   ```typescript
   import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server';
   ```

2. Add import for handler:
   ```typescript
   import { researchHandler } from './server/worldmonitor/research/v1/handler';
   ```

3. Add to `allRoutes` array (after aviation):
   ```typescript
   ...createResearchServiceRoutes(researchHandler, serverOptions),
   ```

**Sidecar rebuild:**
Run `npm run build:sidecar-sebuf` to compile the updated gateway into the sidecar bundle. This ensures Tauri desktop app includes research routes.

**Verification:**
Run `npx tsc --noEmit -p tsconfig.api.json` to confirm all imports resolve and types align.
  </action>
  <verify>
1. `npx tsc --noEmit -p tsconfig.api.json` passes
2. `npm run build:sidecar-sebuf` succeeds with no errors
3. `grep -c 'createResearchServiceRoutes' api/[[...path]].ts` returns 1
  </verify>
  <done>Research routes mounted in catch-all gateway. Sidecar bundle rebuilt with research endpoints included. All 3 RPCs routable at /api/research/v1/list-arxiv-papers, /api/research/v1/list-trending-repos, /api/research/v1/list-hackernews-items.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit -p tsconfig.api.json` -- zero errors
2. `npm run build:sidecar-sebuf` -- successful build
3. Handler exports `researchHandler` implementing `ResearchServiceHandler`
4. Gateway imports and mounts research routes
5. All 3 RPC paths reachable through the gateway router
</verification>

<success_criteria>
- ResearchServiceHandler implementation with 3 working RPC methods
- arXiv XML parsing uses fast-xml-parser with ignoreAttributes: false and isArray for safe array wrapping
- GitHub trending fetches with primary + fallback URLs
- HN Firebase API uses 2-step fetch with bounded concurrency (10)
- All RPCs return empty on failure (graceful degradation)
- Routes mounted in catch-all gateway
- Sidecar bundle rebuilt
- TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2I-research-migration/2I-01-SUMMARY.md`
</output>
