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
