# Manual Actions and Authority Gates

No secret belongs in this file, chat transcript, Git history, screenshot or client bundle.

| Priority | User action | Why it is required | System behavior until completed |
|---|---|---|---|
| P0 | Explicitly accept AGPL-3.0-only obligations for the WorldMonitor-derived product and independent branding (not WorldMonitor official branding) | Legal prerequisite for the requested mother integration and public network use | **Completed by direct user confirmation on 2026-08-11.** The on-disk panel was not saved, so the direct message is recorded as the evidence. |
| P0 | Obtain a display/rebroadcast-authorized real-time US market plan and configure `MASSIVE_API_KEY` or equivalent in a local/platform secret store | Required for `REALTIME_LICENSED` minute bars/quotes | UI remains `NOT_CONFIGURED` or uses an honestly labelled non-real-time provider path |
| P0 | Create `AISSTREAM_API_KEY` | Required for live/near-live vessel signals | Maritime entry remains disabled, never filled with random vessels |
| P1 | Configure FINNHUB / Alpha Vantage keys if their plans are suitable | Enables approved fallback quote paths | No claim beyond configured provider contract |
| P1 | Configure a supported AI provider key | Enables batch/deep news analysis | Price data can work; analysis is disabled, heuristic or `INSUFFICIENT_DATA` |
| P1 | Configure Redis and a legal UN Comtrade access path | Required for production cache/health and trade exploration | Local-only cache or disabled trade importer |
| P1 | Export China customs monthly CSV through a lawful user workflow, or obtain approved access | Needed for official regional trade facts | China factory view is limited to other approved facts and explicitly labelled estimates |
| P2 | Contract an appropriate bill-of-lading provider | Required for shipment-level facts | No vessel/box/shipper claim is shown as fact |
| P2 | Configure deployment ownership (Vercel/Railway/Upstash/domain) | Required for production deployment | Local development only |

## Phase 5 completion update (2026-08-11)

The source-linked news contract, US-equity exchange-time alignment, actual
return schema and model-disabled state are complete without a credential. There
is no user action required to continue to Phase 6.

Only when the user elects to enable provider-backed AI/news analysis, first
choose a provider whose terms expressly permit the intended news/financial use
and record its authorization level. Put the resulting server-only secret in the
platform/local secret store named by that provider; do not paste a key, cookie,
invoice, CAPTCHA response, article text requiring restricted redistribution, or
model console screenshot into chat, this file, a checked-in `.env`, an image or
Git. Then run a source/provenance/manual acceptance that records actual model,
prompt, timestamps and returned evidence. This future credential action does
not authorize labelling a model result as a market cause.

## Current pause point

**Current status supersession (2026-08-11):** The historical Phase 1 network-block paragraph below is preserved as evidence only. GitHub HTTPS recovered, the true upstream baseline was fetched locally, and Phase 1 is complete on `integration/pokieticker-maritime-china-factory`. Begin Phase 2 without Provider credentials by implementing contracts and explicitly disabled states only.

**Phase 2 completion update (2026-08-11):** The contract and disabled-state work is complete without requesting, receiving or recording a key. The next capability that requires a user action is a display/rebroadcast-authorized market-data plan and the corresponding server-side secret. Until the user elects to complete that action, the product remains correctly `NOT_CONFIGURED`; Phase 3 can still implement the adapter shell and contract tests without exposing a secret.

**Phase 3 completion update (2026-08-11):** The Massive adapter, server relay,
exchange-calendar handling and disabled-state tests are complete. To perform
licensed-live acceptance, use the official Massive account/plan flow, choose a
plan that expressly permits the intended display and rebroadcast use, store
`MASSIVE_API_KEY` only in the local/platform server secret store, and set
`MASSIVE_REALTIME_DISPLAY_AND_REDISTRIBUTION_CONFIRMED=true` only after that
right is confirmed. Do not paste either value into chat, a checked-in `.env`, a
screenshot or Git. The manual live test must capture the returned provenance and
timestamps for AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META and BABA; it is not a
prerequisite for continuing Phase 4 implementation.

**Phase 4 completion update (2026-08-11):** The native responsive workspace,
provider-only search and empty-chart truthfulness state are complete. The
remaining market action is still limited to the P0 authorized market plan and
server-side secret above; no code, browser layout, component migration or
future Phase 5 adapter work requires the user to reveal a secret. When the user
chooses to perform licensed-live acceptance, first open the official Massive
account/plan and API-key console, choose the display/rebroadcast-permitted
authorization level, put the key only in the server/platform secret store, and
then run the recorded eight-symbol visual/provenance test. Never paste the key,
plan invoice, session cookie or CAPTCHA text into this file, chat or Git.

