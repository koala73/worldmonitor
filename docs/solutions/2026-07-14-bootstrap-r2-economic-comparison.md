---
title: Bootstrap R2 economic comparison
date: 2026-07-14
issue: 5300
status: complete-with-account-caveat
---

# Bootstrap R2 economic comparison

## Decision summary

The signed Upstash dashboard materially strengthens the R2 case. The sole World Monitor database
is currently on **Fixed 100 GB**, whose published nominal price is $800/month. The dashboard also
shows 1.3 billion commands, 3 GB average storage, and $219.36 cost for an unspecified displayed
period; it shows AWS `us-east-1` and offers **Enable Prod Pack**, so Prod Pack is not enabled.

On the post-#5319 like-for-like model, the first sufficient published fixed tier without R2 is
Fixed 50 GB at $400/month. The R2 design fits Fixed 5 GB at $100/month if the account is eligible
to move and current/peak data fits its 5 GB limit. Over six months:

- remaining on the current nominal Fixed 100 GB plan costs **$4,800**
- right-sizing without R2 costs **$2,400**
- R2 plus Fixed 5 GB costs **$600 to $655.86** in the modeled infrastructure scenarios

R2 therefore saves $4,144 to $4,200 against the current nominal plan, or $1,744 to $1,800 against
the already-right-sized no-R2 fixed alternative. The recommendation is to **proceed with R2 and
move to Fixed 5 GB if Upstash confirms plan-change and data-size eligibility**. Pay-as-you-go is
not the preferred alternative: unless the dashboard's 1.3 billion commands span more than about
211 days, normalized pay-as-you-go is more expensive than the $400 no-R2 fixed alternative.

The exact cash comparison retains one narrow account caveat: the dashboard did not expose the
summary period boundaries or a final invoice, so the $219.36 displayed cost must not be treated as
a monthly charge; Upstash must also confirm downgrade eligibility and that peak/current data fits
Fixed 5 GB. This caveat does not reverse the published-price recommendation.

The bucket and credentials provisioned in U1 are sunk cost and are not evidence for this decision.

## Scope and accounting conventions

- Currency: USD, excluding tax.
- Month: 30 days. Comparison horizon: six months.
- Decimal provider units are used for GB and operation pricing.
- Prices were checked on 2026-07-14 against the primary sources listed below.
- `P` is the unknown number of days covered by the signed dashboard's 1.3 billion commands.
- `C30 = 1.3 billion * 30 / P` is the normalized 30-day command count.
- `C30_r2` is the normalized 30-day command count after R2 cutover.
- Maintenance is reserved as **one engineer-hour per month** (six hours over the horizon). It is
  kept in hours because no approved loaded hourly rate was available; inventing one would make the
  account comparison look more complete than it is.

## Like-for-like traffic baseline and the #5319 correction

The 2026-07-14 MONITOR/`STRLEN` measurement in the implementation plan predates PR #5319:

| Input | Value | Unit | Source date | Use |
|---|---:|---|---|---|
| Redis read egress before #5319 | 48.4 | GB/day | 2026-07-14 | Historical measured baseline |
| Bootstrap-attributed portion before #5319 | 33.9 | GB/day | 2026-07-14 | Historical measured baseline |
| Non-bootstrap remainder | 14.5 | GB/day | 2026-07-14 | `48.4 - 33.9` |
| PR #5319 modeled reduction | 8.3 | GB/day | 2026-07-14 | Subtracted once, from bootstrap payloads |
| Corrected no-R2 baseline | 40.1 | GB/day | 2026-07-14 | `48.4 - 8.3` |
| Corrected no-R2 bandwidth | 1,203 | GB/month | 2026-07-14 | `40.1 * 30` |
| R2-design Redis target | 15.3 | GB/day | 2026-07-14 | Plan target after publisher/fallback reads |
| R2-design Redis bandwidth | 459 | GB/month | 2026-07-14 | `15.3 * 30` |

PR #5319 merged on 2026-07-14. Its approximately 8.3 GB/day reduction is included exactly once.
The R2 saving is therefore not `33.9 GB/day` again; on the corrected model it is
`40.1 - 15.3 = 24.8 GB/day`. A fresh complete-day post-#5319 measurement must replace the modeled
40.1 GB/day input when available.

## Account observations obtained safely

No credential, endpoint, project identifier, invoice detail, or object name is recorded here.

