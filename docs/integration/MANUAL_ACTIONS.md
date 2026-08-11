# Manual Actions and Authority Gates

No secret belongs in this file, chat transcript, Git history, screenshot or client bundle.

| Priority | User action | Why it is required | System behavior until completed |
|---|---|---|---|
| P0 | Explicitly accept AGPL-3.0-only obligations for the WorldMonitor-derived product and independent branding (not WorldMonitor official branding) | Legal prerequisite for the requested mother integration and public network use | Work stops after Phase 0; no upstream merge or formal integration branch is pushed |
| P0 | Obtain a display/rebroadcast-authorized real-time US market plan and configure `MASSIVE_API_KEY` or equivalent in a local/platform secret store | Required for `REALTIME_LICENSED` minute bars/quotes | UI remains `NOT_CONFIGURED` or uses an honestly labelled non-real-time provider path |
| P0 | Create `AISSTREAM_API_KEY` | Required for live/near-live vessel signals | Maritime entry remains disabled, never filled with random vessels |
| P1 | Configure FINNHUB / Alpha Vantage keys if their plans are suitable | Enables approved fallback quote paths | No claim beyond configured provider contract |
| P1 | Configure a supported AI provider key | Enables batch/deep news analysis | Price data can work; analysis is disabled, heuristic or `INSUFFICIENT_DATA` |
| P1 | Configure Redis and a legal UN Comtrade access path | Required for production cache/health and trade exploration | Local-only cache or disabled trade importer |
| P1 | Export China customs monthly CSV through a lawful user workflow, or obtain approved access | Needed for official regional trade facts | China factory view is limited to other approved facts and explicitly labelled estimates |
| P2 | Contract an appropriate bill-of-lading provider | Required for shipment-level facts | No vessel/box/shipper claim is shown as fact |
| P2 | Configure deployment ownership (Vercel/Railway/Upstash/domain) | Required for production deployment | Local development only |

## Current pause point

Phase 0 is complete and its closure evidence is committed on the integration branch. The current required action is to review the visibly opened `用户确认与账号操作面板.md` and set its first two confirmations to `我确认`. The first required user confirmation before Phase 1 remains the explicit AGPL-3.0-only and independent-brand acceptance above.

The only pending cleanup artifact is the Codex-created restoration probe `D:\使用AI专属文件夹\global-intelligence-earth\_codex_phase0_restore_probe_20260811_1640`, containing three copied non-secret representative files. It is outside both projects and is not a user action or a credential request; host policy rejected its scoped PowerShell removal. See `ACCEPTANCE_EVIDENCE.md` for the audit record.
