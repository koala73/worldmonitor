---
title: "economic:ecb-fx-rates:v1 change1d is an absolute rate delta, not a percentage — appending % misreports every pair"
date: 2026-08-05
category: integration-issues
module: scripts/seed-ecb-fx-rates.mjs
problem_type: integration_issue
component: frontend
symptoms:
  - "A new surface renders the ECB day-over-day figure as '+0.0%' for most pairs, every day"
  - "The pairs that do move show a percentage wrong by a factor of rate/100 — EURJPY 0.85 prints as '0.9%' when the true change is 0.50%"
  - "Two surfaces rendering the same seeded field disagree numerically, with no test failing on either side"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [ecb, fx, change1d, unit-contract, seeded-payload, quote-direction, cross-surface-parity, market-panel]
---

## Problem

`economic:ecb-fx-rates:v1` carries a `change1d` field per currency pair. The name reads like a percentage — most `change`/`change1d` fields in this codebase are — but it is an **absolute difference in rate units**. Rendering it with a `%` sign silently misreports every pair.

## Symptoms

- Five of the seven seeded pairs (USD, GBP, CHF, CAD, AUD — all quoted between roughly 0.8 and 1.7) print `+0.0%` or `-0.0%` every single day, because their absolute daily move rounds to zero at one decimal place.
- The two pairs quoted in the tens or hundreds (JPY, and any similar) print a number that looks plausible but is wrong by a factor of `rate / 100`.
- Nothing fails. The value is finite, the sign is right, and the formatting is well-formed — it is simply the wrong unit.

## What Didn't Work

- **Inferring the unit from the field name.** `change1d` sits alongside `rate` and `date` in a payload of numbers; nothing in the shape says which unit it is in.
- **Inferring it from the type.** The generated proto/client type is `change1d: number`, which is equally true of a percentage and a delta.
- **Trusting a sibling implementation read quickly.** The pre-existing consumer renders it correctly, but does so by *omitting* a suffix rather than by naming the unit, so a fast read of that code does not obviously say "this is not a percentage."

## Solution

Read the producer. `scripts/seed-ecb-fx-rates.mjs` computes it as a subtraction of two rates:

```js
const change1d = prev ? +(rate - prev.value).toFixed(6) : 0;
```

So it is an absolute delta in the same units as `rate`. The pre-existing consumer, `src/components/MarketPanel.ts`, renders it unsuffixed for exactly that reason:

```js
const changeStr = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(4)}` : '';
```

The fix is to match that, and to say the unit in the type so the next reader does not have to re-derive it:

```ts
/**
 * Day-over-day change as an ABSOLUTE difference in `rate` units — NOT a
 * percentage. `scripts/seed-ecb-fx-rates.mjs` computes `rate - prev.value`,
 * and the pre-existing consumer renders it unsuffixed for that reason.
 *
 * The seeder writes 0 BOTH when the rate did not move and when there is no
 * prior observation, so 0 cannot be read as "confirmed unchanged".
 */
change1d: number | null;
```

## Why This Works

Two distinct traps are closed by reading the producer rather than the shape:

1. **The unit.** A subtraction of two prices is a price delta. The only place that is stated is the seeder line.
2. **The zero.** The seeder's ternary writes `0` in the no-prior-observation case, so a `0` in this field is ambiguous between "flat today" and "first observation ever." A consumer that renders `0` as a confident "unchanged" is asserting something the payload does not support. This is invisible from the type, which is a non-optional `number` and decodes a missing value to `0` as well.

## Prevention

- **When a seeded numeric field feeds a new surface, open the seeder line that computes it before rendering it.** The producer is the only authority on units; the field name, the type, and the JSON shape are all silent. This is the same class of error as quote direction in FX payloads — `shared:fx-rates:v1` is USD *per unit of* the listed currency while the ECB rates are units *per euro*, and both are just `number`.
- **When a second surface starts rendering a field an existing surface already renders, pin the parity in a test.** The failure mode is not a crash but a quiet disagreement between two screens showing "the same" number:

```ts
it('renders the ECB day change as an absolute delta, never a percentage', async () => {
  await mount(rows({ ecb: [{ pair: 'EURJPY', rate: 171.2, change1d: 0.85 }] }));
  await clickTab('spot');
  expect(body()).toContain('+0.8500');
  expect(body()).not.toContain('+0.9%');
  expect(body()).not.toMatch(/[+-]?\d+\.\d%/);
});
```

- **Name the unit in the type's doc comment, not in a comment at the call site.** The call site is where the mistake gets made; the type is where the next author looks.
