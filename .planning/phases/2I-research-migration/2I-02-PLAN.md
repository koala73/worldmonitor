---
phase: 2I-research-migration
plan: 02
type: execute
wave: 2
depends_on:
  - 2I-01
files_modified:
  - src/services/research/index.ts
  - src/config/variants/base.ts
  - api/arxiv.js
  - api/github-trending.js
  - api/hackernews.js
  - src/services/arxiv.ts
  - src/services/github-trending.ts
  - src/services/hackernews.ts
autonomous: true
requirements:
  - DOMAIN-05
  - SERVER-02

must_haves:
  truths:
    - "Service module exports fetchArxivPapers, fetchTrendingRepos, fetchHackernewsItems backed by ResearchServiceClient"
    - "Proto types ArxivPaper, GithubRepo, HackernewsItem re-exported from service module"
    - "All three legacy API endpoints deleted (api/arxiv.js, api/github-trending.js, api/hackernews.js)"
    - "All three legacy service files deleted (src/services/arxiv.ts, src/services/github-trending.ts, src/services/hackernews.ts)"
    - "Config entries for arxiv, githubTrending, hackernews removed from API_URLS and REFRESH_INTERVALS"
  artifacts:
    - path: "src/services/research/index.ts"
      provides: "Port/adapter service module for research domain"
      exports: ["fetchArxivPapers", "fetchTrendingRepos", "fetchHackernewsItems", "ArxivPaper", "GithubRepo", "HackernewsItem"]
  key_links:
    - from: "src/services/research/index.ts"
      to: "src/generated/client/worldmonitor/research/v1/service_client.ts"
      via: "import ResearchServiceClient"
      pattern: "ResearchServiceClient"
    - from: "src/services/research/index.ts"
      to: "@/utils"
      via: "import createCircuitBreaker"
      pattern: "createCircuitBreaker"
---

<objective>
Create the research service module (port/adapter), delete all legacy research code and config entries.

Purpose: Complete the research domain migration by providing a clean service module for future consumers and removing all dead legacy code.
Output: Service module at src/services/research/index.ts, 6 legacy files deleted, config cleaned.
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
@.planning/phases/2I-research-migration/2I-01-SUMMARY.md

# Reference service modules (patterns to follow)
@src/services/aviation/index.ts
@src/services/prediction/index.ts

# Generated client (what the service module wraps)
@src/generated/client/worldmonitor/research/v1/service_client.ts

# Config to clean
@src/config/variants/base.ts

# Legacy files to delete (verify they exist before deleting)
@api/arxiv.js
@api/github-trending.js
@api/hackernews.js
@src/services/arxiv.ts
@src/services/github-trending.ts
@src/services/hackernews.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create research service module and delete legacy code</name>
  <files>
    src/services/research/index.ts
    src/config/variants/base.ts
    api/arxiv.js
    api/github-trending.js
    api/hackernews.js
    src/services/arxiv.ts
    src/services/github-trending.ts
    src/services/hackernews.ts
  </files>
  <action>
**1. Create service module** at `src/services/research/index.ts`:

This domain has a unique characteristic: the proto types (`ArxivPaper`, `GithubRepo`, `HackernewsItem`) are already clean with no enums or GeoCoordinates to map. No legacy consumers exist to maintain backward compatibility with. The service module is therefore a thin port/adapter -- just wraps the generated client with circuit breakers.

```typescript
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

export async function fetchArxivPapers(
  category = 'cs.AI',
  query = '',
  pageSize = 50,
): Promise<ArxivPaper[]> {
  return arxivBreaker.execute(async () => {
    const resp = await client.listArxivPapers({
      category,
      query,
      pagination: { pageSize, cursor: '' },
    });
    return resp.papers;
  }, []);
}

export async function fetchTrendingRepos(
  language = 'python',
  period = 'daily',
  pageSize = 50,
): Promise<GithubRepo[]> {
  return trendingBreaker.execute(async () => {
    const resp = await client.listTrendingRepos({
      language,
      period,
      pagination: { pageSize, cursor: '' },
    });
    return resp.repos;
  }, []);
}

export async function fetchHackernewsItems(
  feedType = 'top',
  pageSize = 30,
): Promise<HackernewsItem[]> {
  return hnBreaker.execute(async () => {
    const resp = await client.listHackernewsItems({
      feedType,
      pagination: { pageSize, cursor: '' },
    });
    return resp.items;
  }, []);
}
```

**2. Clean config entries** in `src/config/variants/base.ts`:
- Remove `arxiv` entry from `API_URLS` object (the function that builds `/api/arxiv?...` URL)
- Remove `githubTrending` entry from `API_URLS` object (the function that builds `/api/github-trending?...` URL)
- Remove `hackernews` entry from `API_URLS` object (the function that builds `/api/hackernews?...` URL)
- Remove `arxiv` entry from `REFRESH_INTERVALS` object
- Remove `githubTrending` entry from `REFRESH_INTERVALS` object
- Remove `hackernews` entry from `REFRESH_INTERVALS` object

**3. Delete legacy API endpoints:**
- `rm api/arxiv.js`
- `rm api/github-trending.js`
- `rm api/hackernews.js`

**4. Delete legacy service files:**
- `rm src/services/arxiv.ts`
- `rm src/services/github-trending.ts`
- `rm src/services/hackernews.ts`

Note: Research confirms all 3 service files are orphaned (not imported by any UI code, not in the services barrel export). Deletion has zero consumer impact.
  </action>
  <verify>
1. `npx tsc --noEmit` -- passes (no broken imports from deletion)
2. `ls api/arxiv.js api/github-trending.js api/hackernews.js 2>&1` -- all "No such file"
3. `ls src/services/arxiv.ts src/services/github-trending.ts src/services/hackernews.ts 2>&1` -- all "No such file"
4. `grep -c 'arxiv\|githubTrending\|hackernews' src/config/variants/base.ts` -- returns 0
5. `ls src/services/research/index.ts` -- exists
  </verify>
  <done>Research service module created with 3 fetch functions and re-exported types. All 6 legacy files deleted. Config entries for arxiv, githubTrending, hackernews removed from API_URLS and REFRESH_INTERVALS. TypeScript compilation passes with no broken imports.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` -- zero errors across entire project
2. Service module exports 3 functions + 3 types
3. No legacy research files remain (6 files deleted)
4. No orphaned config entries remain
5. No broken imports anywhere in the codebase
</verification>

<success_criteria>
- src/services/research/index.ts exports fetchArxivPapers, fetchTrendingRepos, fetchHackernewsItems
- Proto types re-exported (ArxivPaper, GithubRepo, HackernewsItem)
- Circuit breakers wrap all 3 client calls with empty-array fallback
- Legacy endpoints deleted (api/arxiv.js, api/github-trending.js, api/hackernews.js)
- Legacy services deleted (src/services/arxiv.ts, src/services/github-trending.ts, src/services/hackernews.ts)
- Config entries removed from API_URLS and REFRESH_INTERVALS
- Full project TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2I-research-migration/2I-02-SUMMARY.md`
</output>
