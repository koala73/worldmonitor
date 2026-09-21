/**
 * Launch override for specs that render the dashboard but never need WebGL.
 *
 * The suite runs Chromium with `--use-angle=swiftshader --use-gl=swiftshader`
 * so the map harness can build a real DeckGL context (#8447). Every dashboard
 * load then pays for that too: `MapContainer.hasWebGLSupport()` creates a
 * SwiftShader WebGL2 context purely to read `UNMASKED_RENDERER_WEBGL`, see
 * `swiftshader`, and fall back to the SVG renderer. `hasGlobeSupport()` creates
 * a second one. Neither is ever released.
 *
 * Those loads are where the browser dies. All 48 attributed SIGTRAP crashes in
 * #8447 landed on dashboard-rendering specs; `mcp-grant-consent.spec.ts`, which
 * renders no map and carries 28 of shard 1's tests, took zero.
 *
 * `--disable-gpu` makes `getContext('webgl2')` return null, so the capability
 * probe reaches the SAME SVG decision without instantiating SwiftShader at all.
 * Verified by running both ci-smoke shards with it: shard 1 passed 77/77 and
 * shard 2 passed 29/30, the single failure being the one test that genuinely
 * needs WebGL (`bootstrap-request-budget.spec.ts:119`), which keeps the default.
 *
 * This is a probable fix, not a proven one. The mechanism behind the SIGTRAP is
 * still unknown and does not reproduce locally. The merged crash reporting in
 * `.github/workflows/test.yml` measures the rate on every merge, so the
 * baseline of 50 crashes across 76 shard-runs is what this is judged against.
 */
export const NO_GPU_LAUNCH = {
  launchOptions: { args: ['--disable-gpu'] },
} as const;
