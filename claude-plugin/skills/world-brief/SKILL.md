---
name: world-brief
description: Summarize the main global developments right now from World Monitor's hourly, source-checked world brief. Use when the user asks what is happening in the world today, for the top headlines, or for a morning news briefing.
---

# World brief

Answer "what is happening in the world right now" with World Monitor's precomputed world brief, not with general knowledge.

## Tools

| Tool | Access |
|---|---|
| `get_world_brief` | subscription |
| `get_news_intelligence` | free-account |

## Steps

1. Call `get_world_brief` with no arguments. It returns one written brief and an index-aligned `topStories` list with each story's corroboration evidence.
2. If the call is refused because the account has no subscription, call `get_news_intelligence` with no filters. Its `topStories` are the eight stories the World Monitor dashboard selects worldwide. Build the list from those and tell the user this is the story feed, not the written brief.
3. Present at most eight items, most important first. For each one give the headline in your own words, the primary source, and how many independent sources corroborate it when the result says so.

## Rules

- State the brief's generation time. If the result marks the snapshot stale or degraded, say so in the first line.
- Do not add events that are not in the tool result. If the user asks about something missing, say World Monitor's current snapshot does not cover it.
- Keep observed reporting separate from the brief's AI-written summary.
- Do not offer forecasts or trading advice.
