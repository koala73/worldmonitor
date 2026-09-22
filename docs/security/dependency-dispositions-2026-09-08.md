# Dependency advisory dispositions — 2026-09-08

Scope: #7901, existing Rust scanner task #5935, parent #7902.
Source baseline: `8442418e86420df015c1ff9187395c55ad2cacff`.
These are lockfile advisory matches and bounded caller checks, not a source
security scan or a statement about production exploitability. No deployment,
customer-data operation, migration or live exploit was performed.

## Evidence

All seven npm queries completed on isolated manifest/lockfile copies with
`npm audit --package-lock-only --ignore-scripts --json` (Node 24.20.0,
npm 11.19.0). The pnpm query used `pnpm audit --json` 11.25.0 on a copy
of `docker/umami/runtime`; the Docker image itself pins pnpm 10.15.1.
No lifecycle scripts ran during these queries. GitHub advisory metadata was
refreshed on September 8, including first patched versions rather than merely
npm's `fixAvailable` suggestion. Raw reports, command exits, timestamps and
metadata remain in the local acceptance evidence for #7902.

| Lockfile | Moderate | High | Other | Exit |
| --- | ---: | ---: | --- | ---: |
| `package-lock.json` | 14 | 13 | none | 1 |
| `scripts/package-lock.json` | 2 | 0 | none | 1 |
| `consumer-prices-core/package-lock.json` | 0 | 0 | none | 0 |
| `blog-site/package-lock.json` | 1 | 0 | none | 1 |
| `pro-test/package-lock.json` | 13 | 4 | none | 1 |
| `docker/runtime-package-lock.json` | 0 | 0 | none | 0 |
| `workers/railway-reconcile-control/package-lock.json` | 0 | 0 | none | 0 |
| `docker/umami/runtime/pnpm-lock.yaml` | 7 | 6 | 1 low | 1 |

npm counts affected package entries, including transitive and development
packages. The seven npm reports contain seven distinct advisory IDs. The pnpm
report contains 14 advisory records. Exit 1 with valid metadata is a match,
not a database failure. Container-image and upstream Umami build-tree coverage
are outside these lockfile results.

## npm decisions

Owner for every row: **#7901 / dependency maintainers**. Re-review by
**2026-10-08**, or sooner if the caller, build entrypoint or advisory changes.
These dispositions do not add npm suppressions. The existing image-size leases
from #6331 remain visible in the production audit script and expire November 5;
this investigation uses the earlier October review date.

