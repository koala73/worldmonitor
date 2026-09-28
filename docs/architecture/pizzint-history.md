# PizzINT retained history

The relay stores normalized venue observations separately from the 30-minute live seed. This archive supports an operator report. It does not change the public score, the API, or the browser.

`scripts/shared/pizzint-history.cjs` owns the record schema, validation, atomic write, decode rules, and evaluation. Each provider has one Redis hash per UTC capture date. A field identifies the venue and its UTC ten-minute slot. One Lua call writes a complete poll, keeps the newest capture in a slot, applies a fixed expiry at the UTC bucket end plus 90 days, and rejects a bucket above 4000 fields before it changes data. A poll has at most 24 venues.

The archive stores the provider, the venue ID, capture time, source time, live value, provider forecast, quality, and clock basis. It does not store names, addresses, or provider responses. Quality describes what the provider returned, never what the relay inferred about it: a reading is `missing` only when no usable number arrived, so the scorer's live-index judgements cannot remove observations from the archive. PizzINT cohorts use `recorded_at`. BestTime has no source time, so its cohorts use collection time.

Add `--include-suspect-zeros` to either invocation to fold withheld zero readings back into the baseline.

Run the report against a fixture:

```sh
node scripts/evaluate-pizzint-history.mjs --input fixture.json --as-of 2026-09-28T00:00:00Z --days 90
```

The fixture is a JSON array of expanded observation records. Omit `--input` to read Redis with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Live mode only sends bounded `HGETALL` commands. It allows at most 728000 fields and 745472000 encoded bytes, covering 91 physical buckets for each provider at the 4000-field and 1024-byte record caps. A full report can use substantial memory; it is an operator command, not a serving path.

The report groups records by provider, venue, New York weekday, and New York hour. It excludes unavailable quality, suspect zeros, future data, the current New York date, and records outside the exact read window. It also rejects a PizzINT source time after capture or more than 15 minutes before capture. It deduplicates PizzINT source timestamps. Each date contributes one median. A cohort becomes `ready` after six matching dates. The report then gives the median of date medians and the median absolute deviation. A zero baseline is valid: the archive records a live zero as an observation, so a venue-hour that is genuinely empty can reach a baseline of zero.

A live zero against a provider forecast of at least 20 contradicts the provider's own baseline. `docs/algorithms.mdx` treats that as a dead sensor for the live index, where a false zero would report false calm. The archive does not repeat that judgement destructively: it stores the reading and derives a `suspectZero` flag from the retained live value and forecast. The report withholds those readings from the baseline by default, counts them in `exclusions.suspect_zero` separately from outages, and reports `suspectZeroCount` on each cohort so an operator can see which venue-hours are being suppressed and how heavily. A cohort whose every reading is a suspect zero still appears, with `observationCount` 0.

Pass `--include-suspect-zeros` to fold them in and compare. Nothing is discarded at write time, so the same retained observations answer either policy. That is the point: whether a zero against a busy forecast is a dead sensor or a genuinely empty venue is an empirical question about this dataset, and it stays answerable. Suspect zeros clustered by hour of week suggest the provider's forecast is wrong for that venue-hour; suspect zeros arriving in bursts correlated across venues suggest an upstream outage.

The report describes retained observations. It does not prove that venue activity predicts geopolitical events.

For duplicate PizzINT source times, the report uses the earliest retained capture, with the smaller live value as a deterministic tie-break. Quality is one exclusion category, with clock errors taking precedence over closed, stale, and missing readings. It is not a complete provider-response audit.

Daily hashes were selected over per-venue sorted sets so the reader can discover every retained venue from a bounded date range without a second registry. Each date receives equal weight even if its polling coverage differs. The six-date threshold is a minimum coverage rule, not a statistical confidence guarantee. BestTime collection times cannot establish when its provider sample changed.

The relay starts the archive write alongside live publication and waits for it before allowing the next poll. Archive failures do not prevent live publication. Empty responses and rejected requests do not invent observations. Whole Redis buckets expire at the bucket end plus 90 days; the report enforces the exact 90-day window.

After deployment, the operator should check natural polls for archive failures and run the read-only report. Counts should increase while valid cohorts remain `insufficient_history` until six matching dates exist. Confirm live seed timestamps and expiry still advance normally. If archive failures persist or relay latency regresses, revert the archive integration; existing history expires automatically. No history is backfilled and no public scoring change is activated by this report.

To exercise the atomic write against an isolated Redis instance:

```sh
REDIS_SERVER_BIN=redis-server REDIS_CLI_BIN=redis-cli node --test tests/pizzint-history-redis.test.mjs
```

The test starts its own local server with persistence disabled and stops it afterward. It skips explicitly when the binaries are unavailable.

An expanded fixture record has this shape (a true live zero is valid). `suspectZero` is derived from `live` and `providerForecast` rather than stored, so a fixture does not carry it and the stored record format is unchanged:

```json
[
  {
    "version": 1,
    "provider": "besttime",
    "placeId": "venue-a",
    "capturedAt": "2026-09-21T14:00:00.000Z",
    "sourceRecordedAt": null,
    "live": 0,
    "providerForecast": 10,
    "quality": "available",
    "sourceClock": "collection"
  }
]
```

Writer: `seedPizzint` in `scripts/ais-relay.cjs`. Reader: `scripts/evaluate-pizzint-history.mjs`. Both use the `intelligence:pizzint:history:v1:<provider>:YYYY-MM-DD` namespace through the shared history module. No public health probe or browser consumes these keys.

Each bucket has a `seed-meta:<bucket-key>` entry written by the same Lua operation with the latest capture time and hash record count. It outlives its bucket by seven days so health reports a stale heartbeat rather than losing the heartbeat and the payload in the same instant.

The same operation advances one provider-agnostic heartbeat at `seed-meta:intelligence:pizzint:history:v1` on a rolling seven-day TTL, whichever provider produced the write. That key is what `api/health.js` registers (`pizzintHistory`, `maxStaleMin` 30, matching the live sibling's 3x-interval budget): the daily buckets rotate by UTC date and split by provider, so watching one of those directly would read empty at every UTC midnight and stale whenever the BestTime fallback took over. The label is listed as on-demand, so an archive that has never run does not alarm, while one that has run and stopped reports `STALE_SEED`. Its clock never regresses.

An archive failure logs `[PizzINT] History archive failed:` followed by one of `bounds`, `validation`, `write_rejected`, or `unknown`. The category is fixed vocabulary, never the upstream error text, which can carry the BestTime request URL and its key. `bounds` and `validation` repeat on every poll and need a code change; `write_rejected` can be a single failed round trip. Retries cannot regress the metadata clock, and a capacity refusal leaves both keys unchanged. The operator can inspect these entries independently of live-seed freshness.
