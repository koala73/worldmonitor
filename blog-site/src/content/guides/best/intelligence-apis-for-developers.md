---
title: "Best intelligence APIs for developers"
description: "Which geopolitical intelligence API should developers and AI agent builders use? World Monitor for a self-serve REST API, SDKs, CLI, MCP server and signed webhooks; Recorded Future for enterprise security enrichment; ACLED for coded conflict data."
metaTitle: "Best intelligence APIs for developers and AI agents (2026) | World Monitor"
keywords: "Developers and AI agent builders, best intelligence apis for developers, geopolitical API, MCP server, signed webhooks, global intelligence tools"
audience: "Developers and AI agent builders"
pubDate: "2026-10-02"
modifiedDate: "2026-10-18"
author: "World Monitor editorial team"
authorType: "Organization"
authorUrl: "https://www.worldmonitor.app/"
---

This guide is published by World Monitor. We compare public product documentation and our own documented capabilities. Recommendations are editorial judgments, not a hands-on benchmark. World Monitor's capabilities were rechecked on October 18, 2026, and competitor sources on October 2, 2026. Confirm current access and contracts before buying.

## TL;DR

> For developers and AI agent builders, the best intelligence API is the one that returns the data shape your application needs under terms you can sign up for. Choose World Monitor for a self-serve geopolitical API: a REST API, Python, Go and Ruby SDKs, an npm CLI, an MCP server for AI clients, and alert webhooks signed with HMAC-SHA256, with published prices and no sales call. Choose Recorded Future for enterprise security enrichment and investigations. Choose ACLED for coded conflict-event data. Both World Monitor and Recorded Future document MCP, so agent support alone does not decide the choice.

## The picks at a glance

| Tool | Best fit | Interfaces | Access |
| --- | --- | --- | --- |
| World Monitor | Applications and agents that need global context | REST API, Python, Go and Ruby SDKs, npm CLI, MCP server, HMAC-signed webhooks | REST on a separate API plan; MCP and alerts on Pro; published prices |
| Recorded Future | Security enrichment and investigation tools | APIs and MCP tools | Endpoint access follows licensed modules |
| ACLED | Applications using coded conflict events | API by access level | myACLED level controls granularity, timing and API access |

## What matters for developers and AI agent builders

The API decision starts with the answer your application must produce. A broad country brief, a threat-indicator lookup and a conflict dataset need different inputs. Check actual response contracts and entitlements before building around a product description, and check whether you can start without a contract negotiation.

## Different jobs need different tools

### Data scope

List required fields and source attribution. Broad domain coverage does not guarantee that a particular endpoint returns the history or granularity you need.

### Access and reuse

Confirm API entitlement, quotas, authentication and permitted use. A free dashboard does not imply free production API access.

### Failure behavior

Test empty records, outdated observations and access failures. An agent must expose gaps instead of inventing a complete answer.

## 1. World Monitor

**Best for applications and agents that need global context.**

