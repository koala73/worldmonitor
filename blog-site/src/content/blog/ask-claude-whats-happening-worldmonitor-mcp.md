---
title: "Ask Claude What's Happening in the World"
description: "Connect Claude to WorldMonitor's MCP server so non-developers can ask live questions about conflicts, markets, chokepoints, country risk, and breaking news."
metaTitle: "Ask Claude About Current Events with WorldMonitor MCP"
keywords: "Claude connectors real-time news, ask AI about current events, Claude MCP server current events, WorldMonitor MCP Claude, AI current events assistant"
audience: "Claude users, analysts, founders, journalists, operators, non-developer power users"
heroImage: "/blog/images/blog/worldmonitor-mcp-server-ai-agents-real-time-intelligence.jpg"
pubDate: "2026-06-10"
---

Claude is useful for reasoning through messy questions. It is less useful when the answer depends on what changed this morning.

Ask a normal chat model "what is happening in the Red Sea right now?" and it has to lean on memory, web search, or whatever you paste into the prompt. That is fine for background research. It is not fine when you need to know whether a chokepoint is stressed, a country-risk score moved, or a conflict signal is still fresh.

WorldMonitor's [MCP server](https://www.worldmonitor.app/docs/mcp-server) gives Claude a live tool connection. You add one connector URL, approve the OAuth flow, and Claude can call the same intelligence surfaces behind the [WorldMonitor dashboard](/blog/posts/what-is-worldmonitor-real-time-global-intelligence/): country risk, conflicts, markets, maritime chokepoints, aviation, cyber, energy, news intelligence, forecasts, and more.

You do not need to write an app. You do not need to understand JSON-RPC. You only need a paid WorldMonitor tier and a Claude client that supports custom connectors.

## The job: give Claude current context

The goal is not "make Claude browse the internet." The job is narrower and more valuable:

- Pull structured live data before answering.
- Preserve freshness fields like `cached_at` and `stale`.
- Separate observed signals from interpretation.
- Ask follow-up questions against the same data surface.
- Avoid treating model confidence as event probability.

That last point matters. A good intelligence assistant should say "the data supports elevated route risk" rather than "there is an 82% chance of escalation" unless it is using a forecast tool that actually returns probabilities.

WorldMonitor's MCP server exists for this exact pattern. It exposes 39 tools, six prompt templates, and read-only resources through the [Model Context Protocol](https://modelcontextprotocol.io), so Claude can discover tools and call them during a conversation.

## Add the connector

The canonical MCP endpoint is:

```text
https://worldmonitor.app/mcp
```

Use the apex host exactly as shown. The dashboard and docs commonly live at `www.worldmonitor.app`, but the MCP connector endpoint is intentionally published at `worldmonitor.app/mcp`.

For Claude web, open Settings, go to Connectors, add a custom connector named `WorldMonitor`, and paste that URL.

