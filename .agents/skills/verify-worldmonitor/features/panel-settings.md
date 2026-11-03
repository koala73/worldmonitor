# Panel settings

The Settings overlay is where a user chooses which panels the dashboard shows. Enabling a panel and saving must put it on the dashboard immediately — without a reload — and the choice must survive the next visit.

## Sub-features

- `settings-open` opens the overlay from the header gear (`#unifiedSettingsBtn`) or the mobile button (`#mobileSettingsBtn`).
- `settings-tabs` switches between Settings, Panels, Sources, API Keys, and (when signed in) Plan & billing.
- `panels-toggle` turns a panel on or off in the Panels tab grid.
- `panels-save` applies the pending toggles to the live dashboard.
- `panels-persist` stores the choice under `worldmonitor-panels`.
- `panels-cap` refuses a toggle that would exceed the free-tier panel cap.

## How to get to it (user POV)

- Choose the gear button in the header, then the `Panels` tab.
- On mobile, choose `#mobileSettingsBtn`, then the `Panels` tab.
- Open the standalone settings window (`settings.html`) in the desktop app.

## Driving it with wm-verify

Preconditions:

- `wm-verify.sh doctor` reports OK.
- The step seeds `worldmonitor-panels` with `threat-timeline` disabled, so enabling it is an observable change.
- The step seeds `wm-pro-key`. This is the product's own legacy tester-session path, not a test-only bypass: without it the `full` variant already sits at the free-tier cap and the modal answers the toggle with a cap toast instead of enabling the panel.

- **Boot disabled.** Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/panel-settings.mjs --name panel-settings`. The step first asserts `#panelsGrid .panel[data-panel="threat-timeline"]` has count `0` while other panels are mounted.
- **Open settings.** Choose the gear. `#unifiedSettingsBtn` click makes the overlay's tablist visible.
- **Panels tab.** Choose `Panels`. `#us-tab-panels` click reveals `#usPanelToggles`.
- **Toggle.** Choose the `threat-timeline` tile. `#usPanelToggles .panel-toggle-item[data-panel="threat-timeline"]` gains the `active` class.
- **Save.** Choose `Save layout`. `.panels-save-layout` click, then `.unified-settings-close`. No reload after this point.
- **Live apply.** `#panelsGrid .panel[data-panel="threat-timeline"]` becomes visible within 30 s.
- **Side effect.** `localStorage['worldmonitor-panels']['threat-timeline'].enabled === true`.
- **Proof.** `01-dashboard-without-panel.png`, `02-settings-panels-tab.png`, `03-panel-live-on-dashboard.png` — the before state, the action, and the result.

## Gotchas

- Enabling a panel without the pro seed silently does nothing on the `full` variant: the free cap is already reached, so the failure looks like a broken save rather than a refusal.
- A disabled panel is parked in `deferredPanelMounts` with no shell at boot. Absence of the selector means "disabled", not "not created yet" — only assert absence after `#panelsGrid .panel` has real entries.
- `seedProfile` guards itself with a `sessionStorage` flag because `addInitScript` re-runs on every navigation; a reload inside the drive would otherwise wipe the very preference under test.
- Use a different panel via `WM_VERIFY_PANEL=<key>`, but pick one that boots disabled in the seed, or the before-assertion fails for the wrong reason.
- The save button is `.panels-save-layout`; closing the overlay without saving discards the toggle.
