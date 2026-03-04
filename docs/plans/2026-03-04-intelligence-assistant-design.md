# Intelligence Assistant Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a conversational AI assistant embedded in the map UI that can answer questions by querying all existing Omni Sentinel data sources, plus generate on-demand intelligence briefings.

**Architecture:** Claude tool use — all ~50 existing RPC endpoints defined as tools. AI decides which to call based on user questions. Multi-turn conversation with clarifying questions when needed.

**Tech Stack:** Anthropic Claude API (Sonnet 4), Vercel Edge Functions, session-only chat state (no persistence).

---

## 1. Overview

Two capabilities, one backend:

| Feature | Trigger | Output |
|---------|---------|--------|
| **Chat Panel** | User types a question | Conversational response with data citations |
| **Daily Briefing** | User clicks "Generate Briefing" | Fixed-framework report (热点地区 → 金融影响 → 旅行安全 → 预测市场) |

Both use the same Claude tool-use endpoint. Chat is multi-turn; Briefing is a single structured prompt.

## 2. Design Decisions (Confirmed)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Target users | 小圈子 (friends with background knowledge) | Not professionals, not general public |
| Language | 中文为主, English for technical terms | User preference |
| Focus areas | All (financial, safety, geopolitical) | AI auto-determines based on question |
| Briefing trigger | Manual only (button click) | No automatic scheduling |
| Chat location | Embedded Panel in map UI | Not a separate page |
| Tool strategy | All tools sent to Claude ("粗暴全发") | Let Claude decide which to call |
| Chat history | Session-only (cleared on refresh) | No persistent storage needed |
| Briefing format | Fixed framework | Consistent structure every time |
| Person tracking | Phase 1: existing data search; Phase 2: Sherlock/Maigret | Progressive enhancement |
| AI model | Claude Sonnet 4 | Good balance of capability and cost |

## 3. Architecture

```
User Question
    │
    ▼
┌─────────────────────────────────┐
│  Chat Panel (vanilla DOM .ts)   │
│  - Text input + send button     │
│  - Message history (session)    │
│  - Briefing button              │
└──────────┬──────────────────────┘
           │ POST /api/intel/v1/chat
           │   or /api/intel/v1/briefing
           ▼
┌─────────────────────────────────┐
│  Edge Function (Vercel)         │
│  - Validates input              │
│  - Checks killswitch            │
│  - Calls Claude with tools      │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│  Claude Sonnet 4 (tool use)     │
│  - System prompt (analyst role) │
│  - ~50 tool definitions         │
│  - Multi-turn history           │
│  - Structured JSON output       │
└──────────┬──────────────────────┘
           │ tool_use calls
           ▼
┌─────────────────────────────────┐
│  Omni Sentinel Backend          │
│  - market/* (8 RPCs)            │
│  - military/* (7 RPCs)          │
│  - intelligence/* (6 RPCs)      │
│  - social/* (6 RPCs)            │
│  - economic/* (8 RPCs)          │
│  - conflict/* (4 RPCs)          │
│  - ... (~50 total RPCs)         │
└─────────────────────────────────┘
```

### Tool Execution Flow

Claude's tool_use response triggers server-side RPC calls. The Edge Function:
1. Receives Claude's tool_use request
2. Calls the corresponding internal RPC handler directly (same process, no HTTP round-trip)
3. Returns tool results to Claude
4. Claude generates final response with citations

This is a **single API call with tool use loop**, not a multi-step pipeline.

## 4. Endpoints

### POST /api/intel/v1/chat

```typescript
// Request
{
  messages: Array<{role: 'user' | 'assistant', content: string}>,
  region?: string,      // optional focus region
}

// Response
{
  status: 'ok' | 'error',
  reply: string,           // Claude's response (markdown)
  toolsUsed: string[],     // which data sources were queried
  tokensUsed: number,      // for spend tracking
  disclaimer: string,      // AI-generated content warning
}
```

### POST /api/intel/v1/briefing

```typescript
// Request
{
  focusRegions?: string[],   // optional override (default: auto-detect hot spots)
  language?: 'zh' | 'en',   // default: 'zh'
}

// Response
{
  status: 'ok' | 'error',
  sections: Array<{
    title: string,
    content: string,         // markdown
    sources: string[],       // data source names
  }>,
  generatedAt: number,      // timestamp
  tokensUsed: number,
  disclaimer: string,
}
```

## 5. System Prompt Design

### Chat System Prompt

