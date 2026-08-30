# Residual review findings — #7376 / PR #7415

Accepted residuals after applying important review fixes (preserve SSR on soft failure, crisis `dateModified` date-only, UTC `formatStaticDateTime`).

## Accepted (out of scope or intentional)

1. **Hazard / airspace tools still use Loading / undated timestamps** — outside the #7376 country / chokepoint / crisis live-signal tile scope. Follow-up when those tools get a committed pulse freeze.

2. **Partial country pulses still show score `—` with “No current score”** — intentional: advisory/sanctions-only rows are published without fabricating an instability score. Do not overclaim “zero em-dashes” for partial pulses.

3. **Optional `npm run freeze:crawlable-live-pulse` script** — freeze remains an explicit operator command (`node scripts/freeze-crawlable-live-pulse.mjs`); package script wiring deferred.

4. **Freeze-script network integration test** — not added; freeze hits production APIs and is operator-run. Preserve-on-error coverage added in `tests/crawlable-live-tools.test.mjs` instead.
