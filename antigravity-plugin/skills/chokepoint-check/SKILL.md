---
name: chokepoint-check
description: Check shipping disruption at maritime chokepoints such as Hormuz, Suez, Bab el-Mandeb, Malacca and Panama - vessel transits today, week-over-week change, risk level and incidents - from World Monitor. Use when the user asks whether a strait or canal is disrupted, congested or safe for shipping.
---

# Chokepoint check

Report the current state of one or all of the 13 maritime chokepoints World Monitor tracks.

## Tools

| Tool | Access |
|---|---|
| `get_chokepoint_status` | free-account |
| `get_energy_intelligence` | free-account |

## Steps

1. Call `get_chokepoint_status` with `dataset: ["transit-summaries"]`. Add `chokepoint` with a lowercase name fragment (`"hormuz"`, `"suez"`, `"malacca"`, `"bab"`, `"panama"`) when the user names one.
2. For each chokepoint report today's transits (total, tanker and cargo), the week-over-week change, the risk level and incidents in the last seven days. The tool withholds the risk narrative (`riskSummary` is always empty); do not write one, and do not read the empty field as low risk.
3. When the user asks about oil or gas supply, also call `get_energy_intelligence` and add active disruptions that mention the chokepoint.

## Rules

- Transit counts come from vessel position data and are flagged stale after 30 minutes. State the observation time, and say so plainly when the data is stale or `dataAvailable` is false.
- Compare against the week-over-week figure in the data. Do not invent a historical baseline.
- Do not give routing, insurance or trading advice.
