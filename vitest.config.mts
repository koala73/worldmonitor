import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/__tests__/**/*.test.ts", "server/__tests__/**/*.test.ts"],
  },
});