## Phase 1 implementation update

The GitHub transport block has cleared for the local Phase 1 fetch. The upstream
baseline, isolated branch, visible brand, source notices and Windows production
build are now complete. No Provider action, password, API key, purchase or
deployment ownership is requested at this point: Phase 2 can implement
contracts and disabled states without them.

Phase 0 is complete and its closure evidence is committed on the integration branch. The AGPL and independent-brand gate is satisfied by the user’s direct confirmation. Phase 1 is currently blocked only because this machine cannot establish GitHub HTTPS on port 443, so the official upstream commit cannot be fetched into the local Git object graph. No Provider action, password, API key, purchase, or deployment ownership is being requested for this block.

The only pending cleanup artifact is the Codex-created restoration probe `D:\使用AI专属文件夹\global-intelligence-earth\_codex_phase0_restore_probe_20260811_1640`, containing three copied non-secret representative files. It is outside both projects and is not a user action or a credential request; host policy rejected its scoped PowerShell removal. See `ACCEPTANCE_EVIDENCE.md` for the audit record.

## Phase 6 optional maritime live-data acceptance

No user action is required to continue code work. This section is only needed
when the owner elects to run a provider-backed operational acceptance.

- [ ] Obtain/confirm an AISStream account and plan whose permitted use is suitable for the intended relay/display. AISStream beta availability must not be treated as an SLA.
- [ ] In the relay or platform secret store, set `AISSTREAM_API_KEY`; never put it in a front-end `VITE_*` value, Git, screenshots, this Markdown, or chat.
- [ ] Configure the server-only `WS_RELAY_URL` to the authenticated relay and configure the relay-to-server shared secret in the same protected secret store.
- [ ] Start the relay, choose at least two bounded chokepoint focus boxes, and use the native page’s refresh control. Record Provider identity, query bbox, received/observed time, fetched time, stale/delay status and returned MMSI count.
- [ ] Confirm that every displayed point has a valid MMSI and report time inside the selected bbox; confirm that no cargo, origin, buyer, discharge, ETA, destination, draft or BOL conclusion has appeared.
- [ ] If a PortWatch source is activated, record its actual dataset update cadence and geographic scope separately from AIS. Do not claim minute-level vessel tracking from a PortWatch aggregate.

Never paste credentials, session cookies, payment details, CAPTCHA contents or platform owner tokens into chat or Git. If an external account login, payment, terms acceptance or CAPTCHA is actually required, open the exact official page before asking the user to act.

## Phase 7 optional observed trade and commercial B/L acceptance

No user action is required to continue implementation. The following is needed
only when the owner elects to enable value-bearing data after reviewing its
licence and lawful-use scope.

- [ ] For country-level HS trade, obtain a Comtrade plan/entitlement appropriate for the intended storage and display, then place `COMTRADE_API_KEYS` only in the server or platform secret store. Do not use a `VITE_*` variable, Git, this file, screenshots or chat.
- [ ] If a lawful China Customs aggregate is preferred, document the official/licensed acquisition route, publication/release date, product/HS, period, geographic scope, aggregation method and redistribution permission before server-side ingestion. An aggregate file does not authorize manifest-level claims.
- [ ] Before enabling a potential-port model, document its permitted inputs, method, confidence interval/error bounds and date coverage. It must remain labelled `MODELLED_ESTIMATE`; it does not identify an actual port call.
- [ ] Before enabling B/L records, purchase/accept the commercial provider terms only if the permitted display/rebroadcast use is sufficient. Assign the provider-specific server secret in the protected platform store; record provider, returned timestamp, coverage and licence boundary in the evidence document.
- [ ] Run the native Huidong and Putian filters for at least two periods. Confirm that each number retains its source, period, scope and observed/modelled label, and that no port, vessel, container, cargo or buyer statement appears without its independent authorized record.

Never paste any key, account password, session cookie, invoice, payment detail,
CAPTCHA text or owner token into chat or Git. If login, paid purchase, terms
acceptance, CAPTCHA or deployment ownership is actually needed, the exact
official page must be opened before asking the owner to act.

## Phase 8 optional military and aviation observed-data acceptance

No user action is required to continue code work. These actions apply only if
the owner decides to enable Provider-backed observations after independently
reviewing permissions and terms.

