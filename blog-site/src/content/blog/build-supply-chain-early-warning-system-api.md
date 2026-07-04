---
title: "Build a Supply-Chain Early-Warning System in an Afternoon"
description: "Score your trade lanes for chokepoint exposure, subscribe to disruption webhooks, and pipe alerts to Slack with this World Monitor API tutorial."
metaTitle: "Supply Chain Risk API: Chokepoint Alerts | World Monitor"
keywords: "supply chain risk API, chokepoint monitoring API, shipping disruption alerts, maritime risk API, trade route risk scoring, supply chain early warning system"
audience: "Supply chain engineers, logistics developers, procurement analysts, platform teams, risk managers"
heroImage: "/blog/images/blog/build-supply-chain-early-warning-system-api.jpg"
pubDate: "2026-06-08"
modifiedDate: "2026-06-13"
---

When the Strait of Hormuz shut down this spring, companies found out in one of two ways. Some read about it in the news and started calling freight forwarders. Others had already received a webhook hours earlier, when the disruption score crossed their alert threshold, and were quoting Cape of Good Hope routings before their competitors knew there was a problem.

The second group did not have a $50,000-a-year risk platform. The capability they used, [live chokepoint tracking](/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/) with programmatic alerts, is part of World Monitor's API. This post builds that early-warning system end to end: score your lanes, subscribe to alerts, verify deliveries, and route them to Slack.

