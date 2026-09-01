# Mission conversion funnel — event reference

> Event contract for the mission conversion funnel (Release 0 of the mission
> conversion strategy). The event names below are pinned by
> `tests/mission-funnel-events.test.mts` — rename an event and a test fails,
> not a dashboard.

## Shared context fields

Every funnel event carries:

| Field | Values | Source |
|---|---|---|
| `variant` | site variant id | `SITE_VARIANT` |
| `deviceClass` | `mobile` \| `desktop` | viewport width vs the shared mobile breakpoint |
| `missionId` | preset id, only when a mission is active | stored preset id validated against the closed mission vocabulary — corrupted storage reads as absent |

Ids that can travel through storage or URLs are bucketed before reaching
Umami, mirroring `bucketProductIdForAnalytics`: mission ids against the
closed preset vocabulary (unknown values collapse to `unknown`); panel keys
against a structural key-shape guard (call sites are code-controlled, and
the full catalog's import-time side effects must stay out of the analytics
module graph).

## Events

| Event | Fired from | Extra fields | Notes |
|---|---|---|---|
| `mission-picker-shown` | `openMissionPresetPopover` (single emission site) | `trigger`: `auto` \| `manual` \| `agent`; `surface`: `desktop` \| `mobile` | `auto` = deferred first-paint prompt; `agent` = WebMCP entry — exclude from human-funnel reads |
| `mission-selected` | `applyMissionPreset`, after the preset persists | `missionId` (bucketed), `source`: `user` \| `agent` | `agent` = WebMCP apply |
| `panel-viewed` | IntersectionObserver in `setupPanelViewTracking` (≥30% visible) | `panelKey` (bucketed) | Global denominator. Deduped **once per panel per tab session** (sessionStorage, KTD5); late-mounted panels join via a MutationObserver. Agent-driven views suppressed by `agent-analytics-privacy` (search flows and agent mission applies) |
| `pro-preview-viewed` | `ProPreviewSection` (Release 1) | `missionId`, `panelKey` | Preview rendered beside free content |
| `pro-preview-cta` | `ProPreviewSection` (Release 1) | `missionId`, `panelKey` | Upgrade CTA clicked |
| `pro-preview-dismissed` | `ProPreviewSection` (Release 1) | `missionId`, `panelKey` | Dismissal persists; the guardrail metric |
| `checkout-start` | `startCheckout` → `trackCheckoutStart` | `surface` now includes `mission-preview`; `variant`, `deviceClass`; `missionId` (ambient mission context on generic surfaces, preview-attributed on `mission-preview`), optional `panelKey` | Attribution rides the durable pending-conversion entry and the post-sign-in resume intent, so both the replay (`replayed: true`) and the `dashboard-resume` re-emit carry it; entries are re-sanitized on replay (storage is attacker-writable) |
| `mission-returned-after-purchase` | `ProPreviewSection` return leg (Release 1) | `missionId`, `panelKey` | Completion-side attribution: fires when the buyer lands back on the originating mission/panel |

The `pro-preview-*` and `mission-returned-after-purchase` names are pinned
from Release 0 so dashboards can be built ahead of Release 1, which ships
their emission sites with the preview component.

## Baseline and threshold procedure

Per the strategy doc's pre-registration rule, thresholds are set **after**
baselines exist — this section records how, not numbers.

1. **Baseline window (Release 0, ≥1 week before Release 1 exposure).** Record
   per mission: selections (`mission-selected`, `source: user`), unique
   panel-view sessions, and checkout-starts (any surface) — segmented by
   variant and device class. Untouched comparison missions:
   `tech-ai-watch`, `good-news-explorer`.
2. **Fix thresholds before Release 1 exposure**, and record them in this file
   in a dated section: minimum meaningful lift in attributed
   checkout-starts, and the maximum tolerated declines in free mission
   continuation (`mission-selected` repeat rate) and preview dismissal rate.
3. **Weekly guardrail read**: per treated mission — `pro-preview-viewed` →
   `pro-preview-cta` vs `pro-preview-dismissed`, plus free-continuation
   trend. Breach → remove that mission's entry from the preview registry
   (per-mission rollback, KTD3).
4. **Day-30 / day-60 reads**: attributed completed purchases, treated vs
   untouched vs pre-period. **Segment the read at the Release 2 boundary**:
   the clean treated-vs-untouched window is weeks 2–4; after Release 2 adds
   universal panels to all missions (week 4+), the contrast becomes
   "preview + panels vs panels-only" — do not pool across that boundary.