```
你是 Omni Sentinel 的情报分析师。你可以使用多种数据工具来回答用户的问题。

工作方式：
1. 如果用户的问题太笼统，先问澄清问题（地区？时间范围？关注点？）
2. 决定需要查询哪些数据源
3. 调用相关工具获取数据
4. 用中文综合分析，给出有依据的回答
5. 引用数据来源

注意事项：
- 用中文回答，技术术语保留英文
- 明确区分事实（来自数据）和分析（你的推断）
- 如果数据不足，坦诚说明而不是编造
- 关于人物查询：使用新闻、社交媒体、制裁名单搜索公开信息
- 每次回答结尾加上数据时效性说明
```

### Briefing System Prompt

```
生成一份情报简报，按以下框架组织：

## 热点地区动态
查询 conflict, military, intelligence 数据源，总结当前最重要的地缘政治事件。

## 金融市场影响
查询 market, economic, trade 数据源，分析地缘事件对金融市场的潜在影响。

## 旅行安全评估
查询 aviation, unrest, displacement, govdata 数据源，给出主要地区的安全等级。

## 预测市场信号
查询 kalshi, metaculus 数据源，列出与当前热点相关的预测市场。

## 值得关注
综合所有数据源，列出 3-5 个值得持续关注的信号。

要求：
- 中文撰写，技术术语保留英文
- 每段引用具体数据来源
- 标注数据时效性
- 保持客观，区分事实与分析
```

## 6. Tool Definitions Strategy

### Grouping (from ~70 RPCs to ~45 tools)

Some RPCs are internal or redundant for chat purposes. We group related endpoints:

