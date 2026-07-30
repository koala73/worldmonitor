---
status: pending
priority: p2
issue_id: "066"
tags: [code-review, agent-native, analytical-frameworks]
dependencies: []
---

# `framework` param missing from widget-agent PRO system prompt for `get-country-intel-brief`

## Problem Statement
The PRO widget-agent system prompt documents `get-country-intel-brief` with only `params: country_code`. The new `framework` field (added in PR #2380, gated server-side in PR #2386) is not listed. PRO users asking the widget-agent to apply an analytical framework to a country brief silently receive a frameworkless response — the agent has no way to know the field exists.

Since the relay passes query params through as-is, the fix is purely a system prompt documentation update — no backend changes required.

## Proposed Solution
Add `framework` to the param documentation for `get-country-intel-brief` in `WIDGET_PRO_SYSTEM_PROMPT` in `scripts/ais-relay.cjs`. The basic `WIDGET_SYSTEM_PROMPT` should omit it (server gate rejects non-PRO framework values anyway).

## Technical Details
- File: `scripts/ais-relay.cjs` (search for `WIDGET_PRO_SYSTEM_PROMPT` and `get-country-intel-brief`)
- Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] PRO widget-agent system prompt includes `framework` param for `get-country-intel-brief`
- [ ] PRO agent can send `?framework=<text>` and receive framework-influenced response
- [ ] Basic agent does not receive the `framework` doc entry

## Work Log
- 2026-03-28: Identified by agent-native-reviewer during PR #2386 review
