# PR: Optional canvas-confetti via CDN (Fix 2)

Copy from "Summary" below for the PR description.

---

## Summary

Makes the celebration service work when the `canvas-confetti` package is not installed in `node_modules`, so the app builds and runs without "Failed to resolve import 'canvas-confetti'" (e.g. after a fresh clone before `npm install`, or in environments where dependencies are not fully installed).

**When the import fails:** The error occurs when Vite tries to resolve `canvas-confetti` at build or dev startup and the package is missing from `node_modules` — for example right after cloning the repo without running `npm install`, or in a workspace where dependencies have not been installed yet. We did not observe it in CI, Tauri build, or a specific Node version; it was the "package not installed" case.

**Implementation:**
- Load confetti at runtime from a CDN script instead of bundling the npm package. No `import 'canvas-confetti'` in source, so Vite never tries to resolve it.
- Use a **module-scoped cached promise** for the load so that only one `<script>` tag is ever appended. The record celebration calls `run()` twice (300ms apart); without the cache, a second script would be appended if the first load had not finished. All callers now share the same promise.
- Do **not** add `optimizeDeps.include: ['canvas-confetti']` in vite.config, so the package remains optional and Vite does not try to pre-bundle it at dev startup.

**Trade-off:** If the CDN is unavailable or the user is offline, celebrations still run but no confetti is shown. When the package is installed (after `npm install`), the CDN is used the same way so behavior is consistent.

## Type of change

- [x] Bug fix
- [ ] New feature
- [ ] Other

## Affected areas

- [ ] Map / Globe
- [ ] News panels / RSS feeds
- [ ] Other: celebration service (`src/services/celebration.ts`)

## Checklist

- [x] No API keys or secrets committed
- [x] TypeScript compiles (run `npm install` first if typecheck fails for canvas-confetti)

## Screenshots

None. Manual check: run the app without `canvas-confetti` in node_modules (e.g. remove it from node_modules and run `npm run dev`); app should start and celebrations should load confetti from CDN when triggered.