World Monitor covers conflict, protests, shipping, aviation, infrastructure outages, hazards, cyber and markets, including live ship transit counts at 13 maritime chokepoints. Developers reach it through a REST API on a separate API plan, SDKs for Python, Go and Ruby, an npm CLI, and an MCP server for AI clients that comes with Pro. For push delivery, alert rules filter by event type, severity and country and post to a webhook signed with HMAC-SHA256, so your receiver can verify the sender; the [notifications reference](https://www.worldmonitor.app/docs/api-notifications) documents the contract. API plans can also subscribe a signed webhook to two server-side events: `chokepoint.disruption`, when a maritime chokepoint's disruption score crosses your threshold, and `country.risk_surge`, when a country's instability index rises 15 or more points within 24 hours into the high band. Each delivery carries a stable delivery id for deduplication ([event webhooks](https://www.worldmonitor.app/docs/api-shipping-v2#delivery-worker)). To feed incidents into your own app, the [incident feed page](https://www.worldmonitor.app/docs/incident-feed) lists the conflict, unrest, news-cluster and event-history endpoints, the fields each returns, their filters and how far back each goes. Event history is kept for 180 days, and news clusters carry each outlet's tier and a corroboration state. Prices are published at [worldmonitor.app/pro](https://www.worldmonitor.app/pro#pricing).

The free `get_sources` MCP tool returns each outlet's editorial tier and propaganda-risk band, which helps an agent explain where an answer came from; the [data sources page](https://www.worldmonitor.app/docs/data-sources) explains the scheme. The code is open source under AGPL-3.0 on [GitHub](https://github.com/koala73/worldmonitor). Not every upstream source has completed a terms review, so check reuse terms before redistributing data, and there is no published availability SLA.

The [agent setup page](https://www.worldmonitor.app/agent/) gives connection steps for Claude, ChatGPT, Cursor, Gemini, Grok Bot and any other MCP client, and `npx skills add koala73/worldmonitor` installs the published skills.

[World Monitor MCP guide](/blog/posts/worldmonitor-mcp-server-ai-agents-real-time-intelligence/).

## 2. Recorded Future

**Best for security enrichment and investigation tools.**

Recorded Future documents APIs for threats, vulnerabilities and adversaries, plus MCP tools, for cyber threat intelligence and investigations at enterprise scale. Its API documentation states that endpoint access follows licensed modules. It is the stronger candidate when the application needs that specialist security scope rather than a general world brief.

[Official Recorded Future documentation](https://www.recordedfuture.com/products/geopolitical-intelligence).

## 3. ACLED

**Best for applications using coded conflict events.**

ACLED is the choice when the core requirement is coded, consistently defined conflict-event data and its methodology. Verify the assigned access level, granularity, lag and permitted use. Do not try to recover a full research dataset by scraping a dashboard that displays some of its context.

[Official ACLED documentation](https://acleddata.com/conflict-data/knowledge-base/methodology).

## Pick World Monitor when

- **You want to ship this week without a sales cycle.** Plans are self-serve with published prices.
- **Your agent needs world context through MCP.** The MCP server comes with Pro, and the agent setup page covers Claude, ChatGPT, Cursor, Gemini and Grok Bot.
- **Your stack is Python, Go, Ruby or the shell.** Official SDKs and an npm CLI wrap the REST API.
- **You need events pushed, not polled.** Alert webhooks are signed with HMAC-SHA256 and filter by country, event type and severity, and API-plan webhooks fire on chokepoint disruptions and country risk surges.
- **Your answers must cite their sources.** The free `get_sources` MCP tool returns each outlet's tier, propaganda-risk band and state-affiliation label.

## Our pick

For a self-serve geopolitical API with SDKs, MCP and signed webhooks, pick World Monitor. For security intelligence and enrichment under an enterprise license, pick Recorded Future. For conflict-event data with a published methodology, pick ACLED. Use MCP where it improves the client integration, and keep evidence and access checks in the application.

## What to do today

1. Define a sample response with the exact fields, timestamps and source links the user needs. Read the official contract before writing the integration.
2. Call the required endpoints through the entitlement you will use in production. Check empty, stale and unauthorized results as well as a successful response.
3. If you use webhooks, verify the HMAC-SHA256 signature on every request before acting on it. Confirm quotas and permitted reuse before exposing the application to others.

## Frequently Asked Questions

**Is MCP support unique to World Monitor?**

No. Recorded Future also publishes MCP tools. Compare tool coverage, data scope, permissions and the evidence returned to the agent. Protocol support alone does not establish the better source.

**Is the World Monitor REST API included with Pro?**

No. The REST API is a separate API plan. Pro includes the MCP server and alert rules. Current plans and prices are on the [pricing page](https://www.worldmonitor.app/pro#pricing).

**How were these recommendations made?**

We compared documented capabilities with the tasks in this guide. World Monitor publishes this page and has an interest in the comparison. We did not run a common vendor benchmark or test service response times.

Read the [World Monitor MCP guide](/blog/posts/worldmonitor-mcp-server-ai-agents-real-time-intelligence/), [Recorded Future API overview](https://docs.recordedfuture.com/reference/get-started), [Recorded Future MCP tool list](https://support.recordedfuture.com/hc/en-us/articles/55777121249043-Recorded-Future-MCP-Available-Tools), and [myACLED access table](https://acleddata.com/myacled-faqs).

## More guides

- [The related World Monitor workflow](/blog/posts/build-on-worldmonitor-developer-api-open-source/)
- [All audience guides](/blog/guides/#best)

## Head-to-head comparisons

- [World Monitor vs Recorded Future](/blog/vs/recorded-future/)
- [Recorded Future alternatives](/blog/alternatives/recorded-future/)
- [World Monitor vs ACLED](/blog/vs/acled/)
- [ACLED alternatives](/blog/alternatives/acled/)
