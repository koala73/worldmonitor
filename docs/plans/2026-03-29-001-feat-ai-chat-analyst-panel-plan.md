---
title: "feat: SIGINT Analyst — Pro-only conversational AI chat panel with full dashboard context"
type: feat
status: completed
date: 2026-03-29
---

# SIGINT Analyst — Pro Conversational AI Chat Panel

## Overview

A pro-only conversational AI analyst panel that gives premium users a multi-turn chat interface backed by live WorldMonitor data. Unlike static auto-briefs, the analyst can answer specific questions, probe a topic across multiple turns, and synthesize across all data domains simultaneously — geopolitical, market, military, economic, forecasts, and prediction markets.

Context is assembled **server-side** from Redis-cached data so the client never sends raw dashboard state to a third-party LLM provider. The LLM sees a structured, privacy-respecting snapshot. Responses stream via the existing SSE infrastructure (`api/widget-agent.ts` pattern).

---

## Problem Statement

The current AI layer (WorldBrief, CountryBrief, MarketBrief) produces scheduled, one-way briefs. A user who wants to ask "what's driving the risk around Taiwan right now?" or "which of today's forecasts have the highest market signal?" cannot. Every answer requires reading across 5+ separate panels and synthesizing manually. The chat analyst collapses that into a single conversational surface, gated to pro as a meaningful tier differentiator.

---

## Proposed Solution

A `ChatAnalystPanel` extending the base `Panel` class, registered as a pro panel in the existing gating system. A new Sebuf RPC (`ChatAnalystService.SendMessage`) accepts the current user query plus conversation history and returns a streamed analyst response. Server-side context assembly pulls from Redis on every request — world brief, CII scores, market implications cards, AI forecasts, top clusters, live market data, prediction markets, and optionally a country brief if the user has set a geo focus.

**Streaming:** Uses the existing edge SSE proxy pattern from `api/widget-agent.ts`. The edge function validates auth, assembles context from Redis, calls `callLlmReasoning()`, and streams the `ReadableStream` body directly to the browser. Client reads with `getReader()` + `TextDecoder` + `data:` line parsing (identical to `WidgetChatModal.ts`).

---

## Technical Approach

### Architecture

```
Browser (ChatAnalystPanel)
  → premiumFetch POST /api/intelligence/v1/[rpc] (ChatAnalyst.SendMessage)
  → api/intelligence/v1/[rpc].ts  (edge, validates auth via isCallerPremium)
  → server/worldmonitor/intelligence/v1/chat-analyst.ts
      → assembleAnalystContext()  (reads 8 Redis keys in parallel)
      → buildAnalystSystemPrompt(context, domainFocus)
      → callLlmReasoning({ messages, systemAppend, streaming: true })
      → streams ReadableStream back as SSE
  → ChatAnalystPanel reads chunks, renders in-place
```

### Context Sources (server-side, Redis)

All fetched in parallel via `Promise.allSettled` — partial failure is graceful (missing source is omitted from prompt, not a fatal error).

| Source | Redis key | Prompt section |
|--------|-----------|----------------|
| World Brief | `intelligence:world-brief:v1` | "Current Situation" |
| CII Risk Scores | `risk:cii:v1` | "Country Risk Index (top 15)" |
| Market Implications | `intelligence:market-implications:v1:*` | "AI Market Signals" |
| AI Forecasts | `intelligence:forecasts:*` | "Active Forecasts" |
| Top News Clusters | `intelligence:world-brief:v1` (topStories) | "Breaking Events" |
| Live Market Data | `market:stocks:v1`, `market:commodities:v1`, `market:crypto:v1` | "Market Data" |
| Prediction Markets | `prediction:markets-bootstrap:v1` | "Prediction Markets" |
| Country Brief (optional) | `intelligence:country-brief:v1:{iso2}` | "Country Focus" |
| Economic Signals | `economic:macro-signals:v1` | "Macro Signals" |

Context is trimmed to fit within a token budget (~3500 tokens for context, 1500 for response):
- News clusters: top 12, titles only (no full text)
- Market data: price + 1-day change only
- Prediction markets: top 8 by volume
- Market implications: title + direction + confidence (no full narrative)
- Forecasts: title + domain + probability (no rationale)
- CII scores: top 15 by score

### System Prompt Design

