---
title: "We Grade Our Own Forecasts: Inside the Forecast Scorecard"
description: "WorldMonitor publishes a Brier-score audit of 32 AI forecasts, including calibration results, overconfidence patterns, and comparison with prediction markets."
metaTitle: "AI Forecast Accuracy & Brier Scorecard | WorldMonitor"
keywords: "AI forecast accuracy, Brier score forecasting, geopolitical forecast track record, forecast calibration, prediction accountability, forecast verification"
audience: "Forecasters, superforecasting community, quant researchers, skeptical analysts, AI evaluation researchers"
heroImage: "/blog/images/blog/ai-forecast-accuracy-brier-scorecard-worldmonitor.jpg"
pubDate: "2026-07-21"
modifiedDate: "2026-07-22"
---

Every AI product now makes predictions. Almost none of them tell you their error rate.

That asymmetry is the oldest trick in forecasting: make many confident calls, showcase the hits, let the misses expire quietly. It works because nobody keeps the ledger. WorldMonitor generates [AI geopolitical and economic forecasts](/blog/posts/prediction-markets-ai-forecasting-geopolitics/) — so we built the ledger, and we publish it.

## How the scorecard works

Every forecast enters a **resolution ledger** when it's made: the claim, the probability, and what would count as resolution. When the outcome is knowable, the forecast is judged and scored. No retroactive editing, no quiet expiry — pending forecasts are counted as pending, and judged forecasts keep their original probabilities forever.

From the resolved ledger, the scorecard computes the metrics forecasting research actually uses:

- **Brier score** — the mean squared error of probability forecasts. Lower is better; 0.25 is what coin-flipping "50% on everything" scores. It punishes confident wrongness hardest, which is the failure mode that matters.
- **Log score** — the harsher cousin, which severely penalizes being both extreme and wrong.
- **Calibration buckets** — the honesty test: of everything we called "70% likely," did roughly 70% happen? A forecaster can have decent averages while being systematically overconfident; calibration buckets expose that.
- **Domain breakdowns** — accuracy sliced by forecast domain, because being sharp on commodity moves doesn't certify you on diplomatic outcomes, and pretending one number covers both is how track records mislead.

The scoring runs over a rolling window with judged and pending counts visible, so you can see not just how good the record is but how much record there is.

## The actual scorecard, as of July 22, 2026

A post about publishing your numbers should publish the numbers. These were pulled from the live `get_forecast_scorecard` endpoint while writing, over the current 180-day rolling window:

**Overall: 32 scored forecasts, Brier 0.202, log score 0.575.** Answering "50%" to everything scores 0.25, so the system beats maximal ignorance — modestly.

**The calibration table, including the ugly rows:**

| Confidence bucket | Forecasts | Avg predicted | Actually happened |
|---|---|---|---|
| 0–10% | 4 | 8% | 0% |
| 10–20% | 2 | 11% | 0% |
| 30–40% | 4 | 33% | 25% |
| 40–50% | 9 | 43% | 22% |
| 50–60% | 8 | 54% | 13% |
| 60–70% | 5 | 62% | 20% |

Read the bottom three rows: the system is **systematically overconfident in the 40–70% band** — events it calls roughly even-odds happen about a fifth of the time. The low buckets are honest; the middle is the current failure mode, and it's now a named engineering target rather than a private embarrassment. Notice also what the table doesn't contain: no scored forecast above 70% yet — the system hasn't been willing to make high-confidence calls that resolve.

**Head-to-head against prediction markets:** on the three resolved questions where a forecast overlapped a liquid market, our Brier was 0.040 against the market's 0.010. Three questions is anecdote, not statistics — but the market won, and pretending otherwise would defeat the point of this page.

**The void ledger:** of 124 resolved entries, 92 (74%) were voided — resolution criteria that turned out too vague to judge cleanly. Voids are counted and published rather than quietly dropped, and driving that rate down (mostly in infrastructure forecasts, where 76 of 87 resolutions voided) is the pipeline's current top fix.

**By domain:** cyber is the strongest slice (Brier 0.111 over 11 scored); markets sit at 0.210 (n=4); infrastructure is the weakest at 0.286 with the void problem above. Exactly the kind of spread that makes a single blended "accuracy" number misleading — which is why the tool returns the breakdown.

Thirty-two scored forecasts is a young ledger, not a track record. Publishing it anyway — small, unflattering rows included — is the deposit on the claim that this scorecard means something. Metaculus and Good Judgment publish theirs; prediction markets publish by construction; a forecasting product that hides its ledger until the numbers flatter it isn't doing forecasting, it's doing marketing.

## Why publish it

Three reasons, in ascending order of importance:

1. **It's the standard we hold others to.** WorldMonitor puts [Polymarket and Kalshi probabilities](/blog/posts/prediction-markets-ai-forecasting-geopolitics/) next to its own forecasts. Prediction markets keep score by construction — their prices are public history. Publishing our own Brier scores is the price of sitting in that company.
2. **It makes the forecasts usable.** A "78% probability" from a black box is decoration. The same number from a system whose calibration you can inspect is an input you can size decisions with.
3. **It improves the system.** Scored errors are training signal. The domains where calibration drifts are the domains where the pipeline gets fixed next.

## For developers and agents

The `get_forecast_scorecard` MCP tool returns the full scorecard — Brier and log scores, calibration buckets, domain breakdowns, judged and pending counts — in one structured call, and `get_forecast_predictions` returns the current forecasts it will eventually grade. An agent can do something genuinely new with that pair: weight a forecast by the demonstrated track record of its domain before acting on it. The [risk-agent tutorial](/blog/posts/build-geopolitical-risk-agent-worldmonitor-mcp/) shows the wiring; the [daily briefing workflow](/blog/posts/daily-intelligence-briefing-workflow-15-minutes/) shows where forecasts fit a human routine.

## Limits

The ledger only proves what it contains: domains with few resolved forecasts have wide uncertainty around their scores, and the rolling window means the record is a moving sample, not an all-time monument. Resolution requires judgeable outcomes, so inherently vague geopolitical claims either get sharpened into resolvable form or don't enter the ledger. And a good historical Brier score is evidence, not a promise — regimes change, and calibration is always trailing.

## Scoring Reference

The scorecard uses the probability-scoring framework introduced in Glenn W. Brier's [1950 verification paper](https://journals.ametsoc.org/view/journals/mwre/78/1/1520-0493_1950_078_0001_vofeit_2_0_co_2.xml). Published sample sizes, voids, and calibration buckets are retained so readers can evaluate the result rather than rely on a headline accuracy claim.

## Frequently Asked Questions

**What is a Brier score?**

The mean squared difference between forecast probabilities and outcomes (0 or 1). Lower is better. Answering "50%" to everything scores 0.25, so a real track record needs to beat that meaningfully.

**Can forecasts be edited or deleted after the fact?**

No. Once a forecast enters the resolution ledger, its probability and claim are fixed. It resolves, or it's counted as pending — the two ways forecasts quietly vanish elsewhere are exactly what the ledger exists to prevent.

**Where can I see or query the scorecard?**

In the forecast panel on the dashboard, and programmatically via the `get_forecast_scorecard` MCP tool or the forecast REST endpoints in the [API reference](https://www.worldmonitor.app/docs/api-reference).

---

**Anyone can make predictions. The ledger currently reads Brier 0.202 over 32 scored calls, overconfident in the middle, beaten by the market head-to-head — published anyway, because a scorecard only counts if you print it before it flatters you.**
