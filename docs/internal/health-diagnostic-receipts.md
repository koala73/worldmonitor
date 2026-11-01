# Health diagnostic receipts

## Scheduled regional energy feeds

Regional energy feeds now have a first-publication window. Production health claims a persistent deadline once per data key version, using the existing acquisition budget capped at 24 hours. Preview checks cannot start it. Repeated checks and deployments cannot renew it. After the deadline, missing data is `EMPTY`, even if the activation marker never appeared. A failed deadline read grants no grace.

The regional workers opt into an initial fetch-failure receipt. `SET NX` prevents that receipt from replacing existing metadata or moving a last-good acquisition clock. The receipt contains the run ID, failure time and error state, without a fabricated success timestamp. A normal successful publication replaces it. Until these changes are deployed, existing production behavior is unchanged.

## Request evidence

CSL and GTFS fetches use the existing source-request observer. It preserves nested transport error codes and safe response diagnostics. GTFS wraps the fetch phase; it does not claim body parsing timings. Existing request deadlines and returned error contracts remain unchanged. Successful shared seeder receipts include the run ID, canonical key, acquisition clock when available, and original content clocks for content-age-aware seeders.