- [ ] For an OpenSky relay, confirm the account/terms and permitted display/cache use, then store `VITE_OPENSKY_RELAY_URL`, `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` only in the desktop vault or server/platform secret store. Do not place them in a `VITE_*` browser bundle, Git, screenshots or chat.
- [ ] For airport/flight operation data, obtain a permitted Aviationstack entitlement before storing `AVIATIONSTACK_API` in the protected desktop/server store. Record Provider, request scope, returned update time, delay/cadence and licence boundary.
- [ ] In the native full layout, expand the collapsed military and aviation entries. Confirm the readiness notice shows the actual configuration state, Provider and freshness condition before enabling a layer.
- [ ] With a provider response, validate each aviation position's source and observation timestamp. Confirm stale, future-dated, blank-source or absent positions produce no `OBSERVED`/`LIVE` badge.

Never paste keys, passwords, OAuth tokens, session cookies, invoices, payment
details or CAPTCHA text into chat or Git. If login, purchase, terms acceptance,
CAPTCHA or deployment ownership is actually required, open the exact official
Provider page before asking the owner to take that irreversible action.

## Phase 9 optional executor activation and self-host operation

No owner action is needed for the completed disabled-state implementation.
These steps are only required before an actual Provider operation can claim a
success, freshness, queue metric, trade record or model result.

- [ ] If operating a self-hosted sidecar, set the **server-only**
  `SELF_HOSTED_MODE=true` and ensure `LOCAL_API_TOKEN` is set by the trusted
  desktop/container launcher. Verify `/api/local-status` through the trusted
  path reports `selfHostedMode: true`, `localAdminAuthRequired: true` and
  `cloudFallback: false`. Never put either value in `VITE_*`, Git, screenshots
  or chat.
- [ ] Bind each actual executor on the server/sidecar only after the relevant
  Provider plan, display/rebroadcast right, licence and storage/retry policy
  are confirmed. A browser button is not an authorization boundary.
- [ ] For stock minute data, record the Provider, returned symbol, exchange
  permission, observed/fetched time, delay and range before enabling a real
  K-line/observed badge. A quote must not repair OHLC.
- [ ] For AIS, PortWatch, Comtrade, Customs or B/L work, record source release,
  contract/permission, geographic/product scope and source timestamp before
  presenting value-bearing records.
- [ ] For news/model jobs, provide model/version/prompt/sample/evaluation
  evidence and inspect queue/dead-letter metrics. Keep news correlation and
  price causality separate.

Never paste a secret, password, OAuth token, session cookie, payment detail,
invoice, CAPTCHA or deployment-owner token into chat or Git. If an account
login, paid entitlement, terms acceptance, CAPTCHA or deployment ownership is
actually necessary, open the exact official page before acting.

## Phase 10 Windows desktop toolchain licence gate (2026-08-11)

The new Tauri 2 launcher, independent desktop brand, PowerShell 5 syntax gate,
secret scan and desktop configuration gate have passed. A **real** Windows
desktop build was then attempted and stopped only because this machine has no
`cargo` executable. GitHub HTTPS is available; this is a local compiler
prerequisite, not a Provider-key or network problem.

Do not paste a key, password, cookie, invoice, CAPTCHA, activation token or
licence text into chat or Git. Before Codex runs either installer, the owner
must explicitly confirm the following two package licences:

- [ ] I authorize installation of **Rustup 1.29.0** from the Rust official
  publisher (`Rustlang.Rustup` via the `winget` source), under the displayed
  **Apache-2.0 OR MIT** licence, so the Tauri build can provide `cargo`.
- [ ] I authorize installation of **Visual Studio Build Tools 2022 17.14.37**
  from Microsoft (`Microsoft.VisualStudio.2022.BuildTools` via `winget`), under
  the displayed **Microsoft proprietary licence**, with the Windows C++ build
  tools required by Tauri's MSVC target.

After the two boxes are explicitly confirmed, Codex will install only those
two official packages, rerun `npm run desktop:tauri:build`, verify the native
executable and installer, then create the new Desktop shortcut. The untouched
legacy launcher remains at
`D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪\scripts\Launch-Global-Intelligence-Earth.ps1`;
it is not a fallback for the new launcher and will not be overwritten.

## Phase 10 delivery receipt and remaining owner actions (2026-08-12)

Both checkboxes above were confirmed by the owner. Rustup, the Visual Studio
C++ workload, the checksum-verified Node runtime, final NSIS installer, native
launcher, desktop shortcut and local loopback sidecar have been installed and
tested. No Provider credential was requested or recorded.