| Advisory | Installed path and API evidence | Patch and disposition |
| --- | --- | --- |
| [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | Root `node_modules/image-size` 1.2.1 under Metro; root `node_modules/texture-compressor/node_modules/image-size` 0.7.5 under deck.gl → loaders.gl textures; pro-test `node_modules/image-size` 1.2.1 under Metro. Metro `src/Assets.js` and texture-compressor `lib/utilities.ts` own the image parser calls. The application uses Vite web builds, not Metro, and does not invoke the texture-compressor CLI. | Two DoS-only families. GitHub still reports no patched version through 2.0.2. Retain the existing bounded decisions: no untrusted-image path was identified through these callers. Do not downgrade deck.gl to npm's suggested 8.6.5. This is caller evidence, not a new built-bundle attestation. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | Root and pro-test `node_modules/stream-json` 1.9.1 via Clerk/Solana → `@solana/web3.js` → jayson. Jayson's `lib/utils.js` imports `StreamValues` and `Verifier`; its `parseStream` uses those APIs, not the affected pick/ignore/filter/replace filters. | DoS-only; patched in 3.5.0. Reject applicability to the inspected caller. A forced 1.x → 3.x transitive override is not justified; npm's Clerk downgrade does not establish compatibility or an appropriate repair. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | Root/scripts/pro-test `node_modules/uuid` 8.3.2; pro-test also has `node_modules/rpc-websockets/node_modules/uuid` 11.1.0. ExcelJS's conditional-format writer and Jayson's request-ID helpers call v4 without a buffer; rpc-websockets calls v1 for socket IDs. The affected v3/v5/v6 buffer APIs are different. | Patched lines: 11.1.1, 12.0.1 and 13.0.1. Reject applicability to those inspected calls. Do not downgrade ExcelJS to 3.4.0 or Clerk to alter the match count. Retain the compatible parent versions. |
| [GHSA-f48w-9m4c-m7f5](https://github.com/advisories/GHSA-f48w-9m4c-m7f5) | Blog `node_modules/astro` 6.4.8. `astro.config.mjs` selects static output; inspected Astro templates do not spread attacker-selected attribute names into an HTML element. Content and template changes enter through repository review/build. | Patched in 7.0.6. No matching attacker-controlled attribute-name path identified. Retain 6.x pending a separately verified Astro 7 migration; static output alone is not proof against build-time content injection. |
| [GHSA-7pw4-f3q4-r2p2](https://github.com/advisories/GHSA-7pw4-f3q4-r2p2) | Same Astro copy; no hydrated `client:*` islands or `transition:*` directives in the inspected blog templates. | Patched in 7.0.4. Reject the required hydrated-island transition path in the current templates. Re-review if those features are introduced. |
| [GHSA-4g3v-8h47-v7g6](https://github.com/advisories/GHSA-4g3v-8h47-v7g6) | Same Astro copy; no ClientRouter/ViewTransitions import or dynamic transition animation directive in the inspected blog templates. CSS `transition:` declarations are not Astro directives. | Patched in 7.1.0. Reject the required transition-animation input path in the current templates. A major upgrade is not required to repair a demonstrated caller defect here. |

Babel GHSA-4x5r-pxfx-6jf8, PostCSS GHSA-fxqj-rqcc-2cmp and shell-quote
GHSA-395f-4hp3-45gv no longer appear in these fresh results after merged #7912.
That is dependency evidence, not a blanket file-read or parser safety claim.

## Vendored Umami pnpm decisions

All matches are under `prisma` 7.8.0. The checked runtime manifest and
`Dockerfile.umami` pin the packages and copy upstream commit
`2f6e2b5ff256862a081d9e74bed18a42ebf795e3` startup code. Upstream
`start-docker` runs `check-db`, `update-tracker`, then `server.js`.
`check-db.js` uses `PrismaPg` and can execute `prisma migrate deploy`.
Thus Prisma is used during startup; calling it only a devDependency would be wrong.
The image does not start `prisma dev`. No real migration was run here.

Owner: **#7901 / Umami image maintainers**; re-review **2026-10-08**.
Retain these versions for now with the following bounded dispositions. No pnpm
ignore list was added, and no clean pnpm result is claimed. A future image
change must verify its migration and startup behavior before deployment.

| Installed package/path under prisma | Advisory IDs and first patched release | Disposition |
| --- | --- | --- |
| `@prisma/dev > @hono/node-server` 1.19.11 | GHSA-92pp-h63x-v22m: 1.19.13; GHSA-frvp-7c67-39w9: 1.19.15 on the 1.x line | Static-server middleware/path handling requires the Prisma development server, which the checked startup command does not launch. The Windows-specific path issue also differs from this Linux image. |
| `@prisma/dev > hono` 4.12.33 | GHSA-8j4g-w8fx-2239, GHSA-f23p-vx2j-j53r, GHSA-79qm-7rj5-m7r9, GHSA-54fx-42gc-7vw4: 4.12.34 | CORS/language DoS, SSR memo retention and proxy-header handling concern Hono server helpers. No Prisma dev listener exists in the checked startup path. Package inclusion is not proof these handlers receive HTTP requests. |
| `@prisma/dev > valibot` 1.2.0 | GHSA-5qjj-4xww-7phc: 1.4.2 | The reported record/flatten error path is under Prisma dev. No public request path to that API was identified from this startup contract. |
| `@prisma/config > deepmerge-ts` 7.1.5 | GHSA-ggr8-5vv4-36mx: 8.0.0 | Prisma configuration can run at migration startup, but the config is repository/image-controlled. Recursive object graphs from a public request were not established. Do not impose an unverified major transitive override. |
| `mysql2` 3.15.3 | GHSA-3f6p-5ww8-9rcr: 3.22.0; GHSA-rgwj-5xj2-c3m3: 3.23.1 | Auth-plugin downgrade and compressed-protocol parsing require a MySQL connection. The checked Umami startup uses PostgreSQL/PrismaPg. No MySQL connection path was identified. |
| `@prisma/dev > @prisma/streams-local > ajv > fast-uri` 3.1.5 | GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp: 3.1.6 on the 3.x line | URI normalization advisories remain reported. This path belongs to Prisma dev/streams-local, not the selected PostgreSQL migration command. Runtime behavior of an already-deployed image remains unverified. |

These are source/entrypoint-limited dispositions. They do not attest to the
upstream standalone server's complete dependency graph or production configuration.
Advisory details are available at `https://github.com/advisories/<ID>`.

## Rust repair and scanner contract

Cargo-audit **0.22.2** queried all **525** Cargo.lock package entries with no
OS/architecture filter. The initial RustSec database revision was
`bf25f6575a93a35f30796c65c0ed91bee7fa19fd` (1,242 advisories).
Yanked-package checks are explicitly excluded with `--no-yanked`; this is an
advisory gate, not a crates.io yanking check.

- RUSTSEC-2026-0194 and RUSTSEC-2026-0195: quick-xml 0.38.4 → 0.41.0,
  through compatible plist 1.8.0 → 1.10.0. The old plist XML reader uses plain
  `Reader`, not `NsReader`; this limits the namespace-allocation hypothesis.
  The compatible update removes both matches without a speculative exploit claim.
- RUSTSEC-2026-0190: anyhow 1.0.102 → 1.0.103.
- RUSTSEC-2026-0221: event-listener 5.4.1 → 5.4.2.
- RUSTSEC-2024-0429: glib 0.18.5 remains. Its patched 0.20 line is not a
  compatible substitute for Tauri/Wry's GTK 0.18 API. The user-approved temporary
  decision is recorded in `.github/rust-advisory-decisions.json`, with owner,
  limiting caller evidence, mitigation, explicit Linux runtime uncertainty and October 8 expiry.
  The user explicitly approved this exception on **2026-09-08**, after being told
  it permits CI to pass while the advisory remains unresolved and runtime
  non-reachability is unproven. Its status is **approved**: the gate reports a
  visible warning for this advisory until **2026-10-08 00:00 UTC**, when the
  existing expiry check fails. The approval applies only to this temporary glib
  exception, not other risk, merge or deployment. Desktop maintainers must
  re-review the mitigation and coordinated GTK migration/backport before expiry.
  `cargo tree --locked --target x86_64-unknown-linux-gnu -i glib` confirms
  Tauri 2.11.5 / tauri-runtime-wry 2.11.4 / Wry 0.55.1 → GTK 0.18.2 →
  glib 0.18.5 (with sibling GIO/WebKit paths). GTK declares glib `0.18`;
  Wry declares GTK `0.18`. Fresh dry runs of `cargo update -p glib` and
  `cargo update -p gtk -p wry -p tauri` both selected zero compatible updates.
  No speculative fork or major override was introduced.
- Six unmaintained-crate notices remain: proc-macro-error 1.0.4, and
  unic-char-property, unic-char-range, unic-common, unic-ucd-ident and
  unic-ucd-version 0.9.0. They stay visible as maintenance warnings owned by
  desktop maintainers; no patched versions are listed in those notices.

The existing Security Audit workflow now runs the Rust gate on every PR, main
push and daily sweep, including days with no Cargo changes. The separate floor
check continues to prevent regression of explicit minimum-version decisions.

| Result | PR gate | Daily sweep |
| --- | --- | --- |
| Fixable advisory without a live approved decision | Fail | Fail |
| No patched version | Explicit warning, distinct from clean | Explicit warning |
| Proposed exception | Fail for a fixable advisory; proposal remains visible | Fail |
| Approved decision with approver/date | Visible warning with owner/reason/expiry | Visible warning |
| Expired, malformed, duplicated or stale decision | Fail | Fail |
| RustSec database fetch unavailable | Explicitly unaudited warning | Fail |
| Missing/malformed input, tool or report | Fail | Fail |
| No findings and no notices | Clean | Clean |

Memory-unsoundness advisories in RustSec's `warnings` object follow the same
fixable/no-fix rules as its vulnerability list. The gate never treats the word
"warning" as proof that an advisory is non-actionable. A fresh database and neutral
working directory prevent local ignore configuration or a stale cache from
silently suppressing results.

Verification includes the real Cargo advisory runner, locked compilation of
changed dependencies, floor/baseline checks, synthetic report/error cases and
execution of the actual aggregate shell across verdicts. Local proof, CI,
merge, desktop release and deployed-image acceptance remain separate states.
