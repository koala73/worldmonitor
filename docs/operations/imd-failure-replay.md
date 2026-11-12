# Replay a failed IMD acquisition

The worker can retain the inputs it already acquired when a bulletin fails or
needs its PDF fallback. This supplies evidence for a parser repair. It does not
repair missing source content or renew expired records.

Capture is disabled by default. After an approved deployment, an operator can set
`IMD_FAILURE_EVIDENCE_DIR` to a private, writable directory on an existing persistent
mount. A container-local directory is ephemeral and may disappear when the job
exits. Provisioning a mount and enabling capture require separate approval.
Do not run a manual seeder to populate evidence. Wait for a natural scheduled run.

Each registered page has one latest `<page-key>.json` bundle. A subsequent failure
replaces it atomically. Preserve the first failure outside this directory before
it is replaced if the incident requires that exact input. The adapter creates
files with mode `0600` and creates a new directory with mode `0700`. An existing
directory must already be private. Bundles can contain public source bodies and
prior canonical records. Do not publish them in logs or PRs without inspection.

There are nine registered pages. Each bundle is limited to 4 MiB. Each response
keeps the existing 512 KiB acquisition limit. PDF text is retained only within the
existing 64,000-character parser bound. One temporary file per page supports atomic
replacement. Files older than 24 hours are removed at the next enabled run,
including temporary files from interrupted writes. This is scheduled cleanup,
not deletion while the worker is stopped. A busy temporary file blocks that page's
capture until cleanup; it cannot corrupt the prior complete bundle.

The bundle records the page, acquisition time, prior snapshot, primary and fallback
outcome, response status/content type, complete body bytes in base64, and PDF text
when extraction completed within its limit. No request headers, credentials or
arbitrary error messages are captured. Error response bodies, oversized bodies and
bodies not reached by the original fetch path are not additionally fetched or read.
A null body explicitly means it was not retained. Oversized/incomplete successful
responses cannot be replayed. Capture errors emit only
`imd-cyclone-marine: failure evidence unavailable` and do not change publication.

The `imd_failure_evidence` log event contains a capture ID and `runStartedAtMs`,
which comes from the seed runner. The bundle includes Node version, parser source
and worker `scripts/package-lock.json` SHA-256 fingerprints, and `RAILWAY_GIT_COMMIT_SHA` when available.
The commit may be null; a successful merge alone does not identify deployed code.

Copy the private bundle to a local checkout of the captured revision, use its
Node version and locked dependencies, and run:

```sh
node scripts/replay-imd-failure.mjs /private/path/kerala-karnataka-lakshadweep.json
```

Replay uses only recorded responses through an injected fetch implementation.
It does not load environment files, call the provider, publish to Redis, or seed
anything. It outputs the page parse result, assembled page health and records at
the original acquisition time using the retained previous snapshot. It does not
claim parity for other pages. A runtime mismatch fails by default. To compare a
candidate parser repair explicitly, use `--allow-revision-mismatch`; the output
then reports `runtimeMatches: false`.

First reproduce the failure. Inspect HTML, PDF bytes and extracted text to find
where the required content disappeared. If the source contains valid content,
add that inspected fixture to the parser regression suite and repair the first
incorrect extraction or parsing step. If the source itself lacks required data,
retain that conclusion rather than weakening completeness or expiry validation.

After approved activation, check one natural failure for an `imd_failure_evidence`
receipt and a readable bundle. Confirm canonical records, source clocks, carry,
request count and expiry behavior are unchanged. Failure signals are missing
receipts, unreadable bundles, repeated capture errors or unexpected canonical
changes. Disable the optional directory setting if capture interferes with the
worker. This PR does not deploy, enable capture, or prove Kerala production recovery.
