# Bounded recovery for malformed market synthesis

An unparseable market-implications completion previously ended synthesis until
the next scheduled job. The panel retained usable cards, but those cards could
cross the freshness threshold while waiting for another attempt. A successful
parent forecast job does not establish market-implications synthesis success.

After a parse miss, recovery requires a positive integer completion count and at
least 512 unused tokens from the original 2,500-token allowance. It makes one
additional call to the responding provider, without transport retries or a
fallback-chain restart. The prompt requests one or two concise cards using the
same world-state context and validation rules. The existing validator rejects
invalid tickers and card fields before publication.

Admission reserves that provider's full timeout plus the existing five-second
guard. Both the original 120-second stage deadline and 200-second run deadline
still apply. Unknown usage, inadequate tokens or inadequate time means no recovery
request. Repeated malformed output or a recovery transport failure retains the
parse-failure classification and last-good cards. A parseable but invalid recovery
records the existing validation failure. One failed synthesis increments the
failure streak once, not once per internal call.

Completion allocation stays at 2,500 tokens across the returned malformed
completion and recovery request. An admitted recovery adds one input-prompt
charge; total spend is not unchanged. There is no additional normal-path request,
model upgrade or new provider. No freshness threshold or schedule changes.

Fixtures cover bounded recovery, repeated parse failure, transport failure,
invalid cards, missing/invalid/exhausted usage, stage and run deadlines, valid
initial responses and fallback suppression. They use synthetic responses, not
production payloads. Existing checks cover market health, cache, budget,
provider routing, telemetry, generic transport and reader registration.

After an authorized deployment, the service owner should observe the next two
natural scheduled runs and a natural parse miss. Search for `llm_market_implications`
with `parseFailure` and `recoveryAdmitted`, then publication or retained failure.
Check actual `generatedAt` and `lastSuccessAt`, validation, failure streaks,
completion allocation, input usage and job duration. A normal successful run does
not prove the recovery branch. If bounds are exceeded or a success clock advances
without validated cards, stop acceptance and revert through the normal authorized
release procedure. Local fixture proof is separate from production acceptance.
