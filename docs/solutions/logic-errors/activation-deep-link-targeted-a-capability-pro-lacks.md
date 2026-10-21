---
title: "Pro activation deep-link targeted API Keys, a capability the Pro plan does not have"
date: 2026-07-25
category: logic-errors
module: pro-activation
problem_type: logic_error
component: payments
severity: high
symptoms:
  - "Activation wizard step 3 read 'Get your API & MCP keys' and deep-linked to Settings -> API Keys, which renders 'Upgrade to API Starter' for a user who had just paid for Pro"
  - "Pro entitlement is apiAccess:false / mcpAccess:true (convex/config/productCatalog.ts:138,149), so the promised capability never existed on that plan"
  - "Naively repointing the link at the MCP tab would have traded the upsell for a settings modal with no active panel, because that tab and its panel are both entitlement-gated"
  - "A capability read captured into the flow-options closure could go stale before the pointer was clicked, since ProActivationChip replays the captured object"
root_cause: wrong_api
resolution_type: code_fix
related_components: [testing_framework]
tags: [entitlements, pro-activation, deep-link, mcp, capability-gating, stale-closure, test-fidelity]
---

# Pro activation deep-link targeted API Keys, a capability the Pro plan does not have

## Problem

The Pro activation wizard's step-3 "power toolkit" card advertised **"Get your API & MCP keys"** and deep-linked into Settings -> **API Keys**. The Pro plan's feature set is `apiAccess: false, mcpAccess: true`:

```ts
// convex/config/productCatalog.ts:135-150
const PRO_FEATURES: PlanFeatures = {
  tier: 1,
  apiAccess: false,
  // ...
  mcpAccess: true,
};
```

