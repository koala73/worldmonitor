# Realtime alert identity and publisher coverage

#10915's exact-headline gate merges repeats of one headline. Rewrites by other outlets are skipped per user by the check described under Reworded repeats. The owner chose to enable it on 2026-11-18 rather than shadow it for a week first; the acceptance plan below is what its logs are now checked against. Publisher coverage across builds is stored separately from the decision to send an alert.

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
- **Claim delivery separately from observation.** A high-severity sighting may add coverage now and still allow a later critical sighting to alert. The first eligible sighting claims delivery for its edition and development. Update publisher membership on repeats without sending a second email. A newly confirmed outcome, changed target, or denial gets a fresh development ID and can alert immediately. Preserve existing rule, channel, and edition eligibility. Serialize attempts for the same delivery key. A concurrent sighting waits for the enqueue outcome and can take the claim if the first enqueue fails. API webhook fanout keeps its title identity and subscriber-specific filters. A subscriber that rejects the first sighting by keyword can still receive a later title that matches.
- **Use a fixed 24-hour delivery window initially.** It covers the nine-hour example and matches the existing exact-key lifetime. Anchor it to the first eligible alert. For coverage, retain sighting times per family and count families seen in the preceding 24 hours as of rendering. Expire inactive events. A frequently repeated headline must never extend suppression indefinitely.
- **Acceptance (originally a gate before enabling suppression; now a check against the live `[news-alert-rewrite]` logs).** Shadow-log the proposed anchor, match decision, time, edition, and rule eligibility while ordinary alerts continue. Blind-label a later week, including near misses, multi-event headlines and distinct same-location strikes. Check missed rewrites as well as wrongly suppressed material updates, judge call volume, runtime and timeout behavior. Keep delivery on exact identity if a critical material update is lost. Exercise concurrent first sightings, publisher aliases across builds, a standard-to-critical upgrade, and a new development inside the window. Evaluate the coverage count against actual digest observations including non-queued items.

## Runtime behavior

