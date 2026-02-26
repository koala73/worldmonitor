# Fix 2: canvas-confetti — Rework for separate PR

Review feedback (summary): Fix 2 was split from the Issue #347 PR. When submitting a new PR for the canvas-confetti change, address the following.

## 1. Promise cache for `loadConfetti()`

- **Issue:** `loadConfetti()` appends a new `<script>` on every call until the first load finishes. The record celebration calls `run()` twice (300 ms apart); if the script is not loaded in 300 ms, a second `<script>` is appended.
- **Fix:** Use a module-scoped cached promise (e.g. `let confettiLoadPromise: Promise<ConfettiFn | null> | null = null`) and return the same promise for every call so only one script tag is added and all callers wait on it.

## 2. Do not use `optimizeDeps.include: ['canvas-confetti']`

- **Issue:** That option makes Vite pre-bundle canvas-confetti at dev startup, which fails if the package is not installed. It contradicts the goal of making the package optional.
- **Fix:** Omit `optimizeDeps.include` for canvas-confetti when using CDN loading.

## 3. Clarify when the import fails

- **Request:** canvas-confetti is already in package.json. Describe the specific scenario where the import fails (e.g. CI, Tauri build, Node version, or “clone without running npm install”).
- **Fix:** In the PR description, state clearly when/where you see “Failed to resolve import 'canvas-confetti'” so maintainers can choose between CDN loading vs. ensuring `npm install` (or CI step) runs.

## 4. Optional: keep package optional

- If the goal is “app runs even when canvas-confetti is not installed”, keep CDN loading with a single cached load promise and no `optimizeDeps` for canvas-confetti.
- If the goal is “CI / Tauri always has the package”, consider only fixing CI or install steps and keeping the normal npm import.

Use this checklist when opening the separate Fix 2 PR.
