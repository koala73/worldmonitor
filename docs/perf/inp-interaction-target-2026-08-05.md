# Where /dashboard INP actually hurts — field pull, 2026-08-05

The `interactionTarget` pull that #4556 gated U5 (panel render chunking) on:
*"Deferred (gated on U1 field data; need running-app verification)."*

**Verdict: do not ship U5.** The field data refutes the hypothesis that panel bodies are
where INP mass sits. See [Reading field Web Vitals](reading-field-web-vitals.md) for why
none of the numbers below are quoted as a field p75.

## Method

Sentry issue `7584575810` (`web-vital: INP`, culprit `/dashboard`), 14-day window — the
max `stats_period` that endpoint accepts. 600 event IDs enumerated, **300 full events**
fetched and decomposed.

Two traps worth recording:

- The `/issues/{id}/events/` list endpoint returns **trimmed** events whose `context` is
  empty. Aggregating those reports every `interactionTarget` as absent — an artifact that
  looks exactly like "we ship no attribution." Full events must be fetched individually
  via `/projects/{org}/{proj}/events/{id}/`.
- Only ~50% of enumerated IDs resolve to a full event (retention/expiry). The sample
  therefore skews recent; treat small buckets as directional.

This is the **captured bad tail** — good-rated events are dropped before Sentry and the
remainder is 20% sampled. It answers *"where is the worst-case pain?"*, not *"what
fraction of all interactions are slow?"*

## Result — by surface

| Surface | Share of all | Share of attributed | p75 (captured tail) |
|---|---:|---:|---:|
| **map** (maplibre/deck.gl canvas, mapSvg, overlays, layer toggles) | **40.0%** | **54.5%** | 840 ms |
| unattributed (`unknown`) | 26.7% | — | 768 ms |
| other | 14.7% | 20.0% | 1160 ms |
| nav / chrome | 10.0% | 13.6% | 728 ms |
| **panel body / grid** | **7.0%** | **9.5%** | 1128 ms |
| document (whole page) | 1.7% | 2.3% | 1864 ms |

Single largest named target: `canvas.maplibregl-canvas` at 15.9%.

## Result — by sub-part

| Sub-part | p50 | p75 | p95 | Dominates |
|---|---:|---:|---:|---:|
| presentationDelay | 229 ms | 438 ms | 1176 ms | **58.0%** of events |
| inputDelay | 74 ms | 311 ms | **1936 ms** | 30.4% |
| processingDuration | 15 ms | 84 ms | 400 ms | **11.6%** |

`presentationDelay` dominates in every bucket (57–77%), peaking on nav/chrome at 77%.

## Why this kills U5

U5 chunks `setSafeContent`, which reduces **processingDuration on panel bodies**. Sizing
that target against the data:

> panel bodies = 9.5% of attributed events
> × processingDuration dominant in 14% of those
> ≈ **1.3% of attributed bad-tail events**

That is the smallest sub-part on a surface that barely appears, bought with a
render-semantics change across **130 call sites in 72 files**. The gate #4556 set has
answered: not worth it. `processingDuration` p50 is 15 ms — handlers are not the problem.

Note also that `setContentImmediate` has exactly one caller, inside the 150 ms debounce
timer (`Panel.ts`). The innerHTML swap therefore never runs in the interaction's own task,
so it was never presentation-delay cost *of that interaction* — at worst it is a long task
that can delay a **later** one. That is an inputDelay concern, and a smaller one than the
1936 ms inputDelay p95 already implies.

## What the data says to do instead

1. **Compositing / presentationDelay — the dominant axis.** 58% of events. This is the
   `Layerize` story from
   [the desktop baseline](desktop-mainthread-baseline-2026-07-02.md): 517 composited
   layers, 385 of them held by infinite marker opacity animations. #4669 time-boxes those
   pulses but only releases the layers after 6 s with no overlay re-render, and a zoom
   crossing a visibility threshold re-arms it. Shrinking the resident layer count is the
   lever.
2. **The map is the surface.** 54.5% of attributed events. Click-time work on map markers
   is correctly-targeted spend — the `MapPopup` forced-layout fix landed here.
3. **inputDelay p95 1936 ms — background main-thread contention.** Nothing about the
   handler; the thread was busy before it ran. Recurring timers and post-load hydration
   waves are the candidates.
4. **Close the 26.7% attribution gap** before trusting any surface split too hard. That
   bucket is larger than every named surface except the map.
