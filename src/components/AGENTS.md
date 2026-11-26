# src/components

Applies to dashboard UI under `src/components/`. Root `AGENTS.md` still applies.

- Panels extend `Panel` (`Panel.ts`), implement `fetchData()`, and render through `setSafeContent` (or `setSafeContentImmediate` for an immediate user action), `setContentNodes`, or `setTrustedContent`. `setContentHtml` is private to `Panel`. On failure call `showError(msg, retry)`. Keep a private `_hasData` guard so a failed retry never replaces good data with an error.
- Register new panels in `src/config/panels.ts` (`FULL_PANELS`, `FINANCE_PANELS`, and the other variant maps) and in `src/app/panel-layout.ts`.
- For UI copy, help, and recovery flows, follow the design context in [`.impeccable.md`](../../.impeccable.md): dense utilitarian dashboard, direct and precise tone, lead with the exact action a blocked user should take, never ask users to share a full secret.
- UI changes need screenshots in the PR description (root `AGENTS.md`) and a check with the `verify-worldmonitor` skill.