For Claude Desktop, add this entry to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "worldmonitor": {
      "url": "https://worldmonitor.app/mcp"
    }
  }
}
```

Restart Claude Desktop after saving the file. On first use, Claude opens the WorldMonitor OAuth consent flow. Pro users sign in with their WorldMonitor account. API Starter, Business, and Enterprise users can use OAuth or an issued `wm_...` API key for server-side workflows.

Free accounts can still use the public dashboard, but the MCP server requires a paid tier. The [MCP quickstart](https://www.worldmonitor.app/docs/mcp-quickstart) keeps the setup details current if a client changes its connector UI.

## Six prompts that work immediately

You can ask plain-English questions, but the fastest way to get reliable answers is to start from repeatable prompt shapes. These are the six templates WorldMonitor exposes through MCP:

| Prompt | Use it when you need |
|---|---|
| `country-briefing` | A country risk score, component breakdown, AI brief, and macro context |
| `conflict-pulse` | Active conflict events and alert-flagged news for a region or country |
| `market-open-prep` | Equity, commodity, crypto, FX, and risk context before the trading day |
| `energy-shock-watch` | Energy disruptions, fuel shortages, crisis policies, and market pressure |
| `route-risk-check` | Maritime chokepoint status and route stress for a shipping corridor |
| `freshness-audit` | A data-quality check before trusting a briefing |

The point of templates is consistency. If you ask the same country question every morning, Claude should call the same surfaces in the same order and show what changed.

## Prompt 1: the morning world brief

Use this when you want a short operator briefing instead of a dashboard tour:

```text
Use WorldMonitor before answering. Give me a 10-minute global brief for today.
Focus on conflict escalation, major market stress, strategic chokepoints, and
country-risk changes. Show freshness or stale flags when the tools return them.
Separate observed signals from your assessment.
```

A good answer should not be a list of headlines. It should group signals:

- conflicts and unrest that changed
- chokepoints or route stress
- market moves that matter geopolitically
- countries whose risk posture needs attention
- what to re-check later

If Claude answers without calling tools, ask it to retry with WorldMonitor tools first.

## Prompt 2: country briefing

Country questions are where structured data helps most:

```text
Use WorldMonitor to brief Turkey for an operations team. Include country risk,
conflict and unrest context, sanctions or advisory context if available, macro
stress, and one paragraph on what changed since the last check. Do not infer
safety from missing data.
```

The important guardrail is "do not infer safety from missing data." If a feed is absent, stale, or fallback-backed, Claude should say that directly. Missing signal is not the same thing as low risk.

For recurring watchlists, keep the country list short. Five countries every morning is more useful than fifty countries once a month.

## Prompt 3: route risk check

Use this before shipment, travel, or energy-route decisions:

```text
Use WorldMonitor to check route risk from the Gulf to Northwest Europe. Look at
Hormuz, Bab el-Mandeb, Suez, and relevant energy or market signals. Give me:
1. current observed signals
2. likely operational implications
3. what would make the assessment worse
4. what to re-check in six hours
```

This prompt forces Claude to keep the answer operational. You are not asking for a geography essay. You are asking whether a route needs attention, which signals support that, and what would change the recommendation.

If you are building a coded workflow later, the related developer post shows how to [build a supply-chain early-warning system with the API](/blog/posts/build-supply-chain-early-warning-system-api/). MCP is the conversational front door; REST is the production pipeline.

## Prompt 4: verify a breaking claim

When a claim is moving fast on social media, do not ask Claude "is this true?" Ask it to build an evidence table:

```text
Use WorldMonitor to evaluate this claim: "<paste claim>". Return an evidence
table with structured signals, source diversity, missing data, and a confidence
label about the assessment quality. Do not turn that confidence label into an
event probability.
```

Claude should look for corroborating signals: news intelligence, conflict events, natural disasters, aviation or maritime anomalies, market reaction, internet outages, or country risk changes depending on the claim.

The workflow pairs well with the journalist guide to [verifying breaking news with OSINT signals](/blog/posts/verify-breaking-news-osint-workflow-journalists/). The difference is that MCP lets you do it conversationally.

## Prompt 5: market-open prep

Markets absorb geopolitical stress before many dashboards catch up:

```text
Use WorldMonitor for a market-open geopolitical prep. Include oil, gold, major
equity or sector stress, crypto risk appetite, prediction-market context if
available, and the top world events that plausibly explain the moves. Keep
correlation and causation separate.
```

That last sentence saves you from fake certainty. A model can observe that oil rose while a chokepoint risk worsened. It should not claim the route signal caused the price move unless the evidence supports it.

## Prompt 6: freshness audit

Before you rely on an answer, ask:

```text
Run a WorldMonitor freshness audit for the tools you just used. Which fields are
fresh, stale, fallback-backed, or missing? Which parts of your answer should I
treat as lower confidence because of data freshness?
```

This is the habit that turns "AI answer" into "auditable briefing." Every live-data assistant should show its data quality before decisions get expensive.

## What Claude should not do

Even with live tools, keep boundaries:

- Do not ask it to predict specific casualties, attacks, trades, or political outcomes as certainty.
- Do not let it hide stale data.
- Do not accept a briefing that mixes observations and interpretation without labels.
- Do not assume WorldMonitor covers every source on earth.
- Do not skip primary-source checks for high-stakes decisions.

MCP makes Claude more useful. It does not make Claude an oracle.

## Frequently Asked Questions

**Can non-developers use WorldMonitor MCP with Claude?**

Yes. Claude web users can add WorldMonitor as a custom connector, and Claude Desktop users can add the server URL to the desktop config. The setup is mostly copy-paste; no application code is required.

**Does this give Claude real-time current events?**

It gives Claude access to WorldMonitor's live and cache-backed intelligence tools. Claude still has to call the tools, preserve freshness fields, and explain uncertainty. Ask it to use WorldMonitor before answering live-risk questions.

**Is MCP free?**

The public dashboard is free, but WorldMonitor MCP access requires Pro or an API tier. The MCP docs list the current auth modes, quotas, and client setup details.

---

**Add `https://worldmonitor.app/mcp` as a Claude connector, then ask one narrow operational question: what changed in the world that matters to me today?**
