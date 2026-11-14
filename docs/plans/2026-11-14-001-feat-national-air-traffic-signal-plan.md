# National air traffic signal plan

On 2026-11-13 the FAA stopped every departure in the US for four hours. WorldMonitor sent no US alert and kept no record of the traffic collapse.
This program gives analysts a 5-minute national civil traffic series and an alert when US departures collapse.
The rule it enforces is that a traffic alert fires only on a measured drop against a same-weekday baseline, while a control region shows the feed is healthy.
PR A records the series in the relay. PR B adds the departure-collapse detector and its notification. B is stacked on A.
FAA ground-stop notifications shipped separately in https://github.com/koala73/worldmonitor/pull/10718.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator merges. PR A and PR B both stop at STACK-READY, and the operator lands them bottom-up.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:AGENTS.md`
  - [ ] `git show origin/main:docs/solutions/integration-issues/opensky-bbox-area-billing-flat-top-tier.md`
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] PR A is first. It branches from `main`.
  - [ ] PR B after PR A. It branches from the PR A branch.
- [ ] Hold the file boundaries. PR A touches only `scripts/shared/air-traffic-*.cjs`, `scripts/ais-relay.cjs`, `Dockerfile.relay`, `api/health.js`, `package.json`, and `tests/air-traffic-*`. PR B touches only `scripts/shared/air-traffic-detector.cjs`, `scripts/ais-relay.cjs`, and `tests/air-traffic-detector*`.
- [ ] Hold the review gate. Neither PR changes an interaction. The operator still lands both.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use `gh pr create --base <base-branch>`. PR B targets the PR A branch.
- [ ] Run `npm run typecheck`, `npm run typecheck:api`, and `npm run lint:boundaries` once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every review comment per `../references/bugbot-triage.md`. Bugbot does not run in this repository, so record that.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append each verified PR to the base-branch stack. The operator lands the stack bottom-up. A rebased head keeps its verdict only when its patch-id is unchanged per `playbooks/shipping.md`.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. The relay has no control skill, so each lane drives the real relay process through `node` with the fixture preload and reads the fixture Redis.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `npm run worktree:bootstrap`. Start the relay with `NODE_OPTIONS=--require=./scripts/ais-relay-test-preload.cjs node scripts/ais-relay.cjs` and the lane's OpenSky fixture. Wait for the log line `[AirTraffic] loop starting`.
- [ ] Deliver input only through fixture OpenSky responses and fixture clock offsets. Read state only through fixture Redis dumps and relay stdout.
- [ ] Save every artifact to `/tmp/swarm-<pr-id>/worker-<n>/<slug>` and return the paths with the report.

## Record the national traffic series in the relay (PR A)

**Depends on.** None.

**Files.**

- [ ] Create `scripts/shared/air-traffic-regions.cjs` with the US hub table (IATA, lat, lon) and the CONUS and Europe boxes.
- [ ] Create `scripts/shared/air-traffic-aggregate.cjs` with `aggregateStates(states, fetchedAt)`.
- [ ] Create `scripts/shared/air-traffic-history.cjs` with `recordTrafficPoint(point, upstashEval)`.
- [ ] Edit `scripts/ais-relay.cjs` to add the `[AirTraffic]` loop.
- [ ] Edit `Dockerfile.relay` to COPY the three shared files.
- [ ] Edit `api/health.js` to register `airTrafficHistory`.
- [ ] Create `tests/air-traffic-aggregate.test.mjs` and `tests/air-traffic-history-redis.test.mjs`.

**Build.**

