// Module hooks for the runSeed probe: a seeder's import of scripts/_seed-utils.mjs
// resolves to a module that re-exports the real one with runSeed replaced.
const RECORDER = new URL('./recorder.mjs', import.meta.url).href;
const PREFIX = 'runseed-probe:';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(PREFIX)) return { url: specifier, shortCircuit: true };
  const resolved = await next(specifier, context);
  if (resolved.url.endsWith('/scripts/_seed-utils.mjs') && !context.parentURL?.startsWith(PREFIX)) {
    return { url: PREFIX + resolved.url, shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, next) {
  if (!url.startsWith(PREFIX)) return next(url, context);
  const real = url.slice(PREFIX.length);
  return {
    format: 'module',
    shortCircuit: true,
    source: `export * from ${JSON.stringify(real)};\nexport { runSeed } from ${JSON.stringify(RECORDER)};\n`,
  };
}
