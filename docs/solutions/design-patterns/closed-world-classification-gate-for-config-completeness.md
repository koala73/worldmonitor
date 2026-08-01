---
title: "Closed-world classification gate: every mechanically-enumerable config member must be classified, or CI fails"
date: 2026-07-31
category: design-patterns
module: desktop build env / CI gates
problem_type: design_pattern
applies_when:
  - "A consumer (build, deploy, runtime) receives a hand-maintained subset of a mechanically enumerable universe (env vars, routes, feature flags, watch paths, locales)"
  - "A member silently missing from the subset degrades a capability without any error — the #5905 incident class"
  - "New members are added by many contributors over time, so any opt-in list rots by default"
tags: [closed-world, classification-gate, allowlist-rot, env-vars, ci-gates, vacuous-guard, completeness]
---

# Closed-world classification gate: every mechanically-enumerable config member must be classified, or CI fails

## Context

Desktop releases shipped for months with sign-in, subscription entitlements,
and the Cyber Threats layer silently disabled (#5905): the Tauri build
workflow passed a hand-picked subset of the `VITE_*` client env, and nothing
forced anyone to decide whether a newly added var belonged in the desktop
build. The web app got every var from Vercel env, so the omission was
invisible everywhere except the shipped binary. An opt-in allowlist rots
precisely because adding a member requires *remembering the list exists* —
the same failure documented for Railway seeder watch paths
(`docs/solutions/integration-issues/railway-seeder-watch-paths-can-skip-deployments.md`).

## Guidance

Structure the gate as a **closed world** over a **mechanically enumerated
universe**, not as an opt-in list:

1. **Enumerate the universe from the source of truth**, not from memory: scan
   the code for every member that exists (here: every `import.meta.env.VITE_*`
   read under `src/` and `shared/`, matching cast/bracket/optional-chain
   access shapes so syntax cannot dodge the scan).
2. **Require every member to be classified** into one of two recorded sets:
   `REQUIRED` (mechanically asserted present at every consumer — here, every
   `tauri-apps/tauri-action` step's `env:` block) or `EXCLUDED` (with a
   one-line recorded reason: "web-seeded; desktop uses keyring", "feature
   sunset #4982"). An unclassified member **fails CI** with a message naming
   the member and the exact file/arrays to edit.
3. **Guard the enumerator itself against vacuous pass**: zero extracted
   consumers (or zero universe members where some must exist) is a failure,
   never a skip — an extraction glob that rots must go red, not green
   (see `CONCEPTS.md` → Vacuous Guard, Mutation Proof).
4. **Separate declaration-time and activation-time checks** when values come
   from secrets: PR CI asserts the *key is declared* (checkable from a PR;
   safe before the secret exists), while the release pipeline hard-fails on
   *empty values* (a tag-push release must not ship featureless). These are
   different invariants with different failure surfaces — implement both.

Reference implementation: `scripts/check-desktop-build-env.mjs`
(`npm run desktop:check-env`), wired into the `desktop-config` CI job
(fires on workflow edits) **and** the `unit` job (fires when the universe
grows — a new env read in src/), with the release-time non-emptiness
preflight in `.github/workflows/build-desktop.yml`. Shipped on PR #5919.

## Why This Matters

The forcing function moves the classification decision to the moment a
member is introduced — the one time its author has full context — instead
of leaving it to an audit months later. The recorded `EXCLUDED` reasons are
a decision log: the next reader distinguishes "deliberately not shipped"
from "forgotten", which is exactly the distinction the original incident
lacked. An opt-in list can only ever catch what someone remembered; a
closed world catches what everyone forgot.

## When to Apply

- Any hand-maintained projection of an enumerable set: build env passed to a
  packager, routes bundled into a sidecar, locales shipped to a client,
  feature flags mirrored across surfaces, CI path filters over script
  dependencies.
- Especially when the degraded state is silent (capability off, not error).
- Not worth the machinery when the universe cannot be mechanically
  enumerated, or when a missing member already fails loudly at build time —
  the pattern buys its keep only where omission is silent.

## Examples

Failure message shape that makes the gate self-serving (from the reference
implementation):

```
::error::desktop build env: unclassified VITE_ vars read by the SPA:
VITE_NEW_FLAG — add each to REQUIRED_DESKTOP_BUILD_ENV or
EXCLUDED_DESKTOP_BUILD_ENV (with a reason) in scripts/check-desktop-build-env.mjs
```

Classification record shape — the reason is the point:

```js
export const EXCLUDED_DESKTOP_BUILD_ENV = {
  VITE_OPENSKY_RELAY_URL: 'web-seeded runtime secret; desktop uses the OS-keyring path instead',
  VITE_ENABLE_IRAN_ATTACKS: 'feature sunset, default-off everywhere (#4982)',
};
```

Related: `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md`
(prove the gate itself with mutations — the reference implementation's
fixtures kill missing-key, unclassified-var, zero-steps, and parser-evasion
mutants);
`docs/solutions/integration-issues/railway-seeder-watch-paths-can-skip-deployments.md`
(the enumerated-allowlist rot this pattern replaces).