```
You are a senior intelligence analyst with access to live WorldMonitor data as of {timestamp}.
Respond in structured prose. Lead with the key insight. Max 250 words unless explicitly asked for more.
Use SITUATION / ANALYSIS / WATCH format for geopolitical queries.
For market queries: SIGNAL / THESIS / RISK.
Never speculate beyond what the data supports. Acknowledge uncertainty explicitly.
Never cite the data source by name (no "according to CII" — just use the fact).

--- LIVE CONTEXT ---
{assembledContext}
--- END CONTEXT ---
```

### Conversation History

- Client maintains history as `{ role: 'user' | 'assistant', content: string }[]`
- Capped at **last 10 message pairs (20 messages)** — older pairs dropped from the front
- Content trimmed to **800 chars per message** before sending to server
- System prompt is always index 0, rebuilt fresh per request (context snapshot is per-request)
- History is stored in component state only — not persisted to localStorage or Redis (session-scoped)

### Streaming Pattern

Follows `api/widget-agent.ts` exactly:

**Edge function** (`api/intelligence/v1/[rpc].ts`):
- Returns `Content-Type: text/event-stream`, `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-store`
- Pipes `ReadableStream` from `callLlmReasoning()` directly as response body
- `isCallerPremium()` gate returns 403 for non-pro callers

**Client** (`ChatAnalystPanel`):
```ts
const res = await premiumFetch(url, { method: 'POST', body: JSON.stringify(req) });
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop()!;
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const payload = JSON.parse(line.slice(6));
      if (payload.delta) appendToCurrentMessage(payload.delta);
      if (payload.done) finalizeMessage();
    }
  }
}
```

**Abort:** `AbortController` with 90-second timeout for pro tier. Cleanup on panel `destroy()`.

---

## Panel UI Design

```
┌─ SIGINT Analyst ────────────────────────── PRO ─ [C] [↓] ─┐
│                                                              │
│  [All ●] [Market] [Geo] [Military] [Economic]               │  ← domain filter chips
│                                                              │
│  ┌── ANALYST ──────────────────────────────────────────┐   │
│  │ Ready. I have live context across geopolitical,    │   │
│  │ market, military, and economic domains.            │   │
│  └────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌── YOU ──────────────────────────────────────────────┐   │
│  │ What's the biggest macro risk this week?           │   │
│  └────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌── ANALYST ──────────────────────────────────────────┐   │
│  │ SITUATION: Federal Reserve signaling...            │   │
│  │ ▓▓▓▓▓▓░░░░ streaming...                           │   │
│  └────────────────────────────────────────────────────┘   │
│                                                              │
│  [Summarize today] [Key market moves] [Top conflicts]       │  ← quick actions
│  [Active forecasts] [Highest risk countries]                │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  ┌─ Ask the analyst... ─────────────┐  [Focus ▾] [Send ▶]  │
│  └──────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

**Domain filter chips** — client-side hint only, appended to system prompt as `domainFocus`. Changes domain chip refreshes context focus but doesn't re-fetch Redis (context always full, chip is emphasis).

**Quick-action buttons** — pre-fill textarea and auto-send on click. Wired via event delegation on `this.content`.

**[C]** — clear session (wipes `conversationHistory`, shows welcome message).
**[↓]** — export session as `.md` file (client-side download).

**Message rendering:** No inline HTML from LLM output. Content is escaped, then basic markdown applied: `**bold**`, `- list`, `\n` → `<br>`. Same `basicMarkdownToHtml()` pattern (implement safely with escape-first approach).

---

## Pro Gating — All 4 Layers

Per `worldmonitor-pro-panel-gating` institutional pattern — ALL must be wired:

1. **`src/config/panels.ts`** — add `ChatAnalystPanel` config with `premium: 'locked'`
2. **`src/app/panel-layout.ts`** — add `'chat-analyst'` to `WEB_PREMIUM_PANELS` set
3. **`src/app/data-loader.ts`** — guard `loadChatAnalyst()` with `!isProUser()` check (panel has no seed data, but entry must exist for `isPanelEntitled()`)
4. **`src/App.ts`** — wire into `primeVisiblePanelData` for pro users

**Server-side:** All `ChatAnalyst.SendMessage` handler calls guarded by `isCallerPremium(ctx.request)`. Non-pro gets 403. Client uses `premiumFetch` for automatic auth injection (Clerk Bearer or wm-pro-key).

**Bootstrap:** No Redis key for this panel in `BOOTSTRAP_CACHE_KEYS` or `SLOW_KEYS`. The panel has no pre-seeded content — responses are real-time, not cached.

---

## Implementation Phases

### Phase 1: Proto + Server Handler (no streaming yet)

**Files:**
- `proto/worldmonitor/intelligence/v1/chat_analyst.proto` — new messages + RPC
- `buf generate` → regenerate `src/generated/`
- `server/worldmonitor/intelligence/v1/chat-analyst.ts` — handler
- `server/worldmonitor/intelligence/v1/chat-analyst-context.ts` — context assembler
- `server/worldmonitor/intelligence/v1/chat-analyst-prompt.ts` — system prompt builder
- `server/worldmonitor/intelligence/v1/handler.ts` — register new RPC

**Proto:**
```protobuf
message ChatAnalystMessage {
  string role = 1;
  string content = 2;
}