| Tool Name | Maps To | Description |
|-----------|---------|-------------|
| `search_news` | news/list-feed-digest | Search RSS news feeds |
| `summarize_article` | news/summarize-article | Summarize a specific article |
| `get_market_overview` | market/list-market-quotes + get-sector-summary | Stock market overview |
| `get_crypto_prices` | market/list-crypto-quotes | Cryptocurrency prices |
| `get_commodity_prices` | market/list-commodity-quotes | Oil, gold, etc. |
| `search_social_reddit` | social/reddit | Search Reddit posts |
| `search_social_twitter` | social/twitter | Search X/Twitter posts |
| `search_social_bluesky` | social/bluesky | Search Bluesky posts |
| `search_social_youtube` | social/youtube | Search YouTube videos |
| `search_social_tiktok` | social/tiktok | Search TikTok posts |
| `search_social_vk` | social/vk | Search VK posts |
| `get_military_flights` | military/list-military-flights | Current military aircraft |
| `get_military_posture` | military/get-theater-posture | Theater military posture |
| `get_fleet_report` | military/get-usni-fleet-report | US Navy fleet positions |
| `get_conflicts` | conflict/list-acled-events + list-ucdp-events | Active conflict events |
| `get_risk_scores` | intelligence/get-risk-scores | Country risk scores |
| `get_intel_brief` | intelligence/get-country-intel-brief | Country intelligence brief |
| `search_gdelt` | intelligence/search-gdelt-documents | Search global news events |
| `get_sanctions` | govdata/opensanctions | Search sanctions database |
| `get_notams` | govdata/notam | Aviation NOTAMs |
| `get_predictions_kalshi` | kalshi/kalshi | Kalshi prediction markets |
| `get_predictions_metaculus` | metaculus/metaculus | Metaculus forecasts |
| `get_economic_indicators` | economic/* (grouped) | Economic data (GDP, rates, etc.) |
| `get_trade_data` | trade/* (grouped) | Trade flows and barriers |
| `get_energy_prices` | economic/get-energy-prices | Energy market prices |
| `get_shipping_status` | supply-chain/* (grouped) | Supply chain chokepoints |
| `get_flight_trajectory` | trajectory/flight-history | Aircraft trajectory history |
| `get_vessel_info` | maritime/get-vessel-snapshot | Ship tracking |
| `get_nav_warnings` | maritime/list-navigational-warnings | Maritime warnings |
| `get_internet_outages` | infrastructure/list-internet-outages | Internet disruptions |
| `get_cyber_threats` | cyber/list-cyber-threats | Cyber threat intelligence |
| `get_airport_delays` | aviation/list-airport-delays | Airport delay status |
| `get_displacement` | displacement/* (grouped) | Refugee/displacement data |
| `get_unrest_events` | unrest/list-unrest-events | Civil unrest events |
| `run_assessment` | analyst/assessment | JP 3-60 escalation assessment |
| `_web_search` | (new) Claude native web search | Fallback for questions not covered by tools |

~35 tools for Phase 1. Clean, curated, each with clear description.

### Phase 2 additions (+3 tools)

| Tool Name | Backend | Description |
|-----------|---------|-------------|
| `search_username` | Sherlock/Maigret (Railway) | Check username across 400-3000+ sites |
| `search_email` | Holehe (Railway) | Check which platforms an email registered on |
| `search_person` | Aggregator | Combine username + email + news + social + sanctions |

Phase 2 tools are deployed as Python services on Railway, exposed via REST API.

## 7. Chat Panel UI

```
┌─ Intelligence Chat ──────────────────────┐
│ [freshness: live]                         │
│                                           │
│ ┌─────────────────────────────────────┐   │
│ │ 🤖 你好！我是 Omni Sentinel 情报   │   │
│ │    分析师。你可以问我任何关于当前   │   │
│ │    地缘政治、金融市场或安全形势     │   │
│ │    的问题。                         │   │
│ └─────────────────────────────────────┘   │
│                                           │
│ ┌─────────────────────────────────────┐   │
│ │ 👤 迪拜现在安全吗？                │   │
│ └─────────────────────────────────────┘   │
│                                           │
│ ┌─────────────────────────────────────┐   │
│ │ 🤖 根据最新数据分析：              │   │
│ │                                     │   │
│ │ **安全评估: 低风险**                │   │
│ │                                     │   │
│ │ 1. 当前无活跃冲突事件 (ACLED)      │   │
│ │ 2. 迪拜机场运行正常，无延误 (FAA)  │   │
│ │ 3. 无相关 NOTAM 限制               │   │
│ │ 4. 社交媒体无异常安全信号          │   │
│ │                                     │   │
│ │ 需要注意：                          │   │
│ │ - 伊朗局势持续紧张（距迪拜 200km） │   │
│ │ - Kalshi 伊朗冲突概率: 12%         │   │
│ │                                     │   │
│ │ 📊 数据来源: ACLED, FAA NOTAM,     │   │
│ │    Kalshi, Twitter                  │   │
│ │ ⏰ 数据时效: 15分钟内              │   │
│ └─────────────────────────────────────┘   │
│                                           │
│ ┌──────────────────────────────┐ [Send]   │
│ │ 输入你的问题...              │ [Brief]  │
│ └──────────────────────────────┘          │
└───────────────────────────────────────────┘
```

- Extends `Panel` base class (vanilla DOM `.ts`)
- Messages rendered as `textContent` (XSS safe), markdown via DOMPurify
- "Brief" button triggers briefing generation
- Loading spinner during Claude response
- Tools used shown as subtle badges below each response

## 8. Cost Estimation

| Item | Per Call | Monthly (10 queries/day) |
|------|---------|------------------------|
| Claude Sonnet input | ~$0.003/1K tokens | ~$3 |
| Claude Sonnet output | ~$0.015/1K tokens | ~$5 |
| Tool calls (cached RPCs) | $0 (internal) | $0 |
| Briefing (larger prompt) | ~$0.05/briefing | ~$1.50 |
| **Total** | | **~$10/mo** |

Within the existing ~$30/mo budget.

## 9. Security

- API key: `CLAUDE_API_KEY` server-side only (already exists)
- Chat input: validated + sanitized (max 2000 chars, no HTML)
- Claude output: markdown rendered via DOMPurify (already in deps)
- Tool results: internal RPC calls, no user-controlled parameters passed raw
- Rate limit: 10 requests/minute per IP (chat), 3/minute (briefing)
- Disclaimer: mandatory on every response ("AI-generated analysis...")
- Person tracking: only public data, no scraping of private profiles

## 10. Phased Delivery

### Phase 1 (This implementation)
- Chat Panel with ~35 tools
- Briefing endpoint with fixed framework
- Person queries via existing data sources (news + social + sanctions)
- Session-only chat history
- Chinese language output

### Phase 2 (Future)
- Sherlock/Maigret/Holehe integration (Railway services)
- `search_username`, `search_email`, `search_person` tools
- Streaming responses (SSE)
- Chat history persistence (optional, Upstash)
- Briefing scheduling (cron)

## 11. File Structure

```
proto/worldmonitor/intel/v1/
  chat.proto                    — ChatRequest, ChatResponse
  briefing.proto                — BriefingRequest, BriefingResponse
  service.proto                 — IntelService with Chat + Briefing RPCs

server/worldmonitor/intel/v1/
  chat.ts                       — Chat handler (Claude tool use loop)
  briefing.ts                   — Briefing handler (structured prompt)
  tools.ts                      — Tool definitions (~35 tools mapped to RPCs)
  system-prompts.ts             — Chat + Briefing system prompts
  handler.ts                    — Composition handler
  chat.test.mts                 — Chat tests
  briefing.test.mts             — Briefing tests

api/intel/v1/
  [rpc].ts                      — Edge function entry point

src/services/intel/
  index.ts                      — Client wrapper

src/components/
  IntelChatPanel.ts             — Chat Panel UI
```
