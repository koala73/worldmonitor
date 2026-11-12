---
module: runtime packaging
component: Railway workers and desktop sidecar
problem_type: security_issue
tags: [nodejs, railway, railpack, desktop, docker, security-release]
---

# Node.js November 2026 runtime update

The [November 11 Node.js advisory](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases)
provides fixes in Node 22.23.5, 24.22.3, and 26.13.1. This review inspected
WorldMonitor main commit `f3cebf9fa3949daa51e431bb4767199e9692a7f8`.

## Confirmed packaging gap

| Surface | Before this change | Repair or remaining action |
| --- | --- | --- |
| Railway builds that use `scripts/railpack.json` | Exact pin 24.22.1 | Select 24.22.3. Retain an exact version because Railpack previously resolved ranges below their floor. |
| Desktop release downloader | Default 22.23.4 | Select 22.23.5. Retain the pinned keyring, signature, and archive checksum checks. |
| Node 24 Alpine Docker stages | Digest `8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85` contains 24.22.2 | Pin the verified 24.22.3 Alpine image in every stage. |
| Umami Node 22 Alpine stages | Pinned image contains 22.23.4 on Alpine 3.24 | Await a patched Alpine 3.24 manifest that retains ARM64. |
| Consumer-prices Node 24 slim stage | Pinned image contains 24.22.1 | Pin the verified 24.22.3 slim image. |
| Development and CI | `.nvmrc` and main workflows select major 24 | Fresh resolution can select the patched release. Existing installations and caches still require an update and version check. |

The official Docker registry returned 404 for `24.22.3-alpine`,
`22.23.5-alpine`, and `24.22.3-slim` on November 11, 2026. The mutable
`24-alpine` and `24-slim` tags still contained 24.22.2; `22-alpine` still
contained 22.23.4. Changing to those tags would not install the security fixes.
On November 12, patched image tags became available. The follow-up review
verified their manifest digests and image configurations. This change updates all
Node 24 Docker stages in ten Dockerfiles to the patched image digests:

| Official image | Manifest digest |
| --- | --- |
| `node:24.22.3-alpine` | `sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5` |
| `node:24.22.3-slim` | `sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` |

Dockerfiles retain their existing major-version tags and immutable digest pins.
The table above records the exact security releases represented by those digests.

Umami remains blocked. The patched `node:22.23.5-alpine3.24` manifest
(`sha256:f4081a5ddded4f76ddd2ae8cc37b3d817926871c64b11b8f684be2a588a7792d`)
omits ARM64, which the current Umami digest supports. The patched Alpine 3.23
variant supports ARM64 but would also change the OS release. Retain the existing
Umami digest until the patched Alpine 3.24 manifest includes ARM64, then verify
every platform and update all four Umami stages together.

## Reachability limits

The relay (`scripts/ais-relay.cjs`) and desktop sidecar
(`src-tauri/sidecar/local-api-server.mjs`) create plain HTTP servers and use
outbound HTTPS clients. The inspected application code did not establish a
reachable HTTP/2-server, TLS-server, per-host mTLS, or permission-model exploit
path. The advisory explicitly excludes plain HTTP from CVE-2026-123864.

Outbound HTTPS use alone does not prove CVE-2026-123877: that defect requires
reuse of an HTTPS agent across different CA policies. No such request sequence
was demonstrated. Updating the runtime removes affected core code and bundled
dependencies; it is not evidence of a successful exploit against WorldMonitor.

Vercel, Convex, and active Railway runtime versions were not inspected. Updating
this repository does not update a provider-managed runtime, an existing desktop
installation, or an already deployed container.

## Verification and follow-up

The pin regression rejects 24.22.1. The desktop fixture now exercises the
default version rather than overriding it, and rejects the old default. The
focused tests retain rejection of missing signatures, substituted keyrings,
unknown signing keys, modified signed checksums, and corrupt archives.

The Docker follow-up verified `NODE_VERSION` on every Linux architecture in the
two Node 24 manifests. Both images run as containers with Node 24.22.3, and the
production `runtime-deps` stage builds with the patched Alpine image. The related
suite passed 1,459 tests, with 11 skipped. These checks do not prove a complete
application image build or production rollout.

The Docker follow-up removes the Node 24 image-publication blocker. Umami still
requires the compatible Node 22 image described above. Railway deployment,
desktop publication, installed-version checks, and production acceptance remain
separate steps.
