---
title: Disease Outbreak WHO Retry - Plan
type: fix
date: 2026-09-03
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-incident-report
execution: code
---

# Disease Outbreak WHO Retry - Plan

## Goal Capsule

- **Objective:** Prevent one transient WHO Disease Outbreak News fetch failure from publishing a fresh but content-stale disease-outbreak aggregate.
- **Authority:** The reported production incident and repository contracts govern the work. The existing nine-day content-age threshold stays unchanged.
- **Execution profile:** One isolated branch, one test-first implementation unit, and one pull request.
- **Stop conditions:** Stop if the fix requires a freshness-budget increase, a production mutation, or a change to multi-source partial-publication policy.
- **Tail ownership:** Deliver a ready pull request. Do not merge it, enable auto-merge, request reviewers, or post public comments.

---

## Product Contract

### Summary

The disease-outbreak seeder will retry one transient WHO request failure at the source boundary. It will keep current behavior for permanent HTTP failures and for the remaining outbreak sources.

### Problem Frame

Production health reported `diseaseOutbreaks` as `STALE_CONTENT` with 157 records, a fresh seed age, and a content age above the nine-day budget. Railway logs showed that the successful seed had `WHO=0`, `CDC=631`, `ONT=0`, and `TGH=107` after the only WHO request timed out. A live probe of the same WHO API returned qualifying content dated 2026-08-28, so the upstream was not quiet. The adapter converted the timeout to an empty source before the existing seed-level retry could observe it.

### Requirements

- R1. Retry the WHO request once after a transient network, timeout, rate-limit, or server failure.
- R2. Do not retry permanent HTTP failures such as `403`.
- R3. Preserve the existing partial-publication behavior after the bounded WHO retry is exhausted.
- R4. Keep `maxContentAgeMin`, seed cadence, record selection, and all non-WHO adapters unchanged.
- R5. Prove the behavior with tests that execute the WHO adapter boundary.

### Acceptance Examples

- AE1. Given the first WHO request times out and the second request returns valid data, the adapter makes two requests and returns the normalized WHO record.
- AE2. Given the WHO endpoint returns `403`, the adapter makes one request and returns no WHO records.
- AE3. Given both transient attempts fail, the seeder can still publish the other sources and health can still expose persistent stale content.

### Scope Boundaries

- Do not increase the nine-day content-age budget or depend on the proposed stale-content grace.
- Do not repair the separate Outbreak News Today `403` in this change.
- Do not change aggregate validation or make WHO a required source.
- Do not run or redeploy the production seeder during diagnosis or implementation.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Put the retry in `fetchWhoDonApi()` because that is the boundary that currently absorbs the failure. An outer seed retry cannot observe a caught source error.
- KTD2. Reuse `withRetry()` and `httpRetryError()` from `scripts/_seed-utils.mjs`. This keeps permanent and transient HTTP classification consistent with other seeders.
- KTD3. Export the WHO adapter behind the repository's main-module guard and inject fetch and timing dependencies. This lets tests execute the real adapter without running the seeder or touching Redis.
- KTD4. Limit the change to one retry. Two 15-second attempts plus the retry delay stay well within the disease section's 300-second timeout.

### Assumptions

- WHO continues to expose the current JSON response shape with a `value` array.
- A single retry is enough to absorb the observed transient timeout without hiding persistent failure.
- The existing health content-age verdict remains the correct persistent-failure signal.

### Sequencing

Add the import-safe test seam and failing regression tests first. Then add the bounded retry, rerun the focused tests, and run the wider script-test gate.

### Risks and Dependencies

- The external WHO service can remain unavailable across both attempts. The current partial aggregate and health warning remain the fallback.
- The Railway service runs the disease section on a daily eligibility interval inside an hourly bundle. Production acceptance can occur only after the deployed revision runs an eligible disease section.

---

## Implementation Units

### U1. Retry transient WHO fetch failures

- **Goal:** Make one transient WHO request failure recover without changing the aggregate contract.
- **Requirements:** R1, R2, R3, R4, R5; AE1, AE2, AE3.
- **Files:** `scripts/seed-disease-outbreaks.mjs`, `tests/disease-outbreaks-seed.test.mjs`.
- **Approach:** Add the main-module guard and export the injectable WHO adapter. Add failing timeout-recovery and permanent-`403` tests. Reuse the shared retry and HTTP classification helpers in the adapter.
- **Test scenarios:** The first timeout recovers on the second call; a `403` is not retried; two transient failures return no WHO records after two calls; existing disease helper and seed behavior tests remain green.
- **Verification:** Run `node --test tests/disease-outbreaks-seed.test.mjs`, then the smallest repository gate that contains script data tests.

---

## Verification Contract

- `node --test tests/disease-outbreaks-seed.test.mjs` proves the adapter retry boundary and existing disease-outbreak behavior.
- `npm run test:data` is the wider required gate for changes under `scripts/` and `tests/`.
- `git diff --check` and `git status --short` prove diff hygiene before delivery.
- A pre-push PR snapshot must prove that local work is based on current `main` and that the remote head has not advanced.

---

## Definition of Done

- U1 passes all listed test scenarios and verification commands.
- The content-age threshold, non-WHO adapters, and production state are unchanged.
- The pull request contains only the plan, the adapter fix, and its regression proof.
- No dead-end implementation or speculative abstraction remains.
- The final handoff distinguishes local proof, pull-request readiness, deployment, and production acceptance.

---

## Appendix

### Production Acceptance After Deployment

After the merged revision deploys to Railway, wait for the first eligible `Disease-Outbreaks` bundle section. Confirm its log reports a nonzero WHO count and `seed_complete` with `state=OK`. Then fetch `https://api.worldmonitor.app/api/health?compact=1` after a new `checkedAt` value and confirm `diseaseOutbreaks` is absent from `problems`. Other health warnings do not block this source-specific acceptance.
