# FIRMS UTC rollover fixture

Four unchanged rows sampled from NASA FIRMS Area API on 2026-09-07 at 02:41:39 UTC.
Source `VIIRS_SNPP_NRT`, existing Ukraine bounds `22,44,40,53`, day range `2`.
The response was HTTP 200 with 412 observations, all dated 2026-09-06.
The same bounds and source with day range `1` at 02:41:32 UTC returned HTTP 200 and only the CSV header.
The credential is omitted. No seeder was run and no production data was changed.

Rows are positions 0, 100, 300 and 411 after stable sorting by acquisition time.
The fixture preserves the original coordinates, times and measurements.
At 02:41 UTC, its 00:01 and 00:03 observations are over 24 hours old; the 11:30 and 23:44 rows remain in the rolling window.

[NASA Area API documentation](https://firms.modaps.eosdis.nasa.gov/api/area/) defines the undated range as today through today minus (day range minus one).
Two calendar days plus acquisition-time filtering are required for rolling 24-hour coverage.
