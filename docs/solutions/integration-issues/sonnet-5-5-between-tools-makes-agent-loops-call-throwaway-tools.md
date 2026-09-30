---
title: "Sonnet 5.5 with thinking off made the widget agent call throwaway tools to get room to plan"
date: 2026-09-30
category: integration-issues
module: widget-builder
problem_type: integration_issue
component: assistant
severity: medium
symptoms:
  - "Data-only widget requests ran `search_web` with queries like `noop` and `skip`, and `read_page` on `https://skip.dev/`, in 6 of 6 runs"
  - "The junk search returned results, so a widget built only from WorldMonitor data was marked web-sourced and sent through 1-2 source checks"
  - "One \"earthquakes above magnitude 5 today\" run ended in \"its sources could not be verified\" instead of a widget"
root_cause: config_error
resolution_type: config_change
related_components: [tooling]
tags: [widget-agent, ais-relay, claude-sonnet-5-5, between-tools, adaptive-thinking, prompt-caching, preserved-thinking, server-side-fallback]
---

# Sonnet 5.5 with thinking off made the widget agent call throwaway tools to get room to plan

## Problem

The Pro widget agent moved from `claude-sonnet-4-6` to `claude-sonnet-5-5` for cost (#8751). The first setting tried was `thinking: {type: "between_tools"}`, the lowest thinking level on Sonnet 5.5 and the closest match to how Sonnet 4.6 ran here, with no thinking. With that setting the agent started making tool calls it did not need, which cost more and broke some widgets.

## Symptoms

- After a successful WorldMonitor fetch, the next turn was `search_web` with `"noop"` or `"skip"`, or `read_page` on a site the junk search returned (`skip.dev`). The model then wrote "The search wasn't needed" and built the widget from the data it already had.
- The widget agent treats a widget as web-sourced once a search returns results, and every web-sourced draft goes through the source check. The junk calls added 1 or 2 checks and 30-50 s to data-only widgets.
- In one of those runs the check rejected the draft and then the repair, so the user got an error for a request our own data covered.

## What Didn't Work

- **Reading it as a data gap.** The first failing run looked like the model searching because the `earthquakes` bootstrap result is trimmed to 68 records. The `between_tools` progress notes showed otherwise: the model had already filtered the loaded records ("I've filtered the loaded records to only magnitude >5.0 events…") and called a tool anyway.
- **Keeping `between_tools` and adding prompt rules.** Not tried. The migration guide notes that asking the model to think less has almost no effect, and that removing a dummy call via the prompt would fight the mechanism rather than change it.

## Solution

Use adaptive thinking at `low` effort for the agent loop and for the source check (`scripts/ais-relay.cjs:14056`):

```js
const WIDGET_SONNET_PARAMS = {
  model: 'claude-sonnet-5-5',
  thinking: { type: 'adaptive' },
  output_config: { effort: 'low' },
  fallbacks: 'default',
};
const WIDGET_SONNET_HEADERS = { 'anthropic-beta': 'server-side-fallback-2026-07-01' };
```

After the switch, 0 of 5 runs made a junk call (3 earthquake requests, gold vs silver, Premier League). All five completed in 9-16 s.

The same migration needed two more changes. Both are required once thinking blocks are in play:

- **Append-only history** (`scripts/ais-relay.cjs:14347`). When tools shut off, the loop used to add "Tools are now disabled…" to the messages of a single call and then drop it. Every later request's history therefore differed from the one the model had answered. That invalidates the prompt cache from that point, and Sonnet 5.5 checks that earlier turns are unchanged before it replays a thinking block; accounts created on or after 2026-08-31 get a 400 when they are not. The notice is now pushed into `messages` once, and a test asserts that each request's messages extend the previous request's (`tests/widget-builder.test.mjs:228`).
- **Fallback usage** (`scripts/ais-relay.cjs:14298`). With `fallbacks: "default"`, a refused attempt is billed, but top-level `usage` covers only the attempt that answered. The refused one appears only in `usage.iterations`. The usage counter sums `iterations` when present and the top-level fields otherwise, never both (`tests/widget-builder.test.mjs:242`).

Top-level `cache_control: { type: "ephemeral" }` on every builder call (`scripts/ais-relay.cjs:14359`) caches the conversation as it grows. One `[widget-agent] usage` line per request (`scripts/ais-relay.cjs:14606`) makes all of this measurable from the Railway logs.

## Why This Works

With `between_tools`, the model does no extended thinking. The short notes it writes come back as `thinking` blocks, but only between tool calls. When it wanted to plan before writing the widget (filter by magnitude, pick the UTC day, decide on a toggle), a tool call was the only way to open that space, so it made one with a placeholder query. Adaptive thinking at `low` lets it think before the final reply without a tool call, and at `low` it keeps that thinking short, so the cost stays close to thinking off.

## Prevention

- **Check progress notes before prompting.** When moving an agent loop to a model with a `between_tools` setting, run a few real requests and read the `thinking` blocks it returns before prompting around odd tool calls. A tool call right after a note that plans the output, followed by "wasn't needed", is this pattern.
- **Treat junk tool queries as a regression signal.** Queries like `noop`, `skip` or `none` are a cheap check to add to any probe harness.
- **Keep agent history append-only.** Any per-call message the harness adds must be kept, not dropped. The append-only test above is the guard.
- **Count fallback attempts.** When `fallbacks` is on, count tokens from `usage.iterations`, or refused attempts go missing from cost reporting.
- **Measure before and after.** Production after #8751: "gold vs silver 30 days chart" took 2 calls and 9 s, and "Premier League table" took 4 calls and 13 s, with cache reads replacing most of the repeated input.

## Related Issues

- [Widget agent data fetches 401'd for months, and the model quietly fell back to web search](widget-agent-data-fetches-401-silently-routed-to-web-search.md) covers the earlier cause of unwanted web searches. That one was data fetches failing auth; this one is a model setting.
- PR #8744 added the `read_page` tool and the source check that the junk searches triggered.
- PR #8751 is the migration itself.
