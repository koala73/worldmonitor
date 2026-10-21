import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "edge-runtime",
    // Two dots on purpose: `convex deploy` pushes every single-dot module under
    // convex/ to the backend, so test scaffolding must never carry a one-dot
    // name (tests/convex-entrypoint-hygiene.test.mjs pins this).
    setupFiles: ["convex/__tests__/vitest.setup.ts"],
    server: { deps: { inline: ["convex-test"] } },
    include: [
      "convex/__tests__/**/*.test.ts",
      "server/__tests__/**/*.test.ts",
      "src/services/correlation-engine/**/*.test.ts",
    ],
  },
});
