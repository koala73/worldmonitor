---
module: source workers
component: TPS and NRCan request diagnostics
problem_type: observability
tags: [tps, nrcan, railway, timeout, http-403]
---

# Diagnose TPS timeouts and NRCan refusals

Search natural worker logs for `source_request_diagnostic`. Existing `tps_source_failure`, seed completion and source-health records retain their meanings. No deadlines, retries, request headers, publication rules or freshness clocks change.

Each event has a unique `requestId`, source, stage, route, zero-based proxy attempt and monotonic `elapsedMs` for that individual operation. TPS emits on errors and HTTP failures only. NRCan emits one record for the direct request and each attempted proxy route, including successful responses, so a recovery can be attributed to a route. These records are diagnostic evidence, not health receipts.

For TPS native Node fetch, `createdMs`, `writeStartedMs`, `sentMs` and `headersMs` record Undici request creation, header-write start on a connected socket, completed request transmission, and receiving response headers. Transmission is a local milestone, not proof of provider receipt. Null means unobserved. `phase` is the last observed milestone. `remoteAddress` and `localPort` permit connection-log correlation. Async-local request identity prevents parallel requests to the same host from sharing timings. All subscriptions are removed when the operation settles.

- `request_created` without `writeStartedMs` locates the stall before request transmission. It does not independently distinguish connection-pool waiting, DNS, TCP or TLS. Allowlisted `errorCode` may distinguish those failures; absent a code, that distinction remains unknown.
- `request_write_started` without `sentMs` means the transport started writing, not that it completed the write.
- `request_sent` without `headersMs` locates the stall after connection establishment and request sending, before response headers. Network response loss and an upstream processing stall still require provider or connection evidence to distinguish.
- `response_headers` with an error locates failure after headers, including body reading or JSON parsing. `errorName` and `errorCode` retain safe native error categories. It is not proof that the body completed.
- For injected fetch implementations and the NRCan custom proxy transport, Undici milestones can be null. A proxy `response_body` failure retains the helper's validated status but leaves `headersMs` null because its header-arrival time was not observed. Proxy `headersMs` is observed only when the existing buffered proxy call returns, so it includes body download and is not a time-to-first-byte measurement.

NRCan response metadata includes status, `server` classified as cloudflare/other, a short allowlisted content type, a format-validated `cfRay`, and a boolean `challenge` from `cf-mitigated: challenge`. A Cloudflare server header alone does not prove which rejection rule fired. `proxyConnect: true` distinguishes a rejected CONNECT tunnel from a proxied HTTP response. A successful proxy response after direct403 identifies which attempt recovered; it does not establish why an earlier exit failed.

Logs exclude request URLs, query strings, request headers, proxy credentials, arbitrary response headers, bodies and error messages. Unknown native error codes and invalid correlation IDs are omitted. The observer does not consume responses or introduce timers/retries. NRCan's direct15s and proxy12s budgets, three proxy attempts and TPS30s request budget are unchanged.

Local tests cover native delayed headers, stalled bodies, parallel request correlation, cleanup, redaction, unchanged return/error identity and adapter retry/timeout contracts. They do not prove either production root cause. New production evidence requires a separately authorized deployment and natural failing runs; do not run seeders manually to generate it.