message ChatAnalystRequest {
  repeated ChatAnalystMessage history = 1;
  string query = 2;
  string domain_focus = 3;  // "all" | "market" | "geo" | "military" | "economic"
  string geo_context = 4;   // optional ISO2 for country focus
}

message ChatAnalystResponse {
  string response = 1;
  bool degraded = 2;
  string error = 3;
}
```

**Handler (`chat-analyst.ts`):**
```ts
export async function chatAnalyst(ctx, req): Promise<ChatAnalystResponse> {
  if (!isCallerPremium(ctx.request)) return { response: '', degraded: true, error: 'pro_required' };
  const context = await assembleAnalystContext(req.geoContext, req.domainFocus);
  const systemPrompt = buildAnalystSystemPrompt(context, req.domainFocus);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...req.history.map(m => ({ role: m.role, content: m.content.slice(0, 800) })).slice(-20),
    { role: 'user', content: sanitizeForPrompt(req.query) },
  ];
  const result = await callLlmReasoning({ messages, maxTokens: 600, timeoutMs: 30_000, stripThinkingTags: true });
  return { response: result?.content ?? '', degraded: !result, error: result ? '' : 'llm_unavailable' };
}
```

**Context assembler (`chat-analyst-context.ts`):**
```ts
export async function assembleAnalystContext(geoContext?: string, domainFocus?: string): Promise<AnalystContext> {
  // Parallel Redis fetch for all 9 data sources
  // Each source: try cachedFetchJson key, return null on miss
  // Returns structured AnalystContext object
  // Trim each source to token budget
}
```

### Phase 2: Streaming Edge Function

**Files:**
- `api/intelligence/v1/[rpc].ts` — already exists, extend to handle streaming for `ChatAnalyst`

Add streaming path in the edge handler: detect `ChatAnalyst.SendMessage`, validate auth, assemble context, call `callLlmReasoning` with stream mode, pipe body as SSE.

> Note: `callLlm()` in `server/_shared/llm.ts` may need a `stream: true` option added. Check if `widget-agent.ts` already augments `callLlm` for streaming or calls the provider directly. Follow that exact pattern.

### Phase 3: `ChatAnalystPanel` Component

**Files:**
- `src/components/ChatAnalystPanel.ts` — panel component
- `src/config/panels.ts` — register panel
- `src/app/panel-layout.ts` — add to `WEB_PREMIUM_PANELS`

**Key implementation rules:**
- Use `replaceChildren(this.content, container)` not `setContent()` for DOM that needs immediate event listener attachment
- All listeners via event delegation on `this.content`
- `AbortController` stored as instance var; `destroy()` calls `abort()` + `super.destroy()`
- `premiumFetch` for all RPC calls (Clerk Bearer or wm-pro-key auto-injected)
- Escape all LLM output before rendering: `escapeHtml()` first, then safe markdown transforms

### Phase 4: Pro Gating + Settings

**Files:**
- `src/app/panel-layout.ts` — `WEB_PREMIUM_PANELS` entry
- `src/config/panels.ts` — panel registration with `premium: 'locked'`
- `src/services/preferences-content.ts` — optional pro settings section (model preference in future)

### Phase 5: Quick Actions + Domain Filter

- 5 quick-action prompts that pre-fill and auto-send
- Domain filter chips update `domainFocus` field sent with each message
- Domain chips do NOT clear conversation history (filter is per-message context hint)

---

## Alternative Approaches Considered

**Client-side context assembly (amruth112 approach):** Rejected. Sends raw `AppContext` data (possibly including internal structure) to LLM provider via browser. Server-side assembly from Redis is cleaner, more secure, and cheaper (server can fetch only what's needed vs client marshalling everything).

**Floating widget (amruth112 approach):** Rejected. WorldMonitor uses a grid panel system — all panels are grid-aware, resizable, collapsible, and persist span. A floating div breaks the established component contract and doesn't get free resize/collapse behavior.

**Per-session Redis caching:** Rejected. Conversation context is unique per session and changes rapidly. No meaningful cache hit rate. Adds complexity for zero benefit. Each request hits Redis for live context (already fast, sub-50ms).

**LocalStorage key persistence:** Rejected for API keys. Pro users are authenticated via Clerk — no API key entry needed. `premiumFetch` handles auth injection transparently.

**Non-streaming (full response wait):** Would work given `callLlmReasoning` is 2-5s average. Streaming is strictly better UX and the infrastructure already exists. Cost difference is negligible.

---

## System-Wide Impact

### Interaction Graph
`ChatAnalystPanel.send()` → `premiumFetch POST /api/intelligence/v1/[rpc]` → `isCallerPremium()` gate → `assembleAnalystContext()` (9 parallel Redis reads) → `buildAnalystSystemPrompt()` → `callLlmReasoning()` → OpenRouter `google/gemini-2.5-flash` → SSE stream → `ChatAnalystPanel` DOM update. No pub/sub or observer side-effects. No writes to Redis.

### Error & Failure Propagation
- `isCallerPremium` fails → 403 → panel shows `showGatedCta(FREE_TIER, ...)`
- Context assembler partial failure → missing sections omitted from prompt, `degraded: true` in response → panel shows subtle "partial context" indicator (not a hard error)
- LLM unavailable (all providers fail) → `response: ''` + `error: 'llm_unavailable'` → panel shows retry button
- Stream abort (timeout or user cancel) → `AbortController.abort()` → partial response rendered + "Response cut off" notice
- Network error mid-stream → `reader.read()` throws → caught, panel shows retry

### State Lifecycle Risks
- Conversation history is instance-level only. Panel `destroy()` clears it. No orphaned state.
- No Redis writes from this handler. No mutation risk.
- AbortController must be aborted in `destroy()` to prevent dangling reads if panel is closed mid-stream.

### API Surface Parity
- `DeductionPanel` also calls `IntelligenceService` → single-turn query. No parity changes needed (different RPC method, different prompt, different panel).
- `WidgetChatModal` also does SSE chat → different auth flow (widget key, not Clerk). No parity needed.

### Integration Test Scenarios
1. Pro user sends message → verify response streams token by token → final message complete
2. Free user opens panel → verify `showGatedCta` renders, send button absent
3. All Redis context sources miss (cold cache) → verify request still completes with degraded flag, not 500
4. Stream abort at 90s → verify partial text rendered + "cut off" notice, no dangling reader
5. 10+ message history → verify oldest pairs are trimmed before sending (16 messages max sent to server)

---

## Acceptance Criteria

### Functional
- [ ] Panel renders in pro user's grid; free/anon users see locked CTA with upgrade prompt
- [ ] First message response streams in token by token (SSE)
- [ ] Multi-turn: follow-up questions use conversation history
- [ ] Context includes: world brief, CII top 15, market implications, forecasts, top news clusters, market data, prediction markets, macro signals
- [ ] Geo focus: user can type ISO2 to pull country-specific brief into context
- [ ] Domain filter chips change `domainFocus` hint in system prompt
- [ ] 5 quick-action buttons pre-fill and auto-send
- [ ] Clear button wipes history and resets to welcome message
- [ ] Export downloads session as `.md` file
- [ ] Panel destroy() aborts any in-flight stream

### Non-Functional
- [ ] Context assembly completes in <100ms (parallel Redis reads)
- [ ] First token arrives in <3s from submit (LLM latency)
- [ ] No LLM provider/model name appears in any response or panel UI
- [ ] All LLM output is HTML-escaped before rendering (no XSS)
- [ ] `sanitizeForPrompt()` applied to all user input before injection
- [ ] Pro gate enforced server-side (`isCallerPremium`); client gate is UX only
- [ ] No panel Redis key in `BOOTSTRAP_CACHE_KEYS` (no free-user data leak)

### Quality Gates
- [ ] `npm run typecheck && npm run typecheck:api` — clean
- [ ] `npm run test:data` — no regressions
- [ ] `npm run lint` — clean
- [ ] Edge function bundle check passes
- [ ] `make generate` after proto change — generated types match handler signatures

---

## Success Metrics

- Pro users engage with 3+ turn conversations (indicates genuine utility vs single-use novelty)
- Analyst response satisfies query without requiring user to navigate to another panel (self-contained intelligence)
- Time-to-first-insight < 4s from send

---

## Dependencies & Prerequisites

- `server/_shared/llm.ts` supports `stream: true` in `LlmCallOptions` (check `widget-agent.ts` pattern — may need adding)
- `isCallerPremium()` in `server/_shared/premium-check.ts` (confirmed exists)
- `premiumFetch` in `src/services/premium-fetch.ts` (confirmed exists)
- Redis keys for all 9 context sources must exist (most already seeded by existing seeders)
- `make generate` / `buf generate` available in dev environment for proto codegen

---

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| LLM context window overflow | High | Token budget per source, trim at assembly. System prompt ~3500 tokens, leaves 1500 for response with Gemini Flash's 32K window. |
| OpenRouter rate limits | Medium | Existing provider fallback chain handles it. Per-user isolation via Clerk auth on server. |
| Redis cold start on first request | Low | `Promise.allSettled` — all misses produce empty sections, not errors. |
| Streaming mid-panel destroy | Medium | `AbortController` in `destroy()`. Reader error caught, no dangling state. |
| History growing unbounded | Low | Hard cap at 20 messages, trimmed before send. |
| XSS from LLM output | Medium | `escapeHtml()` before any DOM insertion. Markdown transforms operate on escaped content only. |
| Pro gate bypass via direct RPC | Low | `isCallerPremium()` on every handler invocation. Bearer token validated server-side. |

---

## Future Considerations

- **Analytical framework integration** (see `docs/brainstorms/2026-03-27-intelligence-analytical-frameworks-requirements.md`) — add framework selector to chat panel, inject framework `instructions` as `systemAppend` for pro users
- **Streaming in `callLlmReasoning`** — once streaming is wired here, other AI panels could adopt it for better UX
- **Country-pinned context** — if user has a country pinned in the map, auto-populate `geoContext`
- **Model selection** — let pro users pick reasoning vs fast model via panel settings (store in `preferences`)
- **Follow-up suggestions** — append 2-3 suggested follow-up questions after each response
- **Webhook/alert integration** — "alert me when this forecast updates" from the chat

---

## Files Modified / Created

| File | Change |
|------|--------|
| `proto/worldmonitor/intelligence/v1/chat_analyst.proto` | New: `ChatAnalystMessage`, `ChatAnalystRequest`, `ChatAnalystResponse`, `ChatAnalyst.SendMessage` RPC |
| `src/generated/` | Regenerated by `make generate` |
| `server/worldmonitor/intelligence/v1/chat-analyst.ts` | New: handler, `isCallerPremium` gate, message assembly, `callLlmReasoning` call |
| `server/worldmonitor/intelligence/v1/chat-analyst-context.ts` | New: parallel Redis fetch, trim, return `AnalystContext` |
| `server/worldmonitor/intelligence/v1/chat-analyst-prompt.ts` | New: system prompt builder with domain focus support |
| `server/worldmonitor/intelligence/v1/handler.ts` | Register `ChatAnalyst.SendMessage` |
| `src/components/ChatAnalystPanel.ts` | New: `Panel` subclass, streaming read loop, conversation history, quick actions, domain chips |
| `src/config/panels.ts` | Register panel config with `premium: 'locked'` |
| `src/app/panel-layout.ts` | Add `'chat-analyst'` to `WEB_PREMIUM_PANELS` |
| `src/styles/main.css` | New: chat panel styles (message bubbles, domain chips, quick actions, streaming indicator) |
| `server/_shared/llm.ts` | Possibly: add `stream: true` option to `LlmCallOptions` (depends on current implementation) |

---

## Sources & References

### Internal References
- Streaming SSE pattern: `api/widget-agent.ts` + `src/components/WidgetChatModal.ts`
- LLM calling pattern: `server/_shared/llm.ts` + `server/worldmonitor/intelligence/v1/deduct-situation.ts`
- Pro gating 4-layer pattern: `src/services/panel-gating.ts` + `src/app/panel-layout.ts`
- Panel base class: `src/components/Panel.ts`
- Context assembly: `server/worldmonitor/intelligence/v1/deduction-prompt.ts`
- Premium fetch: `src/services/premium-fetch.ts`
- Server-side auth: `server/_shared/premium-check.ts`
- Conversation history cap pattern: `src/components/WidgetChatModal.ts` (10 message pairs, 500 char trim)

### Related Work
- Intelligence Analytical Frameworks brainstorm: `docs/brainstorms/2026-03-27-intelligence-analytical-frameworks-requirements.md` (framework injection into chat is a natural Phase 2)
- External fork reference (UI concept, not implementation): `amruth112/world-monitor-ai-chat@794228f`