- [ ] If a signed Windows release is required, obtain and control the code-signing certificate and timestamp-service authorization outside chat/Git, then sign the final NSIS/binary in the release pipeline. Current verified status is `NotSigned`.
- [ ] If an MSI rather than the delivered NSIS installer is required, authorize the WiX acquisition/retry in an environment where its download can finish; do not treat the absence of an MSI as a reason to distribute an uninstalled bare executable.
- [ ] Before enabling real/near-real stock charts, obtain a Provider plan that explicitly permits the intended display/rebroadcast use. Store `MASSIVE_API_KEY` or the approved equivalent only in the protected desktop/server secret path; then capture source, symbol, exchange, currency, delay, as-of time and entitlement evidence for every visible bar.
- [ ] Configure AIS/news/trade/model Providers only after their own contracts and terms are accepted. Their missing configuration remains a truthful disabled/degraded state.
- [ ] Do not paste a certificate private key, Provider secret, password, OAuth token, cookie, payment method, invoice or CAPTCHA into chat, screenshots, logs or Git.

## Phase 11 acceptance receipt and remaining owner actions (2026-08-14)

Phase 11 completed its automated acceptance matrix without any new Provider
authorization, billing action, login, CAPTCHA, deployment ownership transfer or
irreversible operation.

- [ ] Keep the market-data action above open until an approved Provider plan,
  protected server/desktop secret and source-bearing bar response have been
  verified. A screenshot baseline must never stand in for that response.
- [ ] If CI requires the Playwright-pinned Chromium rather than the documented
  local Chrome fallback used in the final local visual gate, make the pinned
  browser cache available to that runner. Do not commit a browser binary or
  change product behavior to accommodate test infrastructure.
- [ ] Continue to keep Provider credentials, certificates, sessions, payment
  data and CAPTCHA challenges out of chat, screenshots, test logs and Git.

## Phase 12 publication control receipt (2026-08-14)

The integration branch is the only authorized publication target. The connected
GitHub integration verified owner-fork administrative/push permission, while
the upstream is read-only. The local `gh` session reports unauthenticated and
will not be used to bypass the connected integration.

- [ ] Review the Draft PR after it is created; do not mark it ready, merge it,
  or authorize deployment from this record alone.
- [ ] Keep signing certificates, OAuth sessions, Provider keys, passwords,
  payment data and CAPTCHA material outside chat, Git, screenshots and logs.
- [ ] If a later deployment, release signing, paid Provider activation or
  upstream contribution is desired, explicitly authorize that separate action.

## Phase 12 owner action required - publication transport (2026-08-14)

The local commits and all preflight gates are complete, but the integration
branch cannot yet be transmitted. The GitHub official login page has been
opened in the default browser and the precise local status record is open for
review.

- [ ] Restore an authenticated HTTPS Git path for this machine. After logging
  in outside chat, verify the terminal can run a normal `git push -u origin
  integration/pokieticker-maritime-china-factory`; do not force push.
- [ ] Or configure an existing GitHub-authorized SSH key in the operating
  system and verify `ssh -T git@github.com`. Never paste a private key, PAT,
  password, cookie, OAuth code or CAPTCHA into chat, Git, screenshots or logs.
- [ ] Tell Codex only that the transport is restored. It will re-check the
  remote branch, perform the normal branch-only push if still needed, create a
  Draft PR, record its URL, and leave `main` untouched.

## Phase 12 publication receipt and remaining owner actions (2026-08-14)

- [x] Owner reported GitHub authentication/network restored without sharing a
  credential in chat or Git.
- [x] The named integration branch was pushed with a normal non-force refspec.
- [x] GitHub integration verified the remote commit and created Draft PR
  [#1](https://github.com/daking32168-byte/worldmonitor/pull/1) against the
  unchanged owner-fork `main`.
- [ ] Review the Draft PR and its checks. Do not mark ready, merge, deploy or
  release solely because Phase 12 publication passed.
- [ ] Keep the 519 source-registry `terms-review` entries open until their
  applicable terms, display rights and redistribution rights are reviewed.
- [ ] Keep the company-monitoring public-health claim disabled until an actual
  Railway deployment/health response is recorded.
- [ ] Keep all Provider, code-signing and deployment secrets outside chat, Git,
  screenshots and logs. If a paid plan, terms acceptance, CAPTCHA, deployment
  ownership or signing operation becomes necessary, open the exact official
  action page and treat it as a new authorization gate.

No manual action is required to preserve the truthful no-provider desktop
state. Real-time stock/AIS/news/trade/model acceptance remains separately
blocked on its own licensed source-bearing response, not on GitHub publication.
