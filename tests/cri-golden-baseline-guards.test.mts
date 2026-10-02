import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

import {
  GOLDEN_ENV_FLAGS,
  assertGenerationGuards,
  isDirectRun,
  readGenerationDirtyStatus,
} from '../scripts/generate-cri-golden-baseline.mts';

// Unit coverage for the generator CLI's guard logic (issue #7728 review
// follow-up): the ancestry and dirtiness gates are pure functions over
// injected git results, and the main-guard isDirectRun must survive both
// direct and symlinked invocation paths. Also pins the env-read exhaustiveness
// claim: every RESILIENCE_* env read in the resilience scorer tree must be
// either one of the pinned dynamic flags or the known module-load const.

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');
const SCORER_TREE_DIR = path.join(REPO_ROOT, 'server/worldmonitor/resilience/v1');
const MODULE_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/generate-cri-golden-baseline.mts')).href;

type EnvReadTiming = 'call-time' | 'module-load';

interface ResilienceEnvRead {
  file: string;
  name: string;
  timing: EnvReadTiming;
}

function repositoryPath(filePath: string): string {
  return filePath.replaceAll(path.win32.sep, path.posix.sep);
}

function immediateInvocation(node: ts.Node): ts.CallExpression | null {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  let expression: ts.Expression = node;
  while (ts.isParenthesizedExpression(expression.parent) && expression.parent.expression === expression) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  return ts.isCallExpression(parent) && parent.expression === expression ? parent : null;
}

function envReadTiming(node: ts.Node): EnvReadTiming {
  let ancestor = node.parent;
  while (ancestor && !ts.isSourceFile(ancestor)) {
    if (ts.isFunctionLike(ancestor)) {
      const invocation = immediateInvocation(ancestor);
      if (!invocation) return 'call-time';
      ancestor = invocation.parent;
      continue;
    }
    ancestor = ancestor.parent;
  }
  return 'module-load';
}

