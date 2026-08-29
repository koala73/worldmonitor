import { defineConfig } from 'vitest/config';

/**
 * The OpenEye boot ceremony's suite.
 *
 * Separate from vitest.config.mts because that one runs Convex and server
 * tests under `edge-runtime` — no DOM at all — while the director, the
 * typewriter and the CRT stage machine are entirely about what happens to
 * elements. Two environments, two configs; merging them would mean every
 * Convex test paying for a jsdom it never touches.
 *
 * These came across from the openeye repo with their source and are run by
 * `npm run test:boot`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/boot/**/*.test.ts'],
  },
});