| Observation | Value | Method | Limitation |
|---|---:|---|---|
| Upstash organization | World Monitor; one Redis database | Signed dashboard, 2026-07-14 | Account identity is not reproduced here |
| Database plan | Fixed 100 GB; published nominal $800/month | Signed dashboard, 2026-07-14 | Displayed $219.36 is not assumed monthly |
| Database region | AWS `us-east-1` | Signed dashboard, 2026-07-14 | No paid read region shown |
| Dashboard commands | 1.3 billion | Signed dashboard, 2026-07-14 | Exact displayed-period boundaries unavailable |
| Dashboard average storage | 3 GB | Signed dashboard, 2026-07-14 | Peak/current value for Fixed 5 GB eligibility unavailable |
| Dashboard cost | $219.36 | Signed dashboard, 2026-07-14 | Period/invoice/credits are not shown; do not annualize |
| Prod Pack | Not enabled | Dashboard offers `Enable Prod Pack`, 2026-07-14 | No Prod Pack cost included |
| Redis current memory | 335,274,914 bytes (0.335 GB) | Authenticated read-only `INFO`, 2026-07-14 | Point-in-time differs from dashboard average |
| Redis keys | 174,761 | Authenticated read-only `DBSIZE`, 2026-07-14 | Count is not storage or command usage |
| Redis lifetime commands | 6,773,191,480 | Authenticated read-only `INFO`, 2026-07-14 | No uptime/window was returned; cannot derive 30-day usage |
| Railway account/project access | Authenticated; production project visible | `railway whoami` and read-only project listing, 2026-07-14 | CLI exposes no billing/usage report |
| Axiom local authorization | Ingest data-plane token present | Local environment-name inspection only | No organization plan, invoice, or usage headroom |
| Cloudflare authorization | R2/API data-plane credentials present | Local environment-name inspection only | No account-wide R2 billing counters |

The dashboard's 3 GB average storage fits Fixed 5 GB on average, but a downgrade must use the
provider's current/peak eligibility check rather than the lower point-in-time `INFO` observation.
Bandwidth selects Fixed 50 GB without R2; R2 makes Fixed 5 GB sufficient on modeled bandwidth.

## Current published prices

### Upstash Redis

Relevant fixed tiers and their per-read-region add-ons:

| Tier | Base/month | Bandwidth | Data | Read region/month |
|---|---:|---:|---:|---:|
| Fixed 5 GB | $100 | 500 GB | 5 GB | $50 |
| Fixed 10 GB | $200 | 1 TB | 10 GB | $100 |
| Fixed 50 GB | $400 | 5 TB | 50 GB | $200 |
| Fixed 100 GB | $800 | 10 TB | 100 GB | $400 |

Pay-as-you-go is $0.20 per 100,000 commands, the first 1 GB of storage is free and additional
storage is $0.25/GB-month, and the first 200 GB/month of bandwidth is free with excess at
$0.03/GB. Upstash documents that pipeline rows are Redis commands even though they share an HTTP
request; the bootstrap handler submits 25 or 65 `GET` commands per pipeline.

### Cloudflare R2 Standard

R2 includes 10 GB-month storage, 1 million Class A operations, and 10 million Class B operations
per month. Above the allowance, Standard storage is $0.015/GB-month, Class A is $4.50/million,
Class B is $0.36/million, and egress is free. Billable quantities round up to whole billing units.

### Railway

Railway charges actual resources at $10/GB-month RAM, $20/vCPU-month, $0.05/GB network egress, and
$0.15/GB-month volume storage. Paid-plan subscription charges are minimum commitments that include
the same amount of resource usage, so incremental invoice cost can be zero when the workspace has
unused included headroom.

### Axiom

Axiom's Personal plan permits 500 GB/month of data loading; Axiom Cloud includes 1,000 GB/month.
The public documentation directs account owners to Settings > Plan and Settings > Usage for the
actual plan, current ingest, add-ons, and bill. It does not publish a universal overage price for
the account's unknown plan.

## Workload arithmetic

### Redis commands

The current public tiers contain 25 fast keys and 65 slow keys. Measured origin misses are 34,000
fast and 7,200 slow per day. Because `/api/bootstrap` sends one `GET` command per key:

```text
current bootstrap commands/month
  = (34,000 * 25 + 7,200 * 65) * 30
  = 39,540,000 commands/month

publisher commands/month
  = (720 fast publishes/day * 25 + 144 slow publishes/day * 65) * 30
  = 820,800 commands/month

maximum fallback commands at the 1% R8 gate
  = 39,540,000 * 0.01
  = 395,400 commands/month

modeled command reduction
  = 39,540,000 - 820,800 - 395,400
  = 38,323,800 commands/month
  = $76.65/month at pay-as-you-go command pricing
```

