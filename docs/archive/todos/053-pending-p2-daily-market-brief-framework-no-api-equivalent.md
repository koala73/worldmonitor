---
status: pending
priority: p2
issue_id: "053"
tags: [code-review, quality, agent-native, analytical-frameworks]
dependencies: []
---

# DailyMarketBrief framework injection is client-only — no API equivalent, misleads API consumers

## Problem Statement
The framework selector for `DailyMarketBriefPanel` is listed alongside CountryBrief, Deduction, and Insights as a first-class framework panel. However, the framework is injected entirely client-side: `data-loader.ts` calls `buildDailyMarketBrief({ frameworkAppend: getActiveFrameworkForPanel('daily-market-brief')?.systemPromptAppend })` which runs in the browser. There is no server-side equivalent. An agent calling `POST /api/news/v1/summarize-article` with `systemAppend` gets framework-shaped base summaries but does NOT get the full DailyMarketBrief structure (items, stances, actionPlan, riskWatch). The PR description does not document this limitation.

## Findings
- **`src/app/data-loader.ts:1468`** — `frameworkAppend: getActiveFrameworkForPanel('daily-market-brief')?.systemPromptAppend` — client-side only
- **`src/services/daily-market-brief.ts:416`** — `buildDailyMarketBrief` runs in browser; calls `generateSummary` via RPC but the full pipeline is client-side
- PR body lists DailyMarketBrief as having framework support with no caveat (unlike InsightsPanel which has a `*` note)
- Flagged by: agent-native-reviewer

## Proposed Solutions

### Option A: Document the limitation in PR and add `*` note to DailyMarketBrief selector (Recommended for now)
Add a UI note to the DailyMarketBrief `FrameworkSelector` (like InsightsPanel's `*` note) indicating "Applies to client-generated analysis only". Update PR description to match.
**Pros:** Honest documentation, no server changes needed | **Effort:** Trivial | **Risk:** Low

### Option B: Add server-side DailyMarketBrief endpoint accepting `systemAppend`
Create an RPC endpoint for `buildDailyMarketBrief` that accepts `systemAppend` and returns the full structured output.
**Pros:** Full agent-native parity | **Cons:** Large architectural change, moves complex client logic to server | **Effort:** Large | **Risk:** High (scope creep)

## Technical Details
- Files: `src/app/data-loader.ts`, `src/services/daily-market-brief.ts`, `src/components/DailyMarketBriefPanel.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] DailyMarketBrief `FrameworkSelector` has a `*` note indicating client-only scope (like InsightsPanel)
- [ ] PR description updated to document the limitation
- [ ] Or: server-side DailyMarketBrief endpoint added with `systemAppend` support

## Work Log
- 2026-03-27: Identified during PR #2380 review by agent-native-reviewer
