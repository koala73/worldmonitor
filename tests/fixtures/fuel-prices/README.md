# Fuel-price fixtures

Captured from public upstream responses on 2026-11-05, without credentials:

- `ssb-09654.json`: Statistics Norway PxWeb table 09654, POST JSON with petroleum products `031`/`035`, contents `Priser`, last three months, response format `json`.
- `gasvaktin-stations.json`: excerpt (first three stations) from Gasvaktin `vaktin/gas.min.json`. MIT licence, copyright Gasvaktin; credit Gasvaktin and its contributors. `gasvaktin-revision.json` retains the SHA and committer timestamp of that file's latest revision. The full file has no observation timestamp.
- `taiwan-oil111-92.json` and `taiwan-oil111-diesel.json`: Taiwan MOEA Energy Administration `oil111/Gasoline/CountyCityAvg/load`, multipart POST `unit=week`, `oil=01` or `04`, `start=lastone`. Public government survey; reuse licence unconfirmed. Source responses retain county rows and group report counts so weighting is inspectable.

Tests freeze time at 2026-11-05. Prices, observation dates and response fields
are source values; malformed, stale and missing data cases are created in tests.
