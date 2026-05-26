#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_BASELINE = path.join(repoRoot, 'scripts', 'safe-html-baseline.json');
const TARGET_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx']);
const TARGET_DIRS = ['src'];
const INTERNAL_ALLOWLIST = new Set(['src/utils/dom-utils.ts']);

function parseArgs(argv) {
  const args = {
    root: repoRoot,
    baseline: DEFAULT_BASELINE,
    updateBaseline: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update-baseline') {
      args.updateBaseline = true;
    } else if (arg === '--root') {
      args.root = path.resolve(argv[++i]);
    } else if (arg === '--baseline') {
      args.baseline = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
    } else if (TARGET_EXTENSIONS.has(path.extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

function assignmentRhs(line) {
  const match = line.match(/\.(?:innerHTML|outerHTML)\s*=\s*(.*)$/);
  return match ? match[1].trim() : '';
}

function isClearOperation(line) {
  const rhs = assignmentRhs(line).replace(/;$/, '').trim();
  return rhs === "''" || rhs === '""' || rhs === '``';
}

function hasAuditComment(lines, index) {
  const prev = [lines[index - 1], lines[index - 2]].filter(Boolean).join('\n');
  return /wm-safe-html:\s*audited\s+-\s*\S+/i.test(prev);
}

function fingerprint(file, line) {
  const normalized = line.replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(`${file}\0${normalized}`).digest('hex').slice(0, 16);
  return `${file}:${hash}`;
}

function setContentFingerprint(file, line, lineNumber) {
  const normalized = line.replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(`setContent\0${file}\0${lineNumber}\0${normalized}`).digest('hex').slice(0, 16);
  return `${file}:setContent:${hash}`;
}

function isSetContentCall(line) {
  return /\.\s*setContent\s*\(/.test(line);
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

export function findUnsafeHtmlAssignments(root = repoRoot) {
  const findings = [];

  for (const targetDir of TARGET_DIRS) {
    for (const filePath of walk(path.join(root, targetDir))) {
      const rel = toPosix(path.relative(root, filePath));
      if (INTERNAL_ALLOWLIST.has(rel)) continue;

      const lines = readFileSync(filePath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/\.(?:innerHTML|outerHTML)\s*=/.test(line)) {
          if (isClearOperation(line)) continue;
          if (hasAuditComment(lines, i)) continue;

          findings.push({
            file: rel,
            line: i + 1,
            kind: 'direct-html-assignment',
            code: line.trim(),
            fingerprint: fingerprint(rel, line),
          });
          continue;
        }

        if (isSetContentCall(line)) {
          if (isCommentOnlyLine(line)) continue;
          if (hasAuditComment(lines, i)) continue;

          findings.push({
            file: rel,
            line: i + 1,
            kind: 'panel-set-content',
            code: line.trim(),
            fingerprint: setContentFingerprint(rel, line, i + 1),
          });
        }
      }
    }
  }

  return findings;
}

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return new Set();
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return new Set((parsed.entries ?? []).map(entry => entry.fingerprint));
}

function writeBaseline(baselinePath, findings) {
  const entries = findings
    .map(({ file, line, kind, code, fingerprint }) => ({ file, line, kind, fingerprint, code }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const payload = {
    note: 'Baseline of legacy direct innerHTML/outerHTML assignments and Panel.setContent() call sites for scripts/enforce-safe-html.mjs. Do not add entries for new code; route through src/utils/dom-utils.ts, Panel.setSafeContent(), or add a wm-safe-html audited comment for narrow exceptions.',
    entries,
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const findings = findUnsafeHtmlAssignments(args.root);

  if (args.updateBaseline) {
    writeBaseline(args.baseline, findings);
    console.log(`Updated ${path.relative(args.root, args.baseline)} with ${findings.length} legacy HTML assignments.`);
    return;
  }

  const baseline = readBaseline(args.baseline);
  const newFindings = findings.filter(finding => !baseline.has(finding.fingerprint));
  if (newFindings.length === 0) {
    console.log(`Safe HTML guard passed (${findings.length} legacy HTML sinks tracked).`);
    return;
  }

  console.error('Direct innerHTML/outerHTML assignment is blocked.');
  console.error('Panel.setContent() calls are also blocked unless they are already baselined or have an adjacent `wm-safe-html: audited - ...` comment.');
  console.error('Use setTrustedHtml()/trustedHtml() from src/utils/dom-utils.ts, Panel.setSafeContent(), use clearChildren()/replaceChildren(), or add an adjacent audit comment for a narrow intentional exception.');
  for (const finding of newFindings.slice(0, 25)) {
    console.error(`- ${finding.file}:${finding.line} [${finding.kind}]: ${finding.code}`);
  }
  if (newFindings.length > 25) {
    console.error(`...and ${newFindings.length - 25} more.`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