You need an API key (`X-WorldMonitor-Key`, issued with [Pro or API plans](https://www.worldmonitor.app/pro)) and about an afternoon.

## The Architecture

Three signals, three endpoints:

1. **Lane exposure:** which chokepoints does each of my trade lanes depend on? (`/api/v2/shipping/route-intelligence`)
2. **Live disruption:** push notification when a chokepoint's disruption score crosses my threshold (`/api/v2/shipping/webhooks`)
3. **Country context:** structural resilience of origin and destination countries (`/api/resilience/v1/get-resilience-score`)

A small receiver service glues them together and posts to Slack.

## Step 1: Score Your Lanes

For each lane you ship, ask the route-intelligence endpoint what it crosses and how disrupted that is right now:

```bash
curl -s 'https://api.worldmonitor.app/api/v2/shipping/route-intelligence?fromIso2=AE&toIso2=NL&cargoType=tanker&hs2=27' \
  -H 'X-WorldMonitor-Key: wm_YOUR_KEY'
```

The response tells you everything a routing decision needs:

```json
{
  "primaryRouteId": "ae-to-eu-via-hormuz-suez",
  "chokepointExposures": [
    { "chokepointId": "hormuz_strait", "chokepointName": "Strait of Hormuz", "exposurePct": 100 },
    { "chokepointId": "suez", "chokepointName": "Suez Canal", "exposurePct": 100 }
  ],
  "bypassOptions": [
    {
      "name": "Cape of Good Hope",
      "type": "maritime_detour",
      "addedTransitDays": 12,
      "addedCostMultiplier": 1.35,
      "activationThreshold": "DISRUPTION_SCORE_60"
    }
  ],
  "warRiskTier": "WAR_RISK_TIER_ELEVATED",
  "disruptionScore": 68
}
```

Read it like this: this tanker lane is 100% exposed to both Hormuz and Suez, the current disruption score on the primary chokepoint is 68/100, and the documented bypass adds 12 transit days at a 1.35× cost multiplier. `cargoType` matters because bypass options are filtered to corridors suitable for your cargo (`container`, `tanker`, `bulk`, or `roro`), and `hs2` lets you scope by commodity chapter.

Run this once for every lane in your network and you have an exposure matrix: which chokepoints, at what percentage, with what fallback. Most teams discover that 70% of their volume funnels through two or three waterways.

## Step 2: Subscribe to Disruption Webhooks

Polling is for prototypes. Register a webhook for the chokepoints your matrix surfaced:

```bash
curl -s -X POST 'https://api.worldmonitor.app/api/v2/shipping/webhooks' \
  -H 'X-WorldMonitor-Key: wm_YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "callbackUrl": "https://alerts.yourcompany.com/wm-shipping",
    "chokepointIds": ["hormuz_strait", "suez", "bab_el_mandeb"],
    "alertThreshold": 60
  }'
```

The `201` response returns a `subscriberId` and a one-time `secret`; persist it, because the server never shows it again. There is a `rotate-secret` endpoint when you need a new one. Omitting `chokepointIds` subscribes you to all 13 monitored chokepoints. Subscriptions expire after 30 days, so re-register on a monthly cron to keep both the record and the owner index alive.

When a chokepoint's disruption score crosses your threshold, you get:

```
POST https://alerts.yourcompany.com/wm-shipping
X-WM-Signature: sha256=<HMAC-SHA256(body, secret)>
X-WM-Delivery-Id: <ulid>
X-WM-Event: chokepoint.disruption

{
  "chokepointId": "hormuz_strait",
  "score": 74,
  "alertThreshold": 60,
  "triggeredAt": "2026-06-08T12:03:00Z",
  "reason": "ais_congestion_spike"
}
```

## Step 3: Verify and Route to Slack

Never trust an unverified webhook. The signature is a standard HMAC over the raw body:

```js
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();

// Express does not expose the raw body by default, but HMAC must be
// computed over the exact bytes that were signed. Capture them here.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = (signatureHeader || '').replace('sha256=', '');
  return received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// Remembers delivery IDs we have already processed. Use a TTL cache or a
// shared store (Redis) in production; an unbounded Set leaks memory.
const seenDeliveries = new Set();

app.post('/wm-shipping', (req, res) => {
  if (!verify(req.rawBody, req.headers['x-wm-signature'], SECRET)) {
    return res.status(401).end();
  }

  const deliveryId = req.headers['x-wm-delivery-id'];
  if (seenDeliveries.has(deliveryId)) return res.status(200).end();
  seenDeliveries.add(deliveryId);

  const { chokepointId, score, reason } = req.body;
  postToSlack(`:rotating_light: ${chokepointId} disruption at ${score}/100 (${reason}). ` +
    `Affected lanes: ${lanesExposedTo(chokepointId).join(', ')}`);
  res.status(200).end();
});
```

Three production notes from the delivery contract: the HMAC must be computed over the **raw request bytes**, which is why the `express.json` `verify` hook stashes `req.rawBody`; recomputing it from the parsed object will not match. Delivery is **at-least-once**, so deduplicate on `X-WM-Delivery-Id` and back the Set with a TTL cache or Redis so it does not grow forever. Repeated delivery failures deactivate the subscription, so wire up the `reactivate` endpoint in your runbook.

The `lanesExposedTo()` lookup is your exposure matrix from Step 1. That is what turns a generic "Hormuz is disrupted" alert into "your AE→NL tanker lane just lost its primary route; the Cape bypass costs 1.35× and 12 extra days."

## Step 4: Add Country Context

Chokepoints are not the only failure mode. A supplier country sliding into instability disrupts production before anything reaches a port. Pull structural resilience for your origin countries:

```bash
curl -s 'https://api.worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=EG' \
  -H 'X-WorldMonitor-Key: wm_YOUR_KEY'
```

You get a 0–100 resilience score with per-domain breakdowns (energy, infrastructure, governance, security and more), a trend, and a 30-day change. It is computed across 196 countries and refreshed every six hours. Combine it with the real-time [Country Instability Index](/blog/posts/country-instability-index-methodology-explained/) and you cover both clocks: CII for what is burning this week, resilience for which countries absorb shocks and which shatter.

A simple weekly job that flags any origin country whose resilience dropped more than a few points in 30 days catches slow-burn deterioration that no chokepoint webhook will ever see.

## What You End Up With

- An **exposure matrix** mapping every lane to its chokepoints, bypasses, and current disruption scores
- **Push alerts** within minutes of a disruption-score threshold crossing, signed and deduplicated
- **Country-level early warning** on supplier fragility, refreshed every six hours
- A Slack channel that occasionally says something genuinely important

Total code: one webhook receiver and two cron jobs. If you want to stress-test the design, the [scenario engine](https://www.worldmonitor.app/docs/scenario-engine) simulates events like a Taiwan Strait closure or a Panama drought against live trade data. AI agents can run the same checks conversationally through the [MCP server](/blog/posts/worldmonitor-mcp-server-ai-agents-real-time-intelligence/).

## Frequently Asked Questions

**Which chokepoints can I monitor?**

All 13 strategic waterways World Monitor tracks, including the Strait of Hormuz, Suez Canal, Bab el-Mandeb, Strait of Malacca, Panama Canal, Taiwan Strait, Bosporus, Kerch Strait, and the Cape of Good Hope bypass corridor.

**How fresh is the disruption data?**

Chokepoint transit counts blend IMF PortWatch weekly baselines with real-time AIS crossing counters; disruption scores update continuously and route-intelligence responses are cached for at most 60 seconds.

**Do I need to host my own receiver?**

For webhooks, yes. Any HTTPS endpoint works, while private and loopback addresses are rejected at registration. If you just want notifications without code, Pro accounts can route alerts to Slack, Discord, Telegram, or email through the built-in notification channels instead.

---

**Get an API key at [worldmonitor.app/pro](https://www.worldmonitor.app/pro), pull the full OpenAPI spec from [worldmonitor.app/openapi.yaml](https://www.worldmonitor.app/openapi.yaml), and ship the early-warning system your freight forwarder thinks you bought from someone expensive.**