This is only the bootstrap component. `C30` must still come from the Upstash account because RPC,
MCP, seeders, rate limits, sessions, and other consumers add commands.

### R2

Using measured response sizes of 764,124 bytes fast and 1,615,855 bytes slow:

```text
stored bytes = 764,124 + 1,615,855 = 2,379,979 bytes = 0.00238 GB
Class A PUTs/month = (720 + 144) * 30 = 25,920
Class B origin GETs/month = 41,200 * 30 = 1,236,000
```

Health reads add only thousands of Class B operations per month and do not approach the 10 million
allowance. As a standalone workload, storage and both operation classes fit the free tier, so R2
cost is $0/month. If all account-wide free allowances are already consumed, a deliberately
conservative standalone allocation with provider rounding is:

```text
storage: 1 billed GB * $0.015                         = $0.015
Class A: 1 billed million * $4.50                    = $4.500
Class B: 2 billed million * $0.36                    = $0.720
conservative R2 allocation                           = $5.235/month
```

The true marginal cost can be between these endpoints depending on account-wide usage and billing
unit position.

### Railway publisher

The publisher transfers approximately:

```text
((764,124 * 720) + (1,615,855 * 144)) * 30 / 1e9
  = 23.486 GB/month to R2
network egress = 23.486 * $0.05 = $1.17/month
```

No CPU/RAM deployment measurement exists before the service is created. The exact raw resource
formula is:

```text
Railway raw usage/month
  = 10 * average_RAM_GB + 20 * average_vCPU + 1.17
```

Two explicit capacity scenarios—not account measurements—are retained for sensitivity:

| Scenario | Average RAM | Average vCPU | Egress | Raw usage/month |
|---|---:|---:|---:|---:|
| Low idle Node service | 0.10 GB | 0.01 | $1.17 | $2.37 |
| Conservative small service | 0.25 GB | 0.02 | $1.17 | $4.07 |

The invoice increment is `max(0, raw usage - unused included workspace usage)`, not necessarily the
raw value. Measure one week after provisioning, as Railway recommends, and replace the scenario.

### Axiom steady state and U3a

Steady state emits 1,236,000 events/month. The emitter does not exist yet, so its exact
uncompressed event size cannot be measured. At a deliberately conservative 1 KiB/event envelope:

```text
steady ingest = 1,236,000 * 1,024 / 1e9 = 1.266 GB/month
```

If shadow telemetry and client RUM each emit one event per origin request, a one-day U3a window
adds at most `41,200 * 2 * 1,024 / 1e9 = 0.084 GB` at that envelope. General temporary ingest is:

```text
U3a GB = 41,200 * shadow_days * event_copies * serialized_event_bytes / 1e9
```

Incremental Axiom cost is $0 only if the account has at least 1.266 GB/month of steady loading
headroom plus the temporary U3a volume. Otherwise it is account-contract-dependent and remains an
invoice follow-up. Before enabling U3a, serialize a representative event and replace the 1 KiB
bound.

## Six-month comparison

### 1. Cheapest sufficient published Upstash fixed tier, no R2

The corrected 1,203 GB/month exceeds the 1 TB Fixed 10 GB tier. Fixed 50 GB is the first published
tier with sufficient bandwidth. The dashboard shows no paid read region and Prod Pack is disabled:

```text
right-sized monthly = $400
right-sized six months = $2,400

current Fixed 100 GB nominal monthly = $800
current Fixed 100 GB nominal six months = $4,800
```

The dashboard's $219.36 displayed cost has unknown period boundaries and is not substituted for
the published $800 monthly plan price or extrapolated into an invoice.

### 2. Upstash pay-as-you-go, no R2

Using the dashboard's 3 GB average storage, the storage term is $0.50/month:

```text
bandwidth/month = (1,203 - 200) * $0.03 = $30.09
commands/month = (1.3 billion * 30 / P) * $0.20 / 100,000
               = $78,000 / P
storage/month = $0.25 * (3 - 1) = $0.50

monthly = $30.59 + $78,000 / P
six months = $183.54 + $468,000 / P
```

Because `P` is not visible, the dashboard total must not be called trailing-30-day. Its sensitivity
is nevertheless decisive:

