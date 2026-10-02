// Stands in for Vite's `import.meta.glob` when a browser module is bundled
// for node with esbuild. Callers only enumerate the result, so an empty map
// is enough; anything that actually needs a locale must load it explicitly.
export const __wmNoGlob = () => ({});
