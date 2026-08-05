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
    server: { deps: { inline: ["convex-test"] } },
    include: [
      "convex/__tests__/**/*.test.ts",
      "server/__tests__/**/*.test.ts",
      "src/services/correlation-engine/**/*.test.ts",
    ],
  },
});
