# Verify China source recovery

Use this procedure after a source failure or an authorized credential rollout. Read stored evidence and existing run logs. This procedure does not authorize provider probes, manual jobs, deployments, or credential changes.

## Preserve the incident

1. Record the original `lastHealthyAt` for broader coverage and `lastDecisionCoverageSuccessAt` for decision coverage independently.
2. Keep each original deadline when the degraded source changes. Attempts, TTL extensions, and publication metadata do not reset the deadline.
3. Record observation time and evaluation time separately. A degraded predeadline evaluation read after the deadline proves unresolved persisted state, not a new postdeadline evaluation.
4. Keep the historical breach after recovery. Identify manual publications separately from scheduled runs.

## Read retained failure evidence

News stores `lastFailure` in `seed-meta:news:insights`. Stock Connect and corporate disclosures store it on their canonical source rows. Successful publications retain this historical record while current errors and failure counters clear.

The record contains the failure observation clock, the preceding successful clock when known, an error code, and available route and request counts. It excludes raw response bodies, URLs, credentials, and free-text error details. A healthy source can therefore have a historical `lastFailure`.

For corporate SZSE, `REQUEST_BUDGET_EXCEEDED` also records the refused page, direct and proxy request counts, and their limits. Read this evidence before changing request admission. For example, retries of page one can consume the four-request allowance before page two. This sequence does not establish the cause of an older production failure without its receipt.

Corporate validation skips retain the receipt in the existing `seed-meta:market:china-corporate-disclosures-szse-failure` marker. The next source snapshot replays it through the recovery contract.

These are bounded last-failure records, not an archive. A later failure replaces an older one. Canonical expiry, a rejected Stock Connect publication, a process failure before a snapshot is built, or a failed metadata write can leave a gap. Keep existing structured run logs for those cases. Missing fields in older publications mean unknown evidence, not zero requests or successful recovery. Run, deployment, and scheduler identities require separate matched log records.

## Accept a credential rollout

1. Identify every running service that consumes the changed variable. Record the intended nonsecret configuration revision and rollout time.
2. Under separate deployment authority, verify that each affected running deployment adopted that revision. A saved shared variable or successful image build alone is insufficient.
3. Obtain a subsequent scheduled execution receipt bound to that deployment. Record its run ID, source revision, trigger, and actual publication outcome. Do not infer a scheduler trigger from a timestamp.
4. Verify that canonical publication and actual `lastSuccessAt` advanced. For news, compare `servedGeneratedAt` and canonical generation independently from the CN feed projection.
5. Verify a later China evaluation with all 16 launched entries healthy and an advanced actual `lastHealthyAt`. Check decision coverage separately when affected.
6. If the configured revision did not reach the running service, leave rollout acceptance open. If publication failed, preserve its failure evidence and investigate the first failed stage.

Never record the secret value. Use platform configuration revision evidence where available. Do not rotate another key or switch providers to explain a failed rollout.

## Verify aviation omission diagnostics

The aviation producer emits `aviationstack_omission` for empty, missing, non-array, or codeshare-only flight data. The receipt includes the requested airport and date, HTTP status, data shape, counts, and bounded pagination numbers.

1. Verify that the executing deployment contains the omission instrumentation from PR9688.
2. Inspect an existing omission event from that deployment if one occurs. Do not force an omission or probe the provider to create evidence.
3. Match the receipt to its execution and source publication. An event from an unrelated run is not adoption proof for the incident.
4. Accept coverage recovery only from eight valid canonical hub rows, matching bootstrap rows, and a later healthy China evaluation.

A merged diagnostic change does not explain an old CTU response or prove production adoption. If no qualifying event exists, record that observation gap.

## Separate evaluation delay from source failure

The health bundle admits China coverage at its configured interval using canonical and completion evidence. A successful source publication does not directly invoke the evaluator. Record the source recovery clock and subsequent evaluator clock independently.

An off-cycle evaluation can delay admission at the next bundle tick. Before changing this policy, reproduce the proposed admission rule with fixtures and verify its execution bound, completion checks, lock behavior, and incident clocks. Do not widen freshness budgets to conceal this delay.

Run the focused local checks without production credentials:

```sh
node --import tsx --test tests/last-failure.test.mjs tests/seed-insights-freshness.test.mjs tests/china-stock-connect.test.mts tests/china-corporate-disclosures.test.mts tests/china-coverage-health.test.mjs tests/bundle-runner.test.mjs tests/aviation-omission-receipt.test.mjs
```
