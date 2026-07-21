---
title: "We Grade Our Own Forecasts: Inside the Forecast Scorecard"
description: "WorldMonitor resolves its AI forecasts against reality and publishes the results: Brier scores, log scores, calibration buckets, and per-domain accuracy breakdowns."
metaTitle: "AI Forecast Accuracy & Brier Scorecard | WorldMonitor"
keywords: "AI forecast accuracy, Brier score forecasting, geopolitical forecast track record, forecast calibration, prediction accountability, forecast verification"
audience: "Forecasters, superforecasting community, quant researchers, skeptical analysts, AI evaluation researchers"
heroImage: "/blog/og/ai-forecast-accuracy-brier-scorecard-worldmonitor.png"
pubDate: "2026-07-21"
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

## Why publish it

Three reasons, in ascending order of importance:

1. **It's the standard we hold others to.** WorldMonitor puts [Polymarket and Kalshi probabilities](/blog/posts/prediction-markets-ai-forecasting-geopolitics/) next to its own forecasts. Prediction markets keep score by construction — their prices are public history. Publishing our own Brier scores is the price of sitting in that company.
2. **It makes the forecasts usable.** A "78% probability" from a black box is decoration. The same number from a system whose calibration you can inspect is an input you can size decisions with.
3. **It improves the system.** Scored errors are training signal. The domains where calibration drifts are the domains where the pipeline gets fixed next.

## For developers and agents

The `get_forecast_scorecard` MCP tool returns the full scorecard — Brier and log scores, calibration buckets, domain breakdowns, judged and pending counts — in one structured call, and `get_forecast_predictions` returns the current forecasts it will eventually grade. An agent can do something genuinely new with that pair: weight a forecast by the demonstrated track record of its domain before acting on it. The [risk-agent tutorial](/blog/posts/build-geopolitical-risk-agent-worldmonitor-mcp/) shows the wiring; the [daily briefing workflow](/blog/posts/daily-intelligence-briefing-workflow-15-minutes/) shows where forecasts fit a human routine.

## Limits

The ledger only proves what it contains: domains with few resolved forecasts have wide uncertainty around their scores, and the rolling window means the record is a moving sample, not an all-time monument. Resolution requires judgeable outcomes, so inherently vague geopolitical claims either get sharpened into resolvable form or don't enter the ledger. And a good historical Brier score is evidence, not a promise — regimes change, and calibration is always trailing.

## Frequently Asked Questions

**What is a Brier score?**

The mean squared difference between forecast probabilities and outcomes (0 or 1). Lower is better. Answering "50%" to everything scores 0.25, so a real track record needs to beat that meaningfully.

**Can forecasts be edited or deleted after the fact?**

No. Once a forecast enters the resolution ledger, its probability and claim are fixed. It resolves, or it's counted as pending — the two ways forecasts quietly vanish elsewhere are exactly what the ledger exists to prevent.

**Where can I see or query the scorecard?**

In the forecast panel on the dashboard, and programmatically via the `get_forecast_scorecard` MCP tool or the forecast REST endpoints in the [API reference](https://www.worldmonitor.app/docs/api-reference).

---

**Anyone can make predictions. The scorecard is the difference between forecasting and content — and it only counts if you publish it before you know how it ends.**
