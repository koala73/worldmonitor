/**
 * Coverage guardrail for scripts/railway-services.json — the single source
 * of truth for every script that runs as a Railway service. This test fails
 * if a deployment artifact in the repo (Dockerfile.* CMD line, runbook
 * "Start command:" entry, or standalone-service row) references a script not
 * present in the registry.
 *
 * Two BFS-style tests derive their entry lists from the registry:
 *   - tests/scripts-railway-nixpacks-no-escape-import.test.mts (nixpacks)
 *   - tests/dockerfile-digest-notifications-imports.test.mjs (Dockerfile)
 *
 * Without this coverage test, the registry would drift the same way the
 * old hardcoded `ENTRY_POINTS` array did (PR #3836 retrospective): a new
 * Railway service ships and nothing reminds the author to register it.
 *
 * Pattern source: test-ci-gotchas/reference/static-grep-audit-test-
 * undertested-by-only-matching-one-shape — the self-fixture below tests
 * the regex against both Dockerfile `CMD [...]` shape AND the runbook
 * `Start command:` table-cell shape so a future regex simplification
 * cannot silently stop matching one of them.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface RailwayServiceEntry {
  entry: string;
  deployMode: 'nixpacks-root-scripts' | 'nixpacks-root-repo' | 'dockerfile';
  dockerfile?: string;
  service: string;
  documentedAt: string;
}

const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

const registryEntries = new Set(registry.map((r) => r.entry));
const dockerfileMap = new Map(
  registry
    .filter((r) => r.deployMode === 'dockerfile' && r.dockerfile)
    .map((r) => [r.dockerfile!, r.entry]),
);

// Match `CMD ["node", "scripts/<file>"]`. Captures the script path.
const DOCKERFILE_CMD_RE = /^\s*CMD\s+\[\s*"node"\s*,\s*"(scripts\/[^"]+)"\s*\]/m;

// Match runbook lines like `| **Start command** | \`node scripts/foo.mjs\` |`
// (table-cell shape — multiple spaces, backtick quoting around the command).
// Also tolerates `node` paths without backticks in case the runbook drifts.
const RUNBOOK_START_RE = /\|\s*\*\*Start command\*\*\s*\|\s*`?node\s+(scripts\/\S+?\.(?:mjs|cjs|js))`?\s*\|/g;

// Match standalone-service rows like:
//   | seed-fake | `node scripts/seed-fake.mjs` | hourly | Domain |
const RUNBOOK_SERVICE_ROW_RE = /^\|\s*seed-[a-z0-9-]+\s*\|\s*`node\s+(scripts\/[^`]+\.(?:mjs|cjs|js))`\s*\|/gm;

// Match script headers that document a manually provisioned Railway service:
//   - Service name: seed-bundle-foo
// The script filename itself is the start command source for this shape.
const SCRIPT_HEADER_SERVICE_RE = /^\s*\/\/\s*-\s*Service name:\s*([a-z0-9-]+)\s*$/m;

describe('Railway service registry coverage', () => {
  it('every Dockerfile.* CMD has a matching registry entry', () => {
    const dockerfiles = readdirSync(repoRoot)
      .filter((f) => f.startsWith('Dockerfile.'))
      .sort();

    const missing: string[] = [];
    for (const df of dockerfiles) {
      const src = readFileSync(resolve(repoRoot, df), 'utf8');
      const m = src.match(DOCKERFILE_CMD_RE);
      if (!m) continue; // Dockerfile without a scripts/ CMD (e.g., relay multi-stage doesn't apply)
      const entry = m[1]!;
      const registered = dockerfileMap.get(df);
      if (registered !== entry) {
        missing.push(
          `${df} runs '${entry}' but registry has ` +
            (registered ? `'${registered}' for ${df}` : `no entry for ${df}`),
        );
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `Dockerfile CMD lines drift from scripts/railway-services.json:\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          `\n\nEither add the missing entry to the registry (deployMode: ` +
          `"dockerfile", dockerfile: "<Dockerfile.*>") or update the CMD ` +
          `to match the registered script.`,
      );
    }
  });

  it('every runbook Railway command references a registered script', () => {
    const runbookPath = resolve(repoRoot, 'docs/railway-seed-consolidation-runbook.md');
    const src = readFileSync(runbookPath, 'utf8');

    const referenced = new Set<string>();
    let m: RegExpExecArray | null;
    RUNBOOK_START_RE.lastIndex = 0;
    while ((m = RUNBOOK_START_RE.exec(src)) !== null) {
      referenced.add(m[1]!);
    }
    RUNBOOK_SERVICE_ROW_RE.lastIndex = 0;
    while ((m = RUNBOOK_SERVICE_ROW_RE.exec(src)) !== null) {
      referenced.add(m[1]!);
    }
    assert.ok(
      referenced.size > 0,
      `Runbook regex matched zero entries — runbook format may have drifted. ` +
        `Update RUNBOOK_START_RE or RUNBOOK_SERVICE_ROW_RE.`,
    );

    const missing: string[] = [];
    for (const entry of referenced) {
      if (!registryEntries.has(entry)) {
        missing.push(`runbook references '${entry}' but registry has no matching entry`);
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `Runbook entries drift from scripts/railway-services.json:\n` +
          missing.map((s) => `  - ${s}`).join('\n') +
          `\n\nAdd the missing entry to the registry (deployMode: ` +
          `"nixpacks-root-scripts" or "nixpacks-root-repo") or update the runbook.`,
      );
    }
  });

  it('every script header-documented Railway service is registered', () => {
    const missing: string[] = [];
    const scriptFiles = readdirSync(resolve(repoRoot, 'scripts'))
      .filter((f) => /\.(?:mjs|cjs|js)$/.test(f))
      .sort();

    for (const file of scriptFiles) {
      const entry = `scripts/${file}`;
      const src = readFileSync(resolve(repoRoot, entry), 'utf8');
      const m = src.match(SCRIPT_HEADER_SERVICE_RE);
      if (!m) continue;

      const service = m[1]!;
      const registered = registry.find((r) => r.entry === entry);
      if (!registered) {
        missing.push(`${entry} documents Railway service '${service}' but registry has no matching entry`);
        continue;
      }
      if (registered.service !== service) {
        missing.push(
          `${entry} documents Railway service '${service}' but registry service is '${registered.service}'`,
        );
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `Script header-documented Railway services drift from scripts/railway-services.json:\n` +
          missing.map((s) => `  - ${s}`).join('\n') +
          `\n\nAdd the missing entry to the registry or update the documented service header.`,
      );
    }
  });

  // Self-fixture: prove BOTH regex shapes match what they're supposed to.
  // Without this, a future "simplification" of either regex could silently
  // stop matching one shape, and the audit above would pass coincidentally
  // because today's repo happens to lack a violation. Pinned synthetic
  // input ensures the audit stays load-bearing.
  it('DOCKERFILE_CMD_RE matches the documented Dockerfile CMD shape', () => {
    const sample = 'FROM node:22-alpine\nWORKDIR /app\nCMD ["node", "scripts/seed-fake.mjs"]\n';
    const m = sample.match(DOCKERFILE_CMD_RE);
    assert.ok(m, 'DOCKERFILE_CMD_RE failed to match canonical CMD shape');
    assert.equal(m![1], 'scripts/seed-fake.mjs');
  });

  it('RUNBOOK_START_RE matches the documented runbook Start command shape', () => {
    const sample = '| **Start command** | `node scripts/seed-fake.mjs` |\n';
    RUNBOOK_START_RE.lastIndex = 0;
    const m = RUNBOOK_START_RE.exec(sample);
    assert.ok(m, 'RUNBOOK_START_RE failed to match canonical Start command shape');
    assert.equal(m![1], 'scripts/seed-fake.mjs');
  });

  it('RUNBOOK_SERVICE_ROW_RE matches the documented standalone-service shape', () => {
    const sample = '| seed-fake | `node scripts/seed-fake.mjs` | hourly | Fake data |\n';
    RUNBOOK_SERVICE_ROW_RE.lastIndex = 0;
    const m = RUNBOOK_SERVICE_ROW_RE.exec(sample);
    assert.ok(m, 'RUNBOOK_SERVICE_ROW_RE failed to match canonical standalone-service shape');
    assert.equal(m![1], 'scripts/seed-fake.mjs');
  });

  it('SCRIPT_HEADER_SERVICE_RE matches the documented script service header shape', () => {
    const sample = [
      '// Railway service config (set up manually via Railway dashboard or',
      '// `railway service`):',
      '//   - Service name: seed-bundle-fake',
    ].join('\n');
    const m = sample.match(SCRIPT_HEADER_SERVICE_RE);
    assert.ok(m, 'SCRIPT_HEADER_SERVICE_RE failed to match canonical service header shape');
    assert.equal(m![1], 'seed-bundle-fake');
  });
});
