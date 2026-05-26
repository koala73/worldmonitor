---
status: pending
priority: p1
issue_id: "109"
tags: [code-review, agent-native, system-prompt, discoverability]
---

# get-country-chokepoint-index not in widget system prompt — agents cannot discover or call this endpoint

## Problem Statement
`scripts/ais-relay.cjs` widget system prompt lists known supply-chain RPCs (line ~9667) but `get-country-chokepoint-index` is absent. Agents asked "what is Country X's chokepoint exposure?" have no path to this data. The RPC is HTTP-callable but invisible to the agent layer.

## Findings
`scripts/ais-relay.cjs:9667` — supply-chain RPC list omits the new endpoint. `src/config/commands.ts` has no CMD+K entry for the exposure index. Without system prompt inclusion, widget agents cannot discover, reason about, or invoke this RPC, making the feature inaccessible via the AI interface despite being live.

## Proposed Solutions

### Option A: Add RPC to system prompt and CMD+K (Recommended)
- Add `get-country-chokepoint-index?iso2=XX[&hs2=27] (PRO only — returns empty if not authenticated)` to the supply-chain RPC block in the widget system prompt in `scripts/ais-relay.cjs`
- Add a CMD+K command entry in `src/config/commands.ts` for the chokepoint exposure index
- Effort: Small | Risk: Low

### Option B: Add to system prompt only
- Add the RPC description to the agent system prompt without adding a CMD+K entry
- Agents gain discoverability but keyboard-driven users cannot surface the feature
- Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] Widget agent asked about a country's chokepoint exposure can identify and call `get-country-chokepoint-index`
- [ ] CMD+K search includes an entry for the chokepoint exposure index
- [ ] System prompt entry correctly documents the PRO-only restriction and the `hs2` default parameter

## Resources
- PR: #2870