function collectResilienceEnvReads(filePath: string, source: string): ResilienceEnvRead[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reads: ResilienceEnvRead[] = [];

  const resilienceFlagName = (node: ts.Node): string | null => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
    const envObject = node.expression;
    if (
      !ts.isPropertyAccessExpression(envObject) ||
      envObject.name.text !== 'env' ||
      !ts.isIdentifier(envObject.expression) ||
      envObject.expression.text !== 'process'
    ) return null;

    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    return name?.startsWith('RESILIENCE_') ? name : null;
  };

  const visit = (node: ts.Node): void => {
    const name = resilienceFlagName(node);
    if (name) {
      reads.push({
        file: repositoryPath(path.relative(REPO_ROOT, filePath)),
        name,
        timing: envReadTiming(node),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return reads;
}

function formatEnvRead(read: ResilienceEnvRead): string {
  return `${read.timing}:${read.name} (${read.file})`;
}

function guardsFixture(overrides: Partial<Parameters<typeof assertGenerationGuards>[0]> = {}) {
  return {
    headSha: 'a'.repeat(40),
    headIsAncestorOfOriginMain: true,
    dirtyStatusLines: [],
    allowNonMain: false,
    allowDirtyTree: false,
    ...overrides,
  };
}

describe('CRI golden baseline generator guards', () => {
  describe('assertGenerationGuards', () => {
    it('accepts an ancestor commit on a clean tree', () => {
      assert.doesNotThrow(() => assertGenerationGuards(guardsFixture()));
    });

    it('refuses a non-ancestor or unprovable commit without --allow-non-main', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ headIsAncestorOfOriginMain: false })),
        /--allow-non-main/,
      );
    });

    it('accepts a non-ancestor commit only with --allow-non-main', () => {
      assert.doesNotThrow(() =>
        assertGenerationGuards(guardsFixture({ headIsAncestorOfOriginMain: false, allowNonMain: true })),
      );
    });

    it('refuses guarded dirty paths without --allow-dirty-fixture', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ dirtyStatusLines: [' M server/worldmonitor/resilience/v1/_shared.ts'] })),
        /--allow-dirty-fixture/,
      );
    });

    it('accepts dirty guarded paths only with --allow-dirty-fixture', () => {
      assert.doesNotThrow(() =>
        assertGenerationGuards(guardsFixture({
          dirtyStatusLines: [' M tests/fixtures/resilience-whole-index-pairs-2026-08-13.json'],
          allowDirtyTree: true,
        })),
      );
    });

    it('fails closed when dirtiness cannot be determined', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ dirtyStatusLines: null })),
        /could not determine working-tree dirtiness/,
      );
    });

    it('keeps the two override flags independent', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ headIsAncestorOfOriginMain: false, allowDirtyTree: true })),
        /--allow-non-main/,
      );
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ dirtyStatusLines: ['?? x'], allowNonMain: true })),
        /--allow-dirty-fixture/,
      );
    });
  });

  describe('working-tree input guard', () => {
    it('rejects real staged, unstaged, and untracked inputs while allowing output-only changes', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'wm-golden-inputs-'));
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
      const write = (file: string, content: string) => {
        const target = path.join(dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      const dependencies = [
        'server/_shared/resilience-stats.ts',
        'server/_shared/resilience-freshness.ts',
        'shared/iso2-to-iso3.json',
        'tsconfig.json',
      ];
      const output = 'tests/fixtures/resilience-cri-golden-baseline-2026-08-13.json';
      try {
        git('init', '--quiet');
        for (const file of [...dependencies, output]) write(file, '{}\n');
        git('add', '.');
        git('-c', 'user.name=Guard test', '-c', 'user.email=guard@example.invalid',
          '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Input baseline');
        assert.deepEqual(readGenerationDirtyStatus(dir), []);
        write(output, '{"regenerated":true}\n');
        assert.deepEqual(readGenerationDirtyStatus(dir), []);
        git('add', output);
        assert.deepEqual(readGenerationDirtyStatus(dir), []);

        for (const file of dependencies) {
          write(file, '{"changed":true}\n');
          for (const staged of [false, true]) {
            if (staged) git('add', file);
            const dirtyStatusLines = readGenerationDirtyStatus(dir);
            assert.ok(dirtyStatusLines?.some((line) => line.endsWith(file)), file);
            assert.throws(() => assertGenerationGuards(guardsFixture({ dirtyStatusLines })), /--allow-dirty-fixture/);
          }
          write(file, '{}\n');
          git('add', file);
        }
        write('shared/new-scoring-input.json', '{}\n');
        const dirtyStatusLines = readGenerationDirtyStatus(dir);
        assert.ok(dirtyStatusLines?.some((line) => line === '?? shared/new-scoring-input.json'));
        assert.throws(() => assertGenerationGuards(guardsFixture({ dirtyStatusLines })), /--allow-dirty-fixture/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('isDirectRun', () => {
    it('is true for the direct script path', () => {
      assert.equal(isDirectRun(path.join(REPO_ROOT, 'scripts/generate-cri-golden-baseline.mts'), MODULE_URL), true);
    });

    it('is false when the module is imported by another file', () => {
      assert.equal(isDirectRun(path.join(TESTS_ROOT, 'cri-golden-baseline-guards.test.mts'), MODULE_URL), false);
    });

    it('is true through a symlinked script path (macOS /tmp -> /private/tmp style)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'wm-golden-guard-'));
      try {
        const link = path.join(dir, 'linked-generator.mts');
        symlinkSync(path.join(REPO_ROOT, 'scripts/generate-cri-golden-baseline.mts'), link);
        assert.equal(isDirectRun(link, MODULE_URL), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is false when argv1 is missing', () => {
      assert.equal(isDirectRun(undefined, MODULE_URL), false);
    });
  });

  describe('env-read exhaustiveness', () => {
    const EXPECTED_ENV_READS = [
      'call-time:RESILIENCE_EDUCATION_ENABLED (server/worldmonitor/resilience/v1/_dimension-scorers.ts)',
      'call-time:RESILIENCE_ENERGY_V2_ENABLED (server/worldmonitor/resilience/v1/_dimension-scorers.ts)',
      'call-time:RESILIENCE_ENERGY_V2_ENABLED (server/worldmonitor/resilience/v1/_shared.ts)',
      'call-time:RESILIENCE_FIN_SYS_EXPOSURE_ENABLED (server/worldmonitor/resilience/v1/_dimension-scorers.ts)',
      'call-time:RESILIENCE_FIN_SYS_EXPOSURE_ENABLED (server/worldmonitor/resilience/v1/_shared.ts)',
      'call-time:RESILIENCE_PILLAR_COMBINE_ENABLED (server/worldmonitor/resilience/v1/_shared.ts)',
      'module-load:RESILIENCE_SCHEMA_V2_ENABLED (server/worldmonitor/resilience/v1/_shared.ts)',
    ].sort();

    it('distinguishes module-load and call-time reads of the same flag', () => {
      const reads = collectResilienceEnvReads(
        path.join(REPO_ROOT, 'synthetic-scorer.ts'),
        [
          'const captured = process.env.RESILIENCE_EDUCATION_ENABLED;',
          'function enabled() { return process.env.RESILIENCE_EDUCATION_ENABLED; }',
          "const bracketed = process.env['RESILIENCE_ENERGY_V2_ENABLED'];",
          'const capturedByIife = (() => process.env.RESILIENCE_PILLAR_COMBINE_ENABLED)();',
          'function deferredIife() { return (() => process.env.RESILIENCE_SCHEMA_V2_ENABLED)(); }',
          '// process.env.RESILIENCE_COMMENT_ONLY',
        ].join('\n'),
      );

      assert.deepEqual(reads, [
        { file: 'synthetic-scorer.ts', name: 'RESILIENCE_EDUCATION_ENABLED', timing: 'module-load' },
        { file: 'synthetic-scorer.ts', name: 'RESILIENCE_EDUCATION_ENABLED', timing: 'call-time' },
        { file: 'synthetic-scorer.ts', name: 'RESILIENCE_ENERGY_V2_ENABLED', timing: 'module-load' },
        { file: 'synthetic-scorer.ts', name: 'RESILIENCE_PILLAR_COMBINE_ENABLED', timing: 'module-load' },
        { file: 'synthetic-scorer.ts', name: 'RESILIENCE_SCHEMA_V2_ENABLED', timing: 'call-time' },
      ]);
    });

    it('normalizes Windows paths to repository separators', () => {
      assert.equal(repositoryPath('server\\worldmonitor\\resilience\\v1\\_shared.ts'),
        'server/worldmonitor/resilience/v1/_shared.ts');
    });

    it('pins every RESILIENCE_* env-read occurrence to its file and capture timing', () => {
      const reads: ResilienceEnvRead[] = [];
      for (const entry of readdirSync(SCORER_TREE_DIR, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const filePath = path.join(entry.parentPath, entry.name);
        reads.push(...collectResilienceEnvReads(filePath, readFileSync(filePath, 'utf8')));
      }

      const actual = reads.map(formatEnvRead).sort();
      assert.deepEqual(
        actual,
        EXPECTED_ENV_READS,
        'RESILIENCE_* env-read occurrences or capture timing changed. Call-time reads must be pinned in ' +
          'GOLDEN_ENV_FLAGS; module-load reads need a fail-fast binding guard in assertFrozenScorerDefaults().',
      );

      const callTimeFlags = [...new Set(reads.filter((read) => read.timing === 'call-time').map((read) => read.name))].sort();
      assert.deepEqual(
        callTimeFlags,
        Object.keys(GOLDEN_ENV_FLAGS).sort(),
        'GOLDEN_ENV_FLAGS must pin every call-time RESILIENCE_* flag and no others.',
      );
    });
  });
});
