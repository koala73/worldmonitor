import { resolve } from 'node:path';
import { buildSync } from 'esbuild';

// Bundle the same converter used by the dashboard and plugin.
export function bundleProfileInput() {
  return buildSync({
    stdin: {
      contents: `export { protoItemToNewsItem } from './src/services/news-digest-items.ts';
        export { clusterNewsCore } from './shared/news-clustering-core.js';
        export { SOURCE_TIERS, getSourceTier } from './server/_shared/source-tiers.ts';
        `,
      loader: 'ts', resolveDir: process.cwd(),
    },
    bundle: true, minify: true, format: 'iife', globalName: 'NewsClustering', write: false,
  }).outputFiles[0].text;
}

export async function bundleAnalysisWorker() {
  const { build } = await import('vite');
  const result = await build({
    configFile: false, logLevel: 'error', mode: 'production',
    resolve: { alias: { '@': resolve('src') } },
    build: { write: false, minify: 'esbuild',
      lib: { entry: resolve('src/workers/analysis.worker.ts'), name: 'AnalysisWorker', formats: ['iife'] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  return result[0].output.find((item) => item.type === 'chunk').code;
}

export function budgetEvidence(timings) {
  const frameBudgetExceededCount = timings.filter((ms) => ms >= 16.7).length;
  const longTaskBudgetExceededCount = timings.filter((ms) => ms >= 50).length;
  return {
    frameBudgetExceededCount, longTaskBudgetExceededCount,
    exceedsFrameBudget: frameBudgetExceededCount > 0,
    exceedsLongTask: longTaskBudgetExceededCount > 0,
    repeatableBudgetExceedance: frameBudgetExceededCount >= 2,
  };
}
