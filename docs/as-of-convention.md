# Historical observation convention

History-backed MCP tools use `as_of` to request the latest stored observation at or before a UTC time. No tool exposes this parameter yet. Omitting it preserves each tool's current behavior.

## Input and matching

`as_of` is a string with JSON Schema `format: date-time`. The initial helper accepts UTC timestamps ending in `Z`, with seconds and optional millisecond precision. It rejects invalid dates and future requests.

`resolveAsOf(observations, asOf, { granularity, now? })` lives in `server/_shared/as-of.ts`. Each observation has `observed_at` and an optional `formulaVersion`. Observation times must be unique; duplicate instants are store configuration errors. The helper returns the latest observation whose `observed_at` is less than or equal to the requested time. Input order does not matter. It does not interpolate or return a later observation.

`granularity` is the store's observation interval in milliseconds, anchored at the Unix epoch. Observations must align with that interval. For irregular timestamps, use the finest stored precision, such as 1 millisecond. The helper returns `cacheAsOf`, which floors the request to that interval. Callers use it before constructing a cache key, never the raw caller timestamp. Cached observations can be shared within that interval. Rebuild the request-specific envelope after a cache hit.

## Response envelope

Historical reads return an `asOf` object alongside the matched data:

```json
{
  "asOf": {
    "requested": "2026-10-17T13:30:00Z",
    "matchedObservedAt": "2026-10-17T12:00:00Z",
    "matchOffsetSeconds": 5400,
    "formulaVersion": "v1"
  }
}
```

`matchOffsetSeconds` is the requested time minus the observed time, in seconds. It is nonnegative and can include a fractional second. Historical reads omit the current-data `stale` flag. The offset replaces that freshness calculation. They retain source provenance and availability information.

When a stored formula version differs from the current formula, return the stored version. Do not combine observations across formula versions. The helper carries any stored `formulaVersion` into the envelope.

## Errors

Historical input errors use JSON-RPC code `-32602` and `error.data.reason`:

| Reason | Meaning | Extra data |
| --- | --- | --- |
| `invalid_as_of` | The timestamp is invalid or does not use the supported UTC format. | None. |
| `as_of_in_future` | The request is later than the current time, before any cache flooring. | None. |
| `before_history_start` | The request predates the earliest stored observation, or the store has no observations. | `historyStart`, the earliest observation time, or null for an empty store. |
| `beyond_entitlement_depth` | The observation exists but falls outside the account's allowed history depth. | The adopting tool documents its tier-depth boundary. |

The helper throws `AsOfError` with `code` and `data` for the first three reasons. A future MCP adapter must map those properties to the JSON-RPC error envelope. Invalid stored timestamps and invalid granularity are store configuration errors, not caller errors.

The adopting tool enforces the 7, 90, or 365-day tier depth from [#4276](https://github.com/koala73/worldmonitor/issues/4276). It must distinguish the store's actual history start from the entitlement boundary. Do not pass an entitlement-truncated list to the helper and report its first row as the store's history start.

## Adoption requirements

A tool adopts `as_of` only after it has a history store, a documented observation shape, health registration, and a registry flag naming its history key. A historical seeded-cache read stays weight 1.

The first intended adopter is `get_forecast_predictions`. Its existing `forecast:predictions:history:v1` list needs health registration and documentation that each run stores only the top 25 forecasts. Next is `get_country_risk`, after the daily snapshots in #4276 exist. Lake-backed adoption follows the history API in [#9081](https://github.com/koala73/worldmonitor/issues/9081).

`get_prediction_markets` needs a separate market history store before adoption. This change adds no store, registry flag, or tool input. Venue redistribution terms must be confirmed before storing and serving historical prices.
