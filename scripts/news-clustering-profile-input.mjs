import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import ts from 'typescript';

// Compile the actual client converter without importing DataLoader's UI and
// network side effects. Fail if its declarations move; never substitute a
// reduced, independently maintained item shape in the benchmark.
export function bundleProfileInput() {
  const path = resolve('src/app/data-loader.ts');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['PROTO_TO_CLIENT_PHASE', 'protoItemToNewsItem'];
  const declarations = names.map((name) => {
    const statement = source.statements.find((node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(source) === name)));
    if (!statement) throw new Error(`Profile input declaration moved: ${name}`);
    return statement.getText(source);
  });
  return buildSync({
    stdin: {
      contents: `import { protoThreatLevelToLabel } from './shared/news-clustering-core.js';
        export { clusterNewsCore } from './shared/news-clustering-core.js';
        export { SOURCE_TIERS, getSourceTier } from './server/_shared/source-tiers.ts';
        ${declarations.join('\n')}
        export { protoItemToNewsItem };`,
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