So the card sold a capability the plan does not include, and routed the buyer to a panel whose entitlement gate immediately offered them **"Upgrade to API Starter"** — seconds after they paid for Pro. (Issue #5607, fixed in PR #5613.)

## Symptoms

- Step-3 copy promised API keys to a plan with `apiAccess: false`.
- The deep link landed on the API Keys tab, which renders an upgrade CTA for any user without `apiAccess`.
- Both were reached only on the post-purchase path, so the failure was invisible outside a live purchase repro.

## What Didn't Work

**Repointing the deep link at the MCP tab, unconditionally.** This is the obvious one-line fix and it is wrong. `UnifiedSettings` gates *both* the MCP tab button and its panel on the same feature:

```ts
// src/components/UnifiedSettings.ts:518 (tab button)
${hasFeature('mcpAccess') ? `<button ... data-tab="mcp-clients" ...>MCP Clients ...</button>` : ''}

// src/components/UnifiedSettings.ts:560-563 (panel)
${hasFeature('mcpAccess') ? `<div ... data-panel-id="mcp-clients" ...>...</div>` : ''}
```

and `open()` assigns the target with no check that it is rendered:

```ts
// src/components/UnifiedSettings.ts:343
if (tab) this.activeTab = tab;
```

An ungated `open('mcp-clients')` therefore swaps a wrong-upsell bug for a *blank modal* bug whenever the feature is absent.

**Gating on the plan key instead of the feature.** Tempting, because the activation flow already runs only for `pro_monthly` / `pro_annual`. But the panel renders on `hasFeature('mcpAccess')`, so a plan-key gate can disagree with the thing it is trying to predict. Gate on the same signal the destination gates on.

**Reading the capability once, when the options object is built.** This survives the interstitial (short-lived, opened immediately post-purchase) but not the finish-setup chip, which replays the *captured* options object much later:

```ts
// src/components/ProActivationChip.ts:134
void openProActivationFlow(options).catch((err) =>
```

A build-time-only check can therefore deep-link into a tab that stopped rendering in the interim.

## Solution

Point the pointer at the capability Pro actually has, gate it on that capability, and re-read the capability at click time:

```ts
// src/app/pro-activation-controller.ts:582-590
openMcpClients: hasFeature('mcpAccess')
  ? () => {
      // Re-check at click time, not just here: the finish-setup chip
      // replays this captured options object long after it was built, so
      // an entitlement that lapsed in between would otherwise deep-link
      // to a tab UnifiedSettings no longer renders.
      if (hasFeature('mcpAccess')) ctx.unifiedSettings?.open('mcp-clients');
      else ctx.unifiedSettings?.open('settings');
    }
  : undefined,
```

Leaving the opener `undefined` is the suppression mechanism — `buildPowerExtra` drops any pointer without an opener:

```ts
// src/components/ProActivationInterstitial.ts:1025
if (typeof open !== 'function') return;
```

Copy became "Set up MCP", and the i18n key `components.proActivation.steps.power.pointers.apiKeys` was renamed to `.mcpClients` across all 25 locales.

## Why This Works

The gate and the destination now consult the same predicate, so the pointer exists exactly when the panel it targets exists. The click-time re-read closes the build->click window that the chip's replay opens, and the `settings` fallback is a tab that renders unconditionally — so no path reaches a modal with no active panel.

## Prevention

**1. Gate a deep link on the capability its destination renders on — not on the plan, tier, or role you believe implies it.** Plan-to-capability mappings drift; the destination's own predicate does not. When the target is conditionally rendered, suppressing the entry point beats pointing it somewhere broken.

**2. A capability read that gets captured into a long-lived closure must be re-read at use time.** Build-time and click-time are different moments whenever the options object outlives the interaction that built it. Ask what replays the closure — here it was a "finish setup later" chip.

**3. Do not reason about "legacy rows predating a field" in this repo without checking the read path.** Entitlements read-merge catalog defaults, so a row written before a feature flag existed still resolves the current default:

```ts
// convex/entitlements.ts:50-53
const catalogDefaults = getFeaturesForPlan(entitlement.planKey);
return {
  planKey: entitlement.planKey,
  features: { ...catalogDefaults, ...entitlement.features },
```

The original fix comment justified its gate with legacy snapshots; that rationale was wrong — the gate's real (narrow) purpose is an explicit per-user override. A comment that misstates *why* a guard exists is how the guard gets deleted later. Note `src/services/entitlements.ts:28-33` still carries the same stale "wait for the next webhook" framing.

**4. Make a test stub mirror production exactly, then let the fixtures fail.** The stub for `hasFeature` used optional chaining (`state.features?.[flag]`) where production indexes directly:

```ts
// src/services/entitlements.ts:156
return Boolean(currentState.features[flag]);
```

Tightening the stub to match immediately threw on two fixtures that built an `EntitlementState` with no `features` — a shape the Convex query never returns. The lenient stub had been quietly reporting `false` for them. A stub more forgiving than production converts fixture drift into silent green.

**5. An assertion that something is *absent* is vacuous unless the harness could have produced it.** The e2e guard

```ts
await expect(page.locator('.pro-activation-pointer[data-pointer="apiKeys"]')).toHaveCount(0);
```

could not fail: the harness never injected `openApiKeys`, and `add()` skips openerless pointers, so a reintroduced pointer would have been dropped by the harness rather than by the code under test. Injecting the retired opener gave it teeth — confirmed by mutation (reintroducing the pointer produced `Received: 1`).

**6. Mutation-verify each new assertion against the specific regression it guards.** Every assertion in this fix was confirmed red before being trusted: reverting the copy, removing the click-time re-check, reintroducing an `apiKeys` pointer, and both unconditional and inverted gate mutations.

## Related

- [Billing state: cancelled-but-paid-through misclassified as lapsed](../logic-errors/billing-state-cancelled-but-paid-through-misclassified-as-lapsed.md) — same failure family: a client-side derivation disagreeing with the server predicate it was meant to mirror.
- [i18n shell namespaces are a byte-budgeted first-paint surface](../conventions/i18n-shell-namespaces-are-byte-budgeted-first-paint-surface.md) — why the 25-locale rename here did not touch `en.shell.json`.
- Follow-ups filed from this work: #5611 (`UnifiedSettings.open()` can leave the modal with no active panel — the general case behind prevention rule 1), #5612 (power step re-sells MCP to users who already connected a client).