- [ ] Open the owner issue for the new health probe before the first push. `scripts/check-health-probe-cutovers.mts` rejects a new `SEED_META` entry without `cutover.issue`.
- [ ] Define the point shape in `air-traffic-aggregate.cjs`. A point is `{ t, status, usAirborne, usLowClimbing, euAirborne, hubs }`. `t` is the 5-minute bin start. `status` is `ok` or `gap`. `usLowClimbing` counts airborne CONUS states below 3,000 m with a positive vertical rate. `hubs` maps each IATA to `{ air, ground }` within 48 km.
- [ ] Add one relay loop with `startBootSeedLoop` at a 300,000 ms interval. Each tick requests the bare global `/states/all` through the existing `/opensky` proxy, so the account cooldown and cache stay in one place.
- [ ] On an OpenSky failure, write a point with `status` set to `gap` and no counts. Never write zeros for a failed fetch.
- [ ] Store points in one hash per UTC day, `aviation:traffic:history:v1:<YYYY-MM-DD>`, field `t`, with `EXPIREAT` at day end plus 35 days. Follow `scripts/shared/pizzint-history.cjs`, which does the same in one Lua call.
- [ ] Write `seed-meta:aviation:traffic-history` and `seed-activated:aviation:traffic-history` in the same Lua call.
- [ ] Register the data key in `STANDALONE_KEYS`, `SEED_META` with `maxStaleMin` 20 and an activation-marker cutover, `ON_DEMAND_KEYS`, and `ACTIVATION_MARKERS` in `api/health.js`.
- [ ] Add the new tests to `test:data` discovery. They live in `tests/`, so no `package.json` list change is needed. Record that check.

**You see.**

