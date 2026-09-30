---
title: "The Settings discard confirm rendered behind Settings, so Close went dead and the tab wedged"
date: 2026-09-30
category: ui-bugs
module: src/components/confirm-dialog.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Clicking Close on Settings after toggling a panel (without Save) does nothing, and repeated clicks do nothing either"
  - "Sentry WORLDMONITOR-15Z `[stale-bundle] reload still deferred, modal never closed` with `blocked_by: modal-overlay`, `reload_policy: blocking`"
  - "15Z event breadcrumbs show `ui.click button.modal-close.unified-settings-close` several times in a row with Settings still on screen"
  - "Every e2e test of the confirm stayed green: they asserted `toHaveCount(1)` / `toHaveClass(/active/)` and dismissed it with Escape"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [z-index, stacking-context, confirm-dialog, unified-settings, modal-overlay, stale-bundle, reload-wedge, playwright-hit-test, element-from-point]
---

## Problem

`confirmDialog()` appends its overlay to `<body>`. Its only caller is `UnifiedSettings.close()`, which opens it when the Panels tab has unsaved changes. The overlay's CSS put it at `z-index: 4000`, below Settings' `.modal-overlay`, which is at `9999` with an opaque `background: var(--bg)`. The confirm was therefore created, focused, and invisible. Fixed in PR #8756.

## Symptoms

- The user clicks Close and nothing appears to happen. `close()` sets `confirmingClose` and returns, so every later Close click also returns early, because a confirm is already pending. Escape still works, since the confirm listens for keydown in the capture phase, but nothing on screen tells the user that.
- Settings is declared `blocking` for the reload guard, so a user who gives up and walks away leaves a tab that defers every stale-bundle reload. After #8663 removed the SignalModal cause, this was the remaining shape of WORLDMONITOR-15Z: `blocked_by: modal-overlay`, `reload_policy: blocking`, with breadcrumbs of the user alternating clicks on `.unified-settings-close` and `div.modal.unified-settings-modal`.
- The stylesheet comment said the confirm "Sits above the settings modal". The value contradicted it.

## What Didn't Work

- **The Sentry tag alone.** `blocked_by: modal-overlay` can't separate Settings from the other surfaces whose first class is `modal-overlay` (see `describe()` in `src/utils/open-modal.ts`). The `ui.click` breadcrumbs were what separated the two cases. Repeated Close clicks mean Close is dead. A single open with no close attempt means the user left Settings open, which is intended behaviour.
- **The existing e2e tests.** `e2e/mobile-bottom-navigation.spec.ts` checks that the confirm exists and has `.active`, then presses Escape. Playwright's `toBeVisible` and `toHaveClass` do not consider stacking order, so a fully covered dialog passes both.

## Solution

Raise the overlay above the Settings layer, to the value the account-deletion dialog already uses for the same reason (`src/styles/main.css`, `.account-deletion-dialog-overlay`):

```css
/* before */
.confirm-dialog-overlay { /* ... */ z-index: 4000; }

/* after: appended to <body>, so it must out-stack .modal-overlay (9999) */
.confirm-dialog-overlay { /* ... */ z-index: 10050; }
```

Guard it with a real hit-test (`e2e/settings-panel-live-apply.spec.ts`, "closing Settings with unsaved panel changes shows a clickable discard confirm"):

```ts
const onTop = await discard.evaluate((button) => {
  const rect = button.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit !== null && button.contains(hit);
});
expect(onTop).toBe(true);
```

This test failed before the CSS change, returning `false` with a screenshot of Settings and no dialog, and passes after it. The deployed `dashboard-styles-*.css` served `.confirm-dialog-overlay{…z-index:10050…}` once #8756 shipped.

## Why This Works

Both overlays are children of `<body>` with `position: fixed`, so they share the root stacking context and the higher `z-index` paints on top. Nesting doesn't help here: Settings' overlay is created once in the `UnifiedSettings` constructor and reused, while the confirm is a standalone component. The fix is therefore about layer order. `10050` puts the confirm above every `9999` modal and the mobile tab bar (`10003`), which is what a dialog that blocks input needs.

## Prevention

- Any overlay appended to `<body>` that can open over Settings must use a `z-index` above `.modal-overlay` (9999). Before choosing a value, grep `main.css` for `z-index: 1[0-9]{4}` to see the existing layers.
- An e2e test for an overlay has to hit-test its primary control with `elementFromPoint`, or click it without `force` so Playwright's actionability check runs. Asserting presence or a class, then pressing Escape, can't catch a covered dialog.
- When 15Z (or any `[stale-bundle] … modal never closed` report) names `modal-overlay`, read the `ui.click` breadcrumbs before deciding it's intended. Repeated close clicks point to a dead control, not a user choice.

## Related

- [A forced reload on tab-focus destroys the modal the user left the app to serve](stale-bundle-reload-destroys-an-in-progress-modal.md) explains why an open modal defers the reload at all, and why the deferral is unbounded, which is what turns a dead Close button into a wedged tab.
