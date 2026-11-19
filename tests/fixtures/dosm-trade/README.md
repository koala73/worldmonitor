# DOSM monthly trade fixtures

Captured on 2026-11-17 from the Department of Statistics Malaysia open data
storage. The rows are copied unchanged and trimmed to January–September 2026
for every SITC section:

- `trade_sitc_1d.csv`: from `https://storage.dosm.gov.my/trade/trade_sitc_1d.csv`.
  The full file has 4,851 rows, 1990-01 to 2026-09, for sections 0–9 and `overall`.
- `tradeidx.csv`: from `https://storage.dosm.gov.my/trade/tradeidx.csv`, trimmed
  to 2026-01..2026-08. The full file has 1,540 rows from 2015-01. Its newest
  month is one release behind the trade values.

The catalogue metadata describes trade values as "RM millions", but the values
are whole ringgit. In the full file, the 2024 `overall` rows sum to RM 1,509.3
billion of exports, which matches DOSM's published annual total. Each month's
sections also sum exactly to its `overall` row.

Tests derive malformed, duplicate, missing-section and unit-change cases from
these rows. No live network or Redis snapshot is used.