| Assumed dashboard period `P` | Normalized PAYG/month | PAYG/six months |
|---:|---:|---:|
| 30 days | $2,630.59 | $15,783.54 |
| 60 days | $1,330.59 | $7,983.54 |
| 90 days | $897.26 | $5,383.54 |
| 180 days | $463.92 | $2,783.54 |
| 212 days | $398.51 | $2,391.09 |

Pay-as-you-go only falls below the $400 no-R2 fixed alternative when `P` exceeds approximately
211 days. The exact period remains an account caveat, but PAYG is not the prudent recommendation.

### 3. R2 design

The 459 GB/month Redis target fits Fixed 5 GB:

```text
fixed-backed monthly
  = $100 + Railway_invoice_increment + R2_increment + Axiom_increment

fixed-backed six months
  = 6 * monthly + 6 engineer-hours maintenance
```

| R2 fixed-backed scenario | Six-month infrastructure cost | Maintenance |
|---|---:|---:|
| Existing Railway/Axiom/R2 allowances absorb increments | $600.00 | 6 engineer-hours |
| Low Railway raw usage; R2 and Axiom free | $614.25 | 6 engineer-hours |
| Conservative Railway raw usage; R2 free tier exhausted; Axiom free | $655.86 | 6 engineer-hours |

The design can also use Upstash pay-as-you-go after cutover:

```text
C30_r2 = C30 - 38,323,800  (modeled at the 1% fallback ceiling)
Redis PAYG monthly = $7.77 bandwidth + 0.000002 * C30_r2 + $0.50 storage
R2-design monthly = Redis PAYG monthly + Railway + R2 + Axiom
```

Substituting the dashboard observation gives Redis PAYG of approximately
`$78,000 / P - $68.38` per month after the modeled bootstrap reduction. It only falls below the
$100 Fixed 5 GB base if `P` exceeds approximately 463 days, so Fixed 5 GB is the recommended
post-cutover plan subject to eligibility.

## Sensitivity and break-even observations

- Against the current nominal Fixed 100 GB plan, the R2 design has about **$700/month** of room for
  incremental infrastructure. Against a right-sized no-R2 Fixed 50 GB plan it has $300/month. The
  conservative R2/Railway allocation above is $9.31/month, excluding dollarized maintenance.
- Without R2, pay-as-you-go reaches the $400 fixed-tier base at approximately 184.71 million
  commands/month after including the dashboard's $0.50 storage term.
- The dashboard reports 1.3 billion commands over an unspecified period. Pay-as-you-go beats the
  $400 no-R2 fixed base only if that period exceeds about 211 days; it is therefore not the
  recommended alternative without period-boundary evidence.
- Under R2, the modeled bootstrap command reduction is worth $76.65/month on pay-as-you-go before
  the $22.32/month bandwidth reduction (`$30.09 - $7.77`). This supports R2 even if the account
  ultimately changes Redis billing model.

## Remaining account caveat

The economic decision is complete under conservative published-price bounds. Before changing the
Redis plan or claiming realized savings, record only these still-unresolved account facts:

- the exact start and end dates covered by the 1.3 billion commands and $219.36 dashboard summary
- the final invoice and any credits, discounts, or proration explaining the displayed cost
- Upstash confirmation that this account may move from Fixed 100 GB to Fixed 5 GB and that its
  current/peak data size—not merely the displayed 3 GB average—is within the 5 GB limit

No period, invoice, or eligibility value is inferred from credentials or the current plan label.

## Sources

- Live 2026-07-14 Redis MONITOR/`STRLEN` attribution recorded in the measurements above.
- [PR #5319](https://github.com/koala73/worldmonitor/pull/5319), merged 2026-07-14: modeled
  approximately 8.3 GB/day sparkline-precision reduction.
- [Upstash Redis pricing](https://upstash.com/pricing/redis), checked 2026-07-14.
- [Upstash REST pipeline and command pricing](https://upstash.com/docs/redis/features/restapi),
  checked 2026-07-14.
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/), last updated 2026-05-28.
- [Railway pricing](https://docs.railway.com/pricing), last updated 2026-05-15.
- [Railway billing explanation](https://docs.railway.com/pricing/understanding-your-bill), last
  updated 2026-05-21.
- [Axiom plan limits](https://axiom.co/docs/reference/limits), checked 2026-07-14.
- [Axiom usage and billing](https://axiom.co/docs/reference/usage-billing), checked 2026-07-14.
- Signed Upstash Console dashboard, read-only inspection on 2026-07-14: organization summary and
  sole database plan/region/Prod Pack state. No credential or account identifier retained.
