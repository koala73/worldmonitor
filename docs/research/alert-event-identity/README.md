# Realtime alert identity and publisher coverage

Keep #10915's exact-headline delivery gate while evaluating semantic matching in shadow. Store publisher coverage across builds separately from the decision to send an alert.

## Replay of the four sightings in issue #10916

| Source | Reached the critical/82 rule? | Exact headline policy | Event-level reference decision |
|---|---|---|---|
| CNN World | Yes | Alert | Alert |
| Sun Online | No | No delivery claim | Add coverage |
| NDTV | No | No delivery claim | Add coverage |
| Egypt Independent | Yes | Suppress repeat | Add coverage, suppress repeat |

All four carry the same underlying report. The incident establishes a coverage gap, but its two differently worded sightings were below the delivery gate. Even a perfect semantic matcher would have removed **zero additional eligible alerts** here after #10915. A headline reporting an official denial of the allegation would be a new development. The four feed names establish carriage, while independent confirmation requires separate evidence.

## Choosing a matcher

Replay the exact key, the digest lexical threshold (0.604), a lower lexical threshold, embeddings within a time window, and an LLM same-development judgment on the nearest eligible candidate. Compare each to labels assigned before inference. Treat uncertain identity as a decision to keep the alert. Include same-place successive strikes, consequence updates, multi-event headlines and syndicated copies. For each policy count eligible sightings kept, correct suppressions, incorrect links, and model calls. Track the anchor for every suppression so repeated mislinks to one missed development can be identified.

Run chronologically, within edition, against retained alerts in a fixed 24-hour window. A suppressed sighting never becomes an anchor. An exact-key match wins first. For semantic matching, rank earlier candidates by similarity. The judge sees the best candidate above the retrieval threshold. Measure retrieval misses separately from wrong judgments and fail open on inference errors. Calibrate on one interval and validate on another. The internal seven-day replay and per-sighting records are available for separate review with the repository owner.

## Proposed delivery and coverage contract

- **Record each sighting at digest ingestion.** Reuse the digest's trusted publisher-family identity (`publisherFamilyForItem`). Persist the union of accepted families under the edition and event ID before selecting the display slice. Count each family once across feeds, builds, and retries. Use the set size as observed publisher coverage. Maintain rolling coverage separately from the score and the existing digest credibility gates. A larger historical count must not silently promote a story to critical. If history is unavailable, describe only the current build's observed coverage.
- **Start with exact identity for persisted coverage.** Keep a stable ID for the first accepted headline, and attach a rewrite only after its match is accepted. Track semantic suggestions separately during shadow evaluation. A failed or ambiguous match leaves stories separate. A late join adds its publisher once, without merging all stories connected by a chain of weak matches.
- **Claim delivery separately from observation.** A high-severity sighting may add coverage now and still allow a later critical sighting to alert. The first eligible sighting claims delivery for its edition and development. Update publisher membership on repeats without sending a second email. A newly confirmed outcome, changed target, or denial gets a fresh development ID and can alert immediately. Preserve existing rule, channel, and edition eligibility. Claim and enqueue atomically, or release the claim on enqueue failure, so concurrent sightings and retry do not lose the first notification.
- **Use a fixed 24-hour delivery window initially.** It covers the nine-hour example and matches the existing exact-key lifetime. Anchor it to the first eligible alert. For coverage, retain sighting times per family and count families seen in the preceding 24 hours as of rendering. Expire inactive events. A frequently repeated headline must never extend suppression indefinitely.
- **Acceptance before enabling suppression.** Shadow-log the proposed anchor, match decision, time, edition, and rule eligibility while ordinary alerts continue. Blind-label a later week, including near misses, multi-event headlines and distinct same-location strikes. Check missed rewrites as well as wrongly suppressed material updates, judge call volume, runtime and timeout behavior. Keep delivery on exact identity if a critical material update is lost. Exercise concurrent first sightings, publisher aliases across builds, a standard-to-critical upgrade, and a new development inside the window. Evaluate the coverage count against actual digest observations including non-queued items.
