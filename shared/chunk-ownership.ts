/**
 * Build-time chunk ownership manifest.
 *
 * `beforeSend` in `src/bootstrap/sentry-init.ts` runs in the browser BEFORE
 * sourcemapping, so the only thing it knows about a frame is a hashed filename.
 * It used to infer ownership from that name against a hand-maintained
 * `vendorChunk` regex, which is unsound for two reasons:
 *
 *   1. The list drifts. `protomaps` and `h3-js` were emitted by vite.config.ts's
 *      node_modules branch for months without ever being added (PR #8487).
 *   2. A chunk NAME does not describe whose code is inside it. Rollup names a
 *      chunk after its seed module and then hoists shared modules into it, so a
 *      vendor-named chunk routinely carries first-party code. Measured on a real
 *      build: `i18n-<hash>.js` held 12/12 first-party modules (safe-storage,
 *      billing-retry, premium-paths, runtime, …) while a SECOND, genuinely pure
 *      chunk shared the name `i18n`; `deck-stack-<hash>.js` held
 *      src/components/DeckGLMap.ts; and the `sentry` pattern also matches
 *      `sentry-init-<hash>.js`, which is 5/5 ours. All three were classified as
 *      vendor, so every `!hasFirstParty` gate was eligible to drop genuine
 *      first-party failures from them.
 *
 * No name-based rule can fix that: two chunks named `i18n` have OPPOSITE
 * ownership. Only the build knows, so the build says so. A rollup plugin reads
 * each chunk's `moduleIds` in `generateBundle` and appends one statement that
 * registers the chunk's own ownership as it evaluates.
 *
 * Kept dependency-free and in `shared/` so `vite.config.ts` (node) and the
 * browser bundle agree on one contract rather than two copies of a string.
 */

/** Global the manifest accumulates into. Read by `beforeSend`. */
export const CHUNK_OWNERSHIP_GLOBAL = '__WM_CHUNK_OWNERSHIP__';

/** A chunk contains at least one module that is ours. */
export const CHUNK_FIRST_PARTY = 1;
/** Every module in the chunk came from node_modules. */
export const CHUNK_VENDOR = 0;

/**
 * True when `moduleIds` contains a module we wrote. Rollup helper/virtual ids
 * start with `\0` and belong to no one, so they never make a chunk first-party.
 */
export function chunkHasFirstPartyModule(moduleIds: readonly string[]): boolean {
  return moduleIds.some((id) => !id.startsWith('\0') && !id.includes('node_modules'));
}

/**
 * The statement appended to a chunk. APPENDED, never prepended: a chunk is one
 * minified line, so inserting at the front would shift every column on it and
 * invalidate the sourcemap Sentry symbolicates with. Appending shifts nothing
 * ahead of it.
 */
export function buildChunkOwnershipSnippet(basename: string, firstParty: boolean): string {
  const g = CHUNK_OWNERSHIP_GLOBAL;
  const value = firstParty ? CHUNK_FIRST_PARTY : CHUNK_VENDOR;
  return `\n;(globalThis.${g}||(globalThis.${g}={}))[${JSON.stringify(basename)}]=${value};`;
}

/**
 * Splice the registration into a chunk body, keeping `//# sourceMappingURL=`
 * last — the browser only honours that comment at the end of the file, and
 * Sentry symbolication depends on it resolving.
 */
export function appendChunkOwnership(code: string, basename: string, firstParty: boolean): string {
  const snippet = buildChunkOwnershipSnippet(basename, firstParty);
  const marker = code.lastIndexOf('\n//# sourceMappingURL=');
  return marker === -1
    ? code + snippet
    : code.slice(0, marker) + snippet + code.slice(marker);
}