Digest builds write one sorted set for each served headline, keyed by exact headline identity and shared by every edition (`news:publisher-coverage:v2`, #10977), so a family that carries the story in any edition counts in all of them. A headline below every category cap is never served and gets no key. It can still alert: each English build also writes the newest 300 items from the last 6 hours that the category cap kept off the dashboard to `news:alert-pool:v2:<variant>` (30-minute TTL; only headlines in the digest language), and the relay classifies them after the served items. The first pool an edition reads is a backlog: its headlines are recorded in `classify:alert-pool-warm:v3:<variant>` (no expiry) before any is labelled, and they never alert from the pool. Headlines that enter the pool later can alert. After a gap in pool reads (a stale digest, an unreadable revocation set) those can be up to 6 hours old. A pool headline's label is cached per edition (`classify:sebuf:v6:<hash>:pool:<variant>`), so it never takes the shared label an edition that serves the headline needs for its own alert (#10978). Accepted sightings below the cap still add their publisher family to a served headline they repeat. Each trusted publisher family has one last-seen timestamp. Families that carried one copy of the headline (same title and lead, #9095) are written as one member, as in the build's own count, because the relay scores on this history. Each key costs two commands per build (`ZADD GT`, `EXPIRE`); the reader counts only the preceding 24 hours by score, so stale members need no trim.

Different wordings of one incident also count together (#10977). The AIS relay records each critical and high digest headline it labels in `news:story-sightings:v1` (one day, at most 1,000 members), one member per publisher family. The families are the ones the coverage history above holds for that headline, so a topic feed's copy counts under its original publisher; a headline with no history counts under its feed's own family. A critical headline still under the realtime bar is compared by embedding with the last 12 hours of sightings from other publishers. Up to five of the closest wordings (cosine at least 0.6) each go to a separate "same incident?" model check, which treats a second or later attack as a different incident. The families of the matches count toward that headline's score. High headlines only corroborate and are never boosted. At most eight headlines are checked per classify cycle; a spent budget, any error or a 10-second deadline adds nothing. Each boost is logged as `[news-corroboration]` with the wordings it matched, and the alert carries `corroboratedBy`, which the notification relay copies into `shadow:score-log:v5`.

Realtime notifications and quiet-hours summaries read that window when rendering. The digest's own count covers every wording of the story, and the history covers one wording across builds, so the message shows the larger of the two. A missing or unavailable history falls back to the digest count carried by the event. The AIS relay scores each newly classified critical or high headline from a digest feed (not X posts) on the same larger count (#10977), so a lone tier-4 copy that five families carried over the day scores 85 instead of 73.

## Reworded repeats (delivery)

The publisher's story key merges repeats of one headline. Each outlet's own wording is a new headline, so on its own it would alert again. With `OPENROUTER_API_KEY` configured on the notification relay, a reworded repeat is skipped for each user who already had the story:

- Every relay news alert that a realtime rule can deliver (critical, importance 82 or more) and that reached at least one user (delivered on a channel, or held for quiet hours) becomes an anchor for 48 hours, together with the users it reached, each scored by when it last reached them. A receipt older than 48 hours never skips a rewrite. A skipped rewrite reached nobody new, so it never becomes an anchor.
- A later deliverable alert is embedded with the cached embedding client and compared with up to 128 anchors from its edition. The eight closest at cosine 0.60 or more (or, when none reaches 0.60, at 0.45 or more; see Retrieval floor below) go to a language model (`anthropic/claude-sonnet-5.5` through OpenRouter, temperature 0, low reasoning effort, a JSON schema that allows only `{"same": N}`, 1,000 tokens), which answers whether the new headline is about an incident subscribers were already alerted to. It is asked twice at once, and the rewrite is skipped only when both replies name an earlier headline; a `0` or an unreadable reply from either keeps the alert. Each earlier headline is shown with how long ago it alerted. Headlines go in on one line with control characters and braces removed, and a headline longer than 300 characters is never judged, so a cut ending cannot hide its news. Only a reply that is exactly `{"same": N}` (optionally in a code fence) counts.
- It counts as a repeat when the core event matches (same kind of event, same side, same place, about the same time) and the new headline adds only another wording, detail, attribution, updated figures, background, or the routine response such an incident draws (condemnation, "a violation" or "a provocation", jets scrambled, an investigation, an explainer). Any part that reports a separate event or a later day, the incident reaching a country no earlier headline about it named, a confirmation of something earlier called likely or unconfirmed (or a denial or reversal), a consequential response (retaliation, a leader's new threat or vow of retaliation, a formal alliance step, sanctions, an evacuation, a deployment, a declared emergency) or an outcome (a deal, an end of talks, a resignation, an arrest, a named death) is a new development and alerts.
- Users who had the named anchor are skipped. Users it never reached (another rule scope, a newly enabled rule) still get the alert.
- When a rewrite is matched, each wording's publisher history gets the union of both (`ZUNIONSTORE … AGGREGATE MAX` on the two `news:publisher-coverage:v2` keys), so the coverage line of the rewrite, a held summary and any later repeat counts every outlet that carried the story.
- When OpenRouter refuses the judge call (a 402 for an empty account, a 5xx), the same question goes to `claude-sonnet-5-5` on the Anthropic API with the relay's `ANTHROPIC_API_KEY`, with the same JSON schema as structured output. When the embeddings fail, the eight earlier headlines that share the most content words with the new one (the digest's Jaccard tokenizer, any shared word) go to the same judge; see Embedding failures below. Every remaining failure keeps the alert: no key, both judge routes failing, a timeout, an unreadable reply or a Redis error. The relay logs one `[news-alert-rewrite]` record per checked alert: both titles, candidates, how they were retrieved (`retrieval`: `embedding` or `words`, with `embedError` when the embeddings failed), best score (a cosine, or a word overlap for `words`), whether the model was asked and its reply, the anchor it matched, any error, the time taken, and how many users were skipped and reached.
- A rewrite that reached new users (A reached user-1, then B reached user-2) shares its receipts with the anchor it matched, keeping each user's own receipt time. A third wording matched to either A or B skips both users.
- A wrong "repeat" verdict is a missed alert for the users it skips.
- The relay handles one event at a time, so each checked alert waits for the check before delivery. In the 2026-11-21 replay the whole check, two model calls and the embedding, took 2.5 s at the median (p90 4.5 s, max 6.4 s). The anchor read, embeddings (including the embedding cache's Redis calls) and the model call share a 10 s deadline; past it the alert is kept. The recipient read, the coverage merge and the anchor write add at most 1 s each.

Replay of seven days of deliverable alerts (2026-11-11 to 11-18, 73 sightings from `shadow:score-log:v5`, one recipient, the production prompt and model). The prompt was tuned on these same sightings, so the figures are in-sample: 2 exact repeats, 41 or 42 alerts sent and 30 or 29 rewrites skipped across three runs, 40 model calls, no errors. The Crimean Bridge strike went from 14 alerts to 4, and the 15 November drone attack on the US base in Bahrain from 6 to 1. A first prompt also skipped Iran's denial of the dirty-bomb report, a later Myanmar airstrike and the arrival of a third US carrier; the shipped prompt alerts on all three. Two skips remain arguable: a tanker report 17 hours later that adds a drone over an Iraqi gas field (the model's verdict on it changed between runs), and a Crimean Bridge report that adds Russian strikes on Kyiv bridges.

## Judge change after the 2026-11-20 Russia-Poland strike

On 2026-11-20 two Russian Kh-101 missiles and a drone came down in Poland. The owner received 10 alert emails about it in 25 hours. The `[news-alert-rewrite]` logs showed retrieval was not the problem: all 21 deliverable wordings had an earlier Poland anchor above 0.69. The judge (`google/gemini-2.5-flash`, a 20-token reply) called 10 of them new developments. The prompt treated "a reaction", "a new deployment" and "confirmation" as new, and nearly every follow-up headline carried such a clause: Tusk says, NATO jets scrambled, NATO calls it a violation, allied drills nearby. Its verdicts were also inconsistent: "Russia pummels Ukraine with massive strikes, missile hits Poland" was a repeat, while the near-identical CBS headline was not.

The owner decided that a confirmation of something first reported as likely still alerts once. For this incident, that means two alerts: the 09:17 "one likely crossing into Poland" and Tusk's 12:43 confirmation.

**Open-loop comparison.** All 209 judged decisions from 2026-11-18 to 11-21 were rebuilt from the logged anchors; the rebuilt nearest anchor matched the logged one in 209 of 209. 41 of them were hand-labelled, most while reviewing the first candidate's flips, so these figures are in-sample.

| Judge | Developments hidden | Extra alerts |
|---|---|---|
| Gemini 2.5 Flash, old prompt (production) | 2 | 20 |
| Gemini 2.5 Flash, incident prompt | 5 | 1 |
| Gemini 3 Flash, incident prompt | 5 | 0 |
| Claude Haiku 5.5, incident prompt, reasoning off | 3 | 8 |
| Claude Sonnet 5.5, incident prompt, low reasoning, JSON schema | 1 | 1 |

The hidden developments in the cheaper runs were a peace declaration, Putin refusing ceasefire talks, Putin's threat of a "painful response", Iran striking Kuwait and Bahrain inside a Yemen roundup, and Tusk's confirmation. Asking Flash to list each new fact before answering stopped it hiding news, but it then treated words like "deadly" or "successively" as facts and split 42 repeats the old prompt merged. Sonnet's one remaining miss, "Trump delays Iran decision", is arguable. Its reasoning has to stay on: OpenRouter refuses to disable it for this model, and with the old 20-token limit every reply came back length-limited, which the chain discards, so every alert would have been kept.

**Closed-loop replay.** All 341 deliverable sightings in `shadow:score-log:v5` from 2026-11-14 12:23 to 11-21 12:13 were replayed in order per edition through the real `findRewriteAnchor`, with production deadlines. Each judge's own verdicts decided which headlines became anchors. 14 to 18 November is a holdout: it predates the live rewrite check, and its must-alert headlines were labelled from titles before the candidate ran.

| | Old judge | Shipped judge |
|---|---|---|
| Alerts sent (of 341) | 166 | 151 |
| Holdout, 14-18 Nov (of 51) | 27 | 28 |
| Russia-Poland strike | 12 | 3 |
| Crimean Bridge strikes | 10 | 10 |
| Shenzhen summit | 12 | 10 |
| Errors or timeouts | 0 | 0 |

The shipped judge alerted on every labelled development: the first Myanmar airstrike, the Bahrain attack, Tehran's "may strike first" warning, the CNN dirty-bomb report and Iran's denial, the third US carrier, the Qeshm strike, Kuwait under attack, Russia's missile strike on the Kyiv bridges, the Crimean Bridge's partial collapse, the peace declaration, Putin's refusal of ceasefire talks and his threat of retaliation. The old judge skipped the Kyiv bridges, the partial collapse and one wording of the peace declaration. The third Poland alert reports Russia's retaliation for the Kerch bridge attack alongside it. Arguable skips that remain: "Trump delays Iran decision", a second Houthi hit on a Riyadh tower read as the first, and a tanker report near Khasab merged with an earlier tanker attack.

**Two replies.** Run eight times on the Tusk headline, Sonnet called it a repeat once. The check now asks twice at once and skips only when both replies call it a repeat. In the replay, 5 of 247 checks split this way, and each kept its alert. When the replies name different earlier headlines, only users who received both are skipped. Two wordings of one story share recipients, so a third wording still skips everyone; a "likely" report and its separate confirmation do not, so a user who had only one of them still gets the alert. A split also records no match, so neither earlier alert's receipts or publisher counts are merged into the new one.

Cost: about 70 checks a day, two calls each, a few hundred tokens per call.

## Candidate count after the 2026-11-21 Bahrain repeat

After the judge change, 5 of the 13 alerts that reached every subscriber in the next 27 hours still repeated an earlier one. The clearest, "Bahrain says Iran struck industrial site as tankers hit in Hormuz", was put to the judge with three candidates, all tanker headlines (cosine 0.74, 0.74, 0.72). The Bahrain alert it repeats ranked sixth at 0.69 and was never shown, so both replies called the Bahrain half new.

**Replay.** The 222 judged `full` decisions in the `[news-alert-rewrite]` logs from 2026-11-18 to 11-22 were rebuilt from delivered headlines (the rebuilt nearest anchor matched the logged one in 188; the rest differ because sent history carries no edition). Each was put to the shipped judge with three candidates and with eight, same prompt, two replies each.

| | three candidates | eight candidates |
|---|---|---|
| called a repeat | 171 | 184 |
| repeat only here | 1 | 14 |

The 14 are nine wordings of the Shenzhen summit ending and its declaration, the Kyiv missile attack, two Hormuz tanker reports, the Bahrain headline and a live-blog line on the same Bahrain attack. Run four times each, 12 were called a repeat in 4 of 4 runs with eight candidates, one in 3 of 4 and one in 2 of 4; with three candidates, 11 of them were 0 of 4.

What the count does not show:

- **Eight of the 14 named an alert ranked fourth to seventh**, which three candidates never showed. The other six named one of the first three: the judge is also more willing to call a repeat when it sees more of the story's earlier alerts.
- **Nine of the 14 are from 2026-11-19 10:26 to 11:59**, when other-language wordings still alerted (#11043 merged that afternoon). On the 31 decisions made since the judge change, the gain is two: the Bahrain headline and the live-blog line.
- **One hides part of a labelled development.** "Trump, Xi and Putin agree that a nuclear war must never be fought" was matched to "hold first-ever three-way talks" in 3 of 4 runs. The declaration alert nine minutes later ("sign joint declaration towards peace") stayed new, as did the first French wording of it.
- **Two replies naming different earlier alerts**, which skips only users who had both, rose from 1 to 6.
- The one headline only three candidates called a repeat joins an EU-UK deal to the Poland strike. An overnight attack the day after an alerted one stayed new in both.

A reworded prompt with an explicit rule for headlines that join two alerted incidents was tried and dropped: each of three wordings changed about 20 other verdicts, and all three called that overnight attack a repeat.

This is an open-loop replay against the anchors production had; the labelled set from the judge change was not available to rerun.

**Not changed, one alert each in the same 27 hours:** "fresh Iran strikes" on a site alerted 13 hours earlier, which the judge reads as a later strike; and a roundup that repeats the Bahrain attack but adds that Tehran is preparing 14 tankers to run the blockade.

## Window, 24 to 48 hours

An Iranian claim that two tankers hit mines alerted on 2026-11-21 13:39 and again 28 hours later, four hours after its anchor expired. The owner chose a 48-hour window on 2026-11-22. Anchors and each user's receipt now last 48 hours, and up to 128 anchors are read. The publisher-coverage history keeps its 24 hours.

The same 222 decisions were replayed with eight candidates under both windows.

| | 24 hours | 48 hours |
|---|---|---|
| called a repeat | 179 | 186 |
| repeat only here | 1 | 8 |
| named an alert older than 24 hours | 0 | 6 |

Run four times each, two headlines were a repeat in 4 of 4 runs at 48 hours and 0 of 4 at 24 hours because the alert they repeat was older than a day: the "triple-tap" attack on Kryvyi Rih (alerted 38 hours earlier) and "Strait of Hormuz attacks have increased to highest level" (46 hours). Two more flipped the same way against an alert under a day old, where the larger anchor set changed what the judge was shown. The other differences sat within run-to-run variation.

Four headlines that report a later event stayed new in 4 of 4 runs under both windows: an overnight attack the day after an alerted one, Bahrain's second attack the same night, a cargo ship set on fire in the Gulf of Finland, and (not judged, nearest 0.49) NATO's emergency meeting. The prompt gives each earlier headline's age.

The log covers four and a half days, so few stories in it run past 24 hours; this understates the effect on a story that runs for a week. At 48 hours the replayed check took 2.4 s at the median and 6.3 s at the worst with up to 127 anchors embedded.

## OpenRouter outage, 2026-11-23

At 05:46Z the OpenRouter account ran out of credit (`total_usage` 1960.20 of `total_credits` 1960; the key's own $1,000 limit still had $857 left). From then on every judge call returned 402 and every check logged `judge returned nothing`, so each reworded repeat reached all 22 subscribers: among them the Sudan drone strikes at cosine 0.99 to an alert five hours earlier, and "Boy, 7, pulled alive from rubble" at 0.93. Embeddings kept working. The judge now falls back to the Anthropic API (above); a live run of the shipped prompt with the schema on the relay's key answered bare `{"same": N}` in 1.6 to 2.0 s.

The same morning showed a second exact-repeat path. The Korea Herald writes HTML-escaped text inside CDATA (`Sudan&apos;s capital`), and the digest returned CDATA titles without decoding them, so the repeat took a different story key and anchor id from the copy that had already alerted (`sudanaposs` against `sudans`). Titles from CDATA are now entity-decoded like plain ones; 12 of the 5,651 sightings in `shadow:score-log:v5` (2026-11-16 to 11-23) carried an entity, from The Korea Herald, Times of India, Al-Sumaria, Asharq Business and Hospodářské noviny.

## Embedding failures, 2026-11-23 and 11-24

The judge's fallback to the Anthropic API did not cover retrieval: the embeddings come only from OpenRouter, and an embedding error kept the alert without asking the judge. In the `[news-alert-rewrite]` logs from 2026-11-18 07:32 to 11-24 21:44, 59 alerts reached at least five subscribers because the check failed: 15 `judge returned nothing` (before the Anthropic fallback), 42 `EmbeddingProviderError` during the 11-23 outage (about 25 on the Ukrainian sinking of a Russian corvette off Libya), and two on 2026-11-24. Those two, 50 minutes apart, were both wordings of Israel's killing of the Hamas internal security chief in Gaza ("Israel kills Hamas internal security chief in Gaza", "Gaza Internal Security Chief Killed In Israeli Air Strike – Interior Ministry - bernama"). An earlier alert on the same killing had gone out at 13:18, and with working embeddings both score 0.73 and 0.76 against it. The relay recorded only the error's name, so whether those two calls got a 5xx, a 429 or a malformed body is unknown; each took about 2 s, so neither was a timeout. The record now carries the message.

**Fallback.** On any embedding error the earlier headlines are ranked by the Jaccard overlap of their content words (`extractTitleWords` from `brief-dedup-jaccard.mjs`, unchanged) and the eight highest that share at least one word go to the judge. Among the 51 decisions in that log where the judge named an earlier alert that the log's own anchors could rebuild, the named alert was in the word shortlist of eight in 49 and of twelve in all 51. The two misses differ in spelling only (Zelensky and Zelenskyy, 2 and Two). Light stemming did not help (48 of 51).

**Closed-loop replay.** Both failure windows (2026-11-23 05:40 to 09:45, 2026-11-24 19:30 to 21:00, 61 deliverable checks) were replayed in order through the real `findRewriteAnchor` with the embeddings forced to fail and the shipped judge (Sonnet on OpenRouter, two replies), letting each verdict decide which headlines became anchors. Production sent all 61; the replay sent 18, with no errors. Both Gaza wordings were matched to the 13:18 alert. The Libya sinking went to three alerts: the first report, Zelenskyy's confirmation (a confirmation stays new) and one later wording of the confirmation. The Dymer strike and its rising death toll, the Sudan drone strikes and the Poland missile identification became one alert each. Two skips are arguable, and both pairs score above 0.60 with embeddings, so the normal path shows the judge the same pair: an Economist roundup "COP31 collapses; Russian ship hit in Baltic Sea" matched to the Baltic ship, which hides the COP31 collapse (no other alert carried it); and "UN, US condemn Khartoum drone strikes; Sudan renews allegations of attacks launched from Ethiopia" matched to the strikes.

## Retrieval floor, 2026-11-26

The Kyiv-region attack on Dymer of 2026-11-22 reached every subscriber six times. Five of those wordings went out unjudged, because their nearest earlier alert scored 0.53 to 0.58 and the judge only saw pairs at 0.60 or more (issue #11156). The 0.60 floor came from seven days in which every sub-0.60 pair was another story; later data no longer fits that.

**Labelled set.** The `[news-alert-rewrite]` log from 2026-11-18 07:32 to 11-24 21:44 has 90 delivered checks that went unjudged with a nearest score under 0.60. Each was labelled by the earlier alert it repeats, if any, with every earlier alert ranked by cosine. 35 repeat an earlier alert. About a third of those are other-language wordings whose true match scores 0.23 to 0.44 (the Shenzhen summit in Greek, Persian, Korean and Armenian, the Crimean Bridge in German and Slovak); no floor near 0.5 reaches them, and they still alert. The log from 11-25 05:40 to 11-26 00:24 (71 checks) is the holdout. It was listed and its under-floor alerts were read as new stories before any candidate ran.

**Open loop.** Once shown its earlier alert, "Russia fires about 100 missiles at Ukraine, with one likely crossing into Poland" (0.58), which the owner labelled a development in the judge change above, was called a repeat of the mass attack in 13 of 16 replies. The prompt listed no rule for an attack that reaches a new country. With the added line "the incident reaching another country: a strike, missile, drone or attack in, on or crossing into a country that no earlier headline about it named", it was new in 8 of 8.

**Closed loop.** All 657 checks were replayed in order per edition through the real `findRewriteAnchor`, with an in-memory anchor set, embeddings of the logged titles and the shipped judge (two replies). Each arm's verdicts decided which headlines became anchors. Every arm ran twice; no run had an error. The baseline's sends differ from production's 278 because production lost 62 checks to errors (the 11-23 outage) and ran a 24-hour window until 11-22.

| Arm (full edition, 441 deliverable) | Sent, run 1 / run 2 | Holdout sent | Judge calls a day |
|---|---|---|---|
| Shipped: floor 0.60 | 182 / 181 | 23 / 22 | 113 |
| Floor 0.60, new prompt line | 183 / 183 | 20 / 22 | 113 |
| Floor 0.50, new prompt line | 146 / 151 | 20 / 20 | 130 |
| Floor 0.45, new prompt line | 146 / 144 | 21 / 22 | 134 |
| Floor 0.45, shipped prompt | 149 / 150 | 21 / 21 | 134 |
| Floor 0.60, 0.45 when none reaches it, shipped prompt | 154 / 155 | 23 / 22 | 134 |
| **Floor 0.60, 0.45 when none reaches it, new prompt line (shipped)** | **156 / 154** | **20 / 20** | **134** |

What the counts do not show:

- **A flat lower floor hides news above 0.60.** At 0.50 and 0.45, Putin's "painful response" threat (0.67, a development in the judge change above) was hidden in at least one run of each arm, and "EU and UK strike post-Brexit reset deal as Russian missiles hit Poland" (0.67) in both runs. Those checks had candidates above 0.60 either way; the lower floor added weaker wordings of the same story to the list, and the judge then merged. The issue anticipated this (see the candidate count above). With the shipped prompt, the Poland "likely crossing" alert was hidden in both runs too.
- **The fallback gives every check that has a candidate at 0.60 the same list as before.** Only checks that the shipped code never judged get a list, of alerts at 0.45 or more. With the new line, no labelled development was hidden in either run: Poland "likely crossing", Tusk's confirmation, Putin's threat and his refusal of a truce, the peace declaration and the EU-UK deal all alerted. The refusal ("Putin says no sea or energy truce after Ukraine hits Crimea Bridge again", 0.72) was hidden by the shipped baseline in both runs and sent by this arm in both, as an anchor it would have matched was never created.
- **The prompt line alone changes nothing measurable at 0.60.** Its 183 sends against 182 are within run-to-run variation; its differences from the baseline are tanker and summit wordings that flip between runs of either arm.
- **The Dymer thread** (11-22 13:00 to 11-24): production sent 17 wordings to five or more users, the shipped code replayed sends 7, the shipped arm 3: the first report, the Kyiv Oblast supermarket wording and "Ukraine says Russian strikes kill 12 in Kyiv region", which the judge reads as wider than Dymer. The 0.50 fallback sends 4, because "Death toll from Russian attack in Dymer rises to four" scores 0.49 against the first report.
- **Arguable skips in the shipped arm:** a live blog line "Trump, Xi, Putin issue peace declaration; Democrats' Iran war powers resolution fails" matched to the declaration (both runs), "Russia strikes Zelenskyy's hometown as airstrike burns cargo ship" matched to the Kryvyi Rih strike of the night before (one run; the other run sent the later "ballistic missile attack on Zelensky's hometown" instead), and "Houthis say 41 killed as Saudi-led coalition launches 'special operation' in Yemen" (one run). In the holdout, an NHK report of the Riyadh skyscraper hit was matched to the 11-24 hit it most likely reports, and two Hormuz tanker wordings to the report of the same two tankers.
- **Judge load.** About 10 more checks a day are judged, so 21 more calls a day, at about $0.0006 each on OpenRouter. About a third of the newly judged checks are skipped (28 of 89 and 32 of 95).

Not changed: other-language wordings that score under 0.45 against the English alert they repeat. Translating headlines before embedding, or a multilingual embedding model, would be the next step, and it needs its own replay.
