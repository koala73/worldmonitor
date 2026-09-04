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

## Variant coverage caveat

Funnel events exist only for hosts listed in `UMAMI_DOMAINS`
(`src/services/analytics.ts`) — the tracker self-disables everywhere else.
As of 2026-09-04 that is the apex, `www`, `happy`, and `finance` (finance
re-added so the finance-only `nq-day-trader` mission became measurable;
upstream Umami #4183 still drops ~4-8% of collector writes on affected
hosts, an accepted noise floor). `tech` and `commodity` remain dark: a
mission scoped to those variants produces **no funnel data**, and zero
events from such a mission means "unmeasured", never "unused".

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

## Pre-registered thresholds — set 2026-09-04, before Release 1 exposure

Baseline window: 2026-08-31 through 2026-09-04 (first full days after the
Release 0 merge), production Umami, `source: user` only.

Measured baselines (daily means): `panel-viewed` ~118k across ~11.5k
sessions (dedupe mean 1.09 events per session+panel); `mission-picker-shown`
~1.4k; `mission-selected` ~545 (crisis-desk ~194, osint ~75, supply-chain ~71,
macro ~61, tech-ai ~59, energy ~46, good-news ~40); `checkout-start` ~85, of
which ~6.3% carried ambient mission attribution.

Fixed now, before any preview is exposed:

1. **Per-mission rollback** (weekly read; remove that mission's registry
   entry): dismissal rate `pro-preview-dismissed / pro-preview-viewed`
   exceeds **50%** over at least **200 viewed**, OR the mission's weekly
   `mission-selected` (source `user`) falls below **75% of its baseline
   weekly mean** while untouched missions hold within 10% of theirs.
2. **Free-experience guardrail** (global): total weekly `mission-selected`
   drops below **75%** of the baseline weekly mean → pause Release 1
   entirely, not per mission.
3. **Day-30 continue bar**: weekly mission-attributed `checkout-start`
   (surface `mission-preview`, or ambient attribution on a treated mission)
   reaches at least **150% of the baseline ambient weekly mean** (~38/week
   → ≥57/week), with the treated-vs-untouched contrast favoring treated.
4. **Read discipline**: day-30 segments at the Release 2 boundary (weeks
   2–4 are the clean treated-vs-untouched window) and excludes
   `trigger/source: agent` events and dark-variant missions per the caveat
   above.