- [ ] Relay stdout prints `[AirTraffic] t=<bin> status=ok us=<n> usLowClimbing=<n> eu=<n> hubs=20` every 5 minutes.
- [ ] `HGETALL aviation:traffic:history:v1:<today>` returns one field per bin since deploy.
- [ ] `/api/health` lists `airTrafficHistory` as OK within 20 minutes of the first point.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/air-traffic-aggregate.test.mjs` gains cases for CONUS and Europe box edges, the hub radius, on-ground rows, rows without position, and a null vertical rate. Run `node --test tests/air-traffic-aggregate.test.mjs`.
- [ ] `tests/air-traffic-history-redis.test.mjs` gains cases for one hash per UTC day, an idempotent rewrite of the same bin, the `EXPIREAT` value, and a `gap` point. Run `node --test tests/air-traffic-history-redis.test.mjs`.
- [ ] `tests/activation-marker-unknown-state.test.mjs` and `npx tsx scripts/check-health-probe-cutovers.mts` pass. Run both.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the relay at trunk and head with the same 10,000-state global fixture. Trunk lacks the feature, so record that and gate the head writing one `ok` point with the fixture's counts. Save `lane1-trunk-vs-head.txt`. Pass when trunk writes no traffic key and head writes exactly one point that matches the fixture's hand-counted totals.
- [ ] Lane 2. Replay six snapshots sampled from the adsb.lol archive for 2026-11-13 between 20:30Z and 21:00Z. Save `lane2-onset.json`. Pass when `usLowClimbing` falls by more than half between the 20:30Z and 20:50Z points.
- [ ] Lane 3. Fixture OpenSky answers HTTP 429. Save `lane3-gap.json`. Pass when the stored point has `status` set to `gap` and no count fields.
- [ ] Lane 4. Fixture OpenSky times out for three ticks, then recovers. Save `lane4-recovery.json`. Pass when three `gap` points are followed by an `ok` point and the relay keeps serving other routes.
- [ ] Lane 5. Advance the fixture clock across 23:55Z to 00:05Z. Save `lane5-day-roll.json`. Pass when the two points land in two day hashes with the correct `EXPIREAT`.
- [ ] Lane 6. Run two relay replicas against one fixture Redis for three ticks. Save `lane6-replicas.json`. Pass when each bin holds one point and no bin is double counted.
- [ ] Lane 7. Request `/opensky` with no bbox from a client while the loop runs. Save `lane7-cache.txt`. Pass when the client and the loop share one upstream fetch per cache window.
- [ ] Lane 8. Read `/api/health` from `vercel dev` against the fixture Redis before and after the first point. Save `lane8-health.json`. Pass when the probe moves from the activation-pending state to OK.
- [ ] Lane 9. Feed a snapshot with no US states and a normal Europe count. Save `lane9-empty-us.json`. Pass when the point is `ok` with `usAirborne` 0 and `euAirborne` above 0.
- [ ] Lane 10. Feed a malformed OpenSky body (`states` is null). Save `lane10-malformed.json`. Pass when the point is `gap` and the relay logs one warning.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Aggregation time per snapshot, relay RSS, OpenSky credits per day, and Redis bytes per day. Trunk lacks the loop, so the diff-added work gets absolute budgets.
- [ ] Probe. Time `aggregateStates` over the archive-derived 10,000-state fixture 50 times, interleaved with trunk relay RSS samples over the same 10 minutes. Read `X-Rate-Limit-Remaining` from proxy logs for credits.
- [ ] Baseline. Record trunk relay RSS and daily OpenSky credit use from Railway logs first.
- [ ] Rule. Fail when median aggregation exceeds 200 ms, relay RSS rises more than 25 MB over trunk, added credits exceed 1,200 per day, or a day hash exceeds 1.5 MB.

**Review gate.** None. PR A is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR A to the base-branch stack and the operator lands it bottom-up.

## Alert on a US departure collapse (PR B)

**Depends on.** PR A.

**Files.**

- [ ] Create `scripts/shared/air-traffic-detector.cjs` with `evaluateCollapse(points, baselines)`.
- [ ] Edit `scripts/ais-relay.cjs` to call the detector after each recorded point.
- [ ] Create `tests/air-traffic-detector.test.mjs` and `tests/air-traffic-detector-replay.test.mjs`.

**Build.**

- [ ] Model the detector as a state machine with states `normal`, `collapsed`, and `insufficient-baseline`. Persist the state in `aviation:traffic:detector:v1`.
- [ ] Baseline each bin as the median `usLowClimbing` at the same UTC bin on the last four same weekdays with `ok` points. Fewer than two such days puts the detector in `insufficient-baseline`, and it never alerts.
- [ ] Enter `collapsed` when two consecutive `ok` points read below 30% of baseline while `euAirborne` is at least 80% of its own baseline. Leave it when two consecutive points read above 70%.
- [ ] On entry, publish `aviation_traffic_collapse` with severity `critical`. On exit, publish the same type with severity `high` and a recovery title. Both payloads carry `countryCode` `US`, the ratio, and the onset bin.
- [ ] Add the new type to the payload audit in `tests/notification-relay-payload-audit.test.mjs` and the country-scope test in `tests/notification-relay-country-scope-5359.test.mjs`.

**You see.**

- [ ] On the 2026-11-13 replay the relay logs `[AirTraffic] collapse entered ratio=<r> onset=20:40Z` and queues one critical event.
- [ ] On the 2026-11-06 replay the relay queues nothing.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/air-traffic-detector.test.mjs` gains cases for each transition, a `gap` point inside the window, a Europe-control drop that blocks the alert, and fewer than two baseline days. Run `node --test tests/air-traffic-detector.test.mjs`.
- [ ] `tests/air-traffic-detector-replay.test.mjs` replays committed 5-minute series derived from the adsb.lol archives for 2026-11-13 and 2026-11-06. Run `node --test tests/air-traffic-detector-replay.test.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay the 2026-11-13 series at trunk and head. Trunk lacks the detector, so record that and gate the head queueing one critical event by 20:50Z. Save `lane1-trunk-vs-head.txt`. Pass when trunk queues no traffic event and head queues one with onset 20:40Z or 20:45Z.
- [ ] Lane 2. Replay the 2026-11-06 series. Save `lane2-normal-friday.json`. Pass when no event is queued.
- [ ] Lane 3. Replay 2026-11-13 through 02:00Z on 2026-11-14. Save `lane3-recovery.json`. Pass when one recovery event follows the stop's lift at 01:15Z.
- [ ] Lane 4. Replay with a fresh Redis and one baseline day. Save `lane4-cold-start.json`. Pass when the state is `insufficient-baseline` and nothing is queued.
- [ ] Lane 5. Replay 2026-11-13 with Europe counts scaled to 50%. Save `lane5-feed-loss.json`. Pass when nothing is queued and the log names the control-region block.
- [ ] Lane 6. Replay with three `gap` points at 20:40Z to 20:50Z. Save `lane6-gaps.json`. Pass when the detector waits for two `ok` points before it enters `collapsed`.
- [ ] Lane 7. Restart the relay at 20:45Z mid-replay. Save `lane7-restart.json`. Pass when exactly one critical event is queued across the restart.
- [ ] Lane 8. Run the notification relay against the queued event with a US-scoped rule and a Europe-scoped rule. Save `lane8-delivery.json`. Pass when only the US-scoped rule matches.
- [ ] Lane 9. Replay a holiday-shaped day at 60% of baseline. Save `lane9-holiday.json`. Pass when nothing is queued.
- [ ] Lane 10. Replay a single-bin dip to 10% that recovers in the next bin. Save `lane10-blip.json`. Pass when nothing is queued.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Detector time per tick, including the baseline reads, and Redis commands per tick. Trunk lacks the detector, so the diff-added work gets absolute budgets.
- [ ] Probe. Time 288 ticks of the 2026-11-13 replay at head, interleaved with the same replay at the PR A head.
- [ ] Baseline. Record the PR A head tick time first.
- [ ] Rule. Fail when the detector adds more than 50 ms median per tick or more than 6 Redis commands per tick.

**Review gate.** None. PR B is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR B to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The adsb.lol archive analysis on 2026-11-14 is the evidence for the signal. It ran over `adsblol/globe_history_2026` releases `v2026.11.13-planes-readsb-prod-0` and `v2026.11.06-planes-readsb-prod-0`.

- Airline departures over CONUS fell from 106 to 20 per 5 minutes at 20:40Z on 2026-11-13. The previous Friday held between 102 and 136 for the same bins. The official ground stop started at 20:54Z.
- Airline aircraft airborne over CONUS fell to 0.14 of the previous Friday by 23:45Z, while the Europe control region stayed between 0.85 and 1.0.

Two questions stay unproven. First, whether the stateless `usLowClimbing` count from 5-minute snapshots tracks true departures as sharply as the trace-based count. PR A lane 2 answers it. Second, how OpenSky coverage compares with adsb.lol coverage. The archive counted 1,314 aircraft airborne over CONUS at 23:30Z, and a public OpenSky count near that time was 1,083.

## Appendix B. Alternatives rejected

- Counting departures from aircraft state across snapshots. It needs the previous snapshot in memory and breaks on relay restarts. The stateless low-and-climbing count needs neither.
- Backfilling the baseline from adsb.lol archives. Their coverage differs from OpenSky, so a ratio across the two sources is not valid.
- Using adsb.lol or Wingbits as the national fallback. adsb.lol `/v2/mil` is military only and Wingbits answers regional boxes. A gap point is more honest than a partial count.
- Reviving the disabled OpenSky path in `scripts/seed-military-flights.mjs`. That path was turned off on purpose in #6224, and the relay already owns the account cooldown.

## Appendix C. Risks

- OpenSky credits. The loop adds about 1,152 credits per day against a 4,000 per day account limit, shared with on-demand map requests. PR A measures the remaining credits first.
- OpenSky reliability. On 2026-11-13 the relay's OpenSky login failed from 23:03Z to 23:36Z and from 00:07Z to 00:31Z. PR A records those windows as `gap`, and PR B never treats a gap as a drop.
- Relay surface. No control skill drives the Railway relay, so live lanes run the real relay locally with fixture upstreams. Production evidence arrives only after the operator deploys.
- Health probe gate. PR A needs an owner issue before its first push.

## Appendix D. Links and reading list

- `scripts/shared/pizzint-history.cjs` and `tests/pizzint-history-redis.test.mjs` for the day-hash pattern.
- `docs/solutions/integration-issues/opensky-bbox-area-billing-flat-top-tier.md` for OpenSky credit billing.
- `scripts/check-health-probe-cutovers.mts` for the cutover rule.
- https://github.com/koala73/worldmonitor/pull/10718 for the FAA notification fix.
- Run `pstack/skills/how/SKILL.md` and `pstack/skills/interrogate/SKILL.md` on PR B. The detector thresholds are the contested design.
