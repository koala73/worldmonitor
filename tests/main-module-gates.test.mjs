import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_MODULE_HELPER = join(REPO_ROOT, 'scripts/lib/main-module.mjs');
const INLINE_MAIN_GUARD = /(?:import\.meta\.url\s*===\s*pathToFileURL\s*\(\s*process\.argv\s*\[\s*1\s*\]\s*\)\.href|pathToFileURL\s*\(\s*process\.argv\s*\[\s*1\s*\]\s*\)\.href\s*===\s*import\.meta\.url)/;

const GATES = [
  {
    file: 'scripts/enforce-safe-html.mjs',
    setup(root) {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/fixture.ts'),
        'const element = document.createElement("div");\nelement.innerHTML = userHtml;\n',
      );
    },
    expected: /Direct innerHTML\/outerHTML assignment is blocked/,
  },
  {
    file: 'scripts/enforce-panel-content-writes.mjs',
    setup(root) {
      mkdirSync(join(root, 'src/components'), { recursive: true });
      writeFileSync(
        join(root, 'src/components/FailingPanel.ts'),
        'class FailingPanel extends Panel { render() { this.content.appendChild(document.createElement("div")); } }\n',
      );
    },
    expected: /Panel content-write guard failed/,
  },
  {
    file: 'scripts/check-local-secret-dumps.mjs',
    setup(root) {
      writeFileSync(join(root, '.env.vercel-backup'), 'do-not-use\n');
    },
    expected: /local environment dump files are present/,
  },
  {
    file: 'scripts/check-vite-env-secrets.mjs',
    setup(root) {
      writeFileSync(join(root, '.env.example'), 'VITE_SERVICE_TOKEN=do-not-use\n');
    },
    expected: /VITE_SERVICE_TOKEN/,
  },
];

function createSymlinkedGateFixture(gate) {
  const root = mkdtempSync(join(tmpdir(), 'wm-main-module-gate-'));
  const scriptPath = join(root, gate.file);
  mkdirSync(dirname(scriptPath), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  copyFileSync(join(REPO_ROOT, gate.file), scriptPath);
  copyFileSync(MAIN_MODULE_HELPER, join(root, 'scripts/lib/main-module.mjs'));
  gate.setup(root);

  const linkedRoot = join(root, 'linked-checkout');
  symlinkSync(root, linkedRoot, 'dir');
  return { root, linkedScript: join(linkedRoot, gate.file) };
}

function newlyAddedGateFiles() {
  const files = new Set();
  const gitCommands = [
    ['diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD', '--', 'scripts'],
    ['diff', '--cached', '--name-only', '--diff-filter=A', '--', 'scripts'],
    ['diff', '--name-only', '--diff-filter=A', '--', 'scripts'],
    ['ls-files', '--others', '--exclude-standard', '--', 'scripts'],
  ];

  for (const args of gitCommands) {
    try {
      for (const file of execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).split(/\r?\n/)) {
        if (/^scripts\/(?:enforce|check|audit)-[^/]+\.mjs$/.test(file)) files.add(file);
      }
    } catch {
      // A source archive or shallow checkout may not have the comparison ref.
    }
  }

  return [...files].sort();
}

describe('CI gate main-module guards (#7122)', () => {
  it('requires every affected gate to use the shared realpath-safe helper', () => {
    for (const gate of GATES) {
      const source = readFileSync(join(REPO_ROOT, gate.file), 'utf8');
      assert.match(
        source,
        /import \{ isMainModule \} from ['"]\.\/lib\/main-module\.mjs['"];?/,
        `${gate.file} must import scripts/lib/main-module.mjs`,
      );
      assert.match(
        source,
        /isMainModule\(import\.meta\.url, process\.argv\[1\]\)/,
        `${gate.file} must use isMainModule for its entrypoint`,
      );
      assert.doesNotMatch(
        source,
        /import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\)\.href/,
        `${gate.file} must not use the symlink-unsafe inline entrypoint check`,
      );
    }
  });

  it('rejects the symlink-unsafe inline guard in newly added gate CLIs', () => {
    for (const file of newlyAddedGateFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      assert.doesNotMatch(
        source,
        INLINE_MAIN_GUARD,
        `${file} must use scripts/lib/main-module.mjs instead of an inline entrypoint check`,
      );
    }
  });

  it('recognizes both comparison directions of the inline guard', () => {
    assert.match(
      'import.meta.url === pathToFileURL(process.argv[1]).href',
      INLINE_MAIN_GUARD,
    );
    assert.match(
      'pathToFileURL(process.argv[1]).href === import.meta.url',
      INLINE_MAIN_GUARD,
    );
  });

  it('keeps the new-gate policy test non-vacuous with unsafe and safe fixtures', () => {
    for (const source of [
      'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();',
      'if (pathToFileURL(process.argv[1]).href === import.meta.url) main();',
    ]) {
      assert.match(source, INLINE_MAIN_GUARD);
    }
    assert.doesNotMatch(
      "import { isMainModule } from './lib/main-module.mjs';\nif (isMainModule(import.meta.url, process.argv[1])) main();",
      INLINE_MAIN_GUARD,
    );
  });

  it('executes every affected gate through a symlinked checkout', (t) => {
    for (const gate of GATES) {
      let fixture;
      try {
        fixture = createSymlinkedGateFixture(gate);
      } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
          t.skip('symlink creation is unavailable in this environment');
          return;
        }
        throw error;
      }

      try {
        const result = spawnSync(process.execPath, [fixture.linkedScript], {
          cwd: fixture.root,
          encoding: 'utf8',
        });
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

        assert.equal(result.status, 1, `${gate.file} must fail its fixture through a symlink`);
        assert.match(output, gate.expected, `${gate.file} did not report its fixture failure`);
        assert.notEqual(output.trim(), '', `${gate.file} silently exited without running`);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });
});
