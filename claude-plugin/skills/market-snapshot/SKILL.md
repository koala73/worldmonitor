---
name: market-snapshot
description: Give a market snapshot from World Monitor - equity, commodity and crypto movers, sector performance and the Fear and Greed index - with quote times. Use when the user asks how markets are doing, for the biggest movers, or for a pre-market or end-of-day summary.
---

# Market snapshot

Summarize World Monitor's curated market snapshot.

## Tools

| Tool | Access |
|---|---|
| `get_market_data` | free-account |

## Steps

1. Call `get_market_data` with `asset_class: ["equity", "commodity", "crypto"]` and `limit: 0`. The default cap of 30 per list follows catalog order, not size of move, so a capped list can hide the biggest movers. Add `"sectors"` or `"sentiment"` when the user asks for sector performance or market mood. Pass `symbols` (for example `["AAPL", "GC=F", "BTC"]`) when the user names instruments.
2. For each asset class list the largest gainers and losers. The `change` field is already a percent change, so report it as a percent.
3. Point out correlated moves or single-name outliers that stand out in the data.

## Rules

- State the quote time. Quotes are flagged stale after 30 minutes; say so when they are.
- The snapshot covers a curated list of symbols, not the whole market. Say so when the user asks about an instrument that is missing.
- Report prices and changes only. Do not give buy, sell or hold recommendations, and do not place or suggest trades.
