import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PLACEHOLDER_TOKENS = [
  'example',
  'placeholder',
  'sample',
  'dummy',
  'fake',
  'changeme',
  'replace-me',
  'replace_me',
  'replace-with',
  'your-',
  'your_',
  'your ',
  'app-specific-password',
  'security-test',
  'test-token',
  '<',
  '>',
];

const HIGH_CONFIDENCE_PATTERNS = [
  { label: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'GitHub personal token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'OpenAI key', regex: /\bsk-(?:proj|live|test)-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'Anthropic key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'Google API key', regex: /\bAIza[0-9A-Za-z\\-_]{35}\b/g },
  { label: 'Private key material', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |)?PRIVATE KEY-----/g },
];

const STRUCTURED_SECRET_NAMES = new Set([
  'ABUSEIPDB_API_KEY',
  'ACLED_ACCESS_TOKEN',
  'AISSTREAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'APPLE_PASSWORD',
  'CLOUDFLARE_API_TOKEN',
  'EIA_API_KEY',
  'FINNHUB_API_KEY',
  'FRED_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GROQ_API_KEY',
  'ICAO_API_KEY',
  'NASA_FIRMS_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENSKY_CLIENT_SECRET',
  'OTX_API_KEY',
  'RELAY_SHARED_SECRET',
  'TAURI_BUNDLE_WINDOWS_CERTIFICATE',
  'TAURI_BUNDLE_WINDOWS_CERTIFICATE_PASSWORD',
  'THREATFOX_API_KEY',
  'URLHAUS_AUTH_KEY',
  'WINGBITS_API_KEY',
  'WTO_API_KEY',
]);

const STRUCTURED_ASSIGNMENT_PATTERNS = [
  /(?:^|\s|["'`])(?<name>[A-Z][A-Z0-9_]{2,})\s*=\s*(?<quote>["'`]?)(?<value>[^\s"'`#]+)\k<quote>/g,
  /(?:^|\s|["'`])(?<name>[A-Z][A-Z0-9_]{2,})\s*:\s*(?<quote>["'`]?)(?<value>[^\s"'`,]+)\k<quote>/g,
  /process\.env\.(?<name>[A-Z][A-Z0-9_]{2,})\s*=\s*(?<quote>["'`])(?<value>[^"'`]+)\k<quote>/g,
];

const COLON_STRUCTURED_EXTENSIONS = new Set([
  '.env',
  '.example',
  '.ini',
  '.json',
  '.md',
  '.plist',
  '.properties',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);

const TEXT_FILE_EXTENSIONS = new Set([
  '.cjs',
  '.conf',
  '.css',
  '.env',
  '.example',
  '.gitignore',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.pem',
  '.plist',
  '.properties',
  '.rs',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
  '.zsh',
  '.key',
]);

function findRepoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

function parseArgs(argv) {
  const options = {
    mode: 'repo',
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--staged') {
      options.mode = 'staged';
      continue;
    }

    if (arg === '--files') {
      options.mode = 'files';
      options.files = argv.slice(index + 1);
      break;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function listRepoFiles(repoRoot) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((filePath) => filePath.trim())
    .filter(Boolean)
    .map((filePath) => path.join(repoRoot, filePath));
}

function listStagedFiles(repoRoot) {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((filePath) => filePath.trim())
    .filter(Boolean)
    .map((filePath) => path.join(repoRoot, filePath));
}

function normalizeFiles(files) {
  return [...new Set(files.map((filePath) => path.resolve(filePath)))];
}

function isLikelyTextFile(filePath) {
  const ext = path.extname(filePath);
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
  const baseName = path.basename(filePath);
  if (baseName === '.env' || baseName.startsWith('.env.')) return true;
  return false;
}

function isBinaryContent(content) {
  return content.includes('\u0000');
}

function isTestLikeFile(filePath) {
  return /(?:^|\/)(tests?|e2e)\//.test(filePath) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function isPlaceholderValue(value) {
  if (!value) return true;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith('${') || normalized.startsWith('$(')) return true;
  if (normalized === 'null' || normalized === 'undefined') return true;
  if (PLACEHOLDER_TOKENS.some((token) => normalized.includes(token))) return true;
  if (/^x{8,}$/i.test(normalized)) return true;
  if (/^[a-z]+:\/\//.test(normalized)) return true;
  return false;
}

function isStructuredSecretName(name) {
  if (STRUCTURED_SECRET_NAMES.has(name)) return true;
  if (/(?:^|_)(?:PASSWORD|SECRET|PRIVATE_KEY|AUTH_KEY)$/.test(name)) return true;
  if (/(?:^|_)(?:TOKEN)$/.test(name) && !name.startsWith('VITE_')) return true;
  return false;
}

function scanHighConfidencePatterns(content, filePath) {
  const findings = [];

  for (const { label, regex } of HIGH_CONFIDENCE_PATTERNS) {
    regex.lastIndex = 0;
    const match = regex.exec(content);
    if (!match) continue;
    findings.push({
      filePath,
      line: lineNumberForIndex(content, match.index),
      reason: label,
      snippet: match[0],
    });
  }

  return findings;
}

function scanStructuredAssignments(content, filePath) {
  const findings = [];
  const ext = path.extname(filePath);
  const patterns = COLON_STRUCTURED_EXTENSIONS.has(ext)
    ? STRUCTURED_ASSIGNMENT_PATTERNS
    : [STRUCTURED_ASSIGNMENT_PATTERNS[0], STRUCTURED_ASSIGNMENT_PATTERNS[2]];

  for (const regex of patterns) {
    regex.lastIndex = 0;
    for (const match of content.matchAll(regex)) {
      const groups = match.groups ?? {};
      const name = groups.name;
      const value = groups.value ?? '';
      if (value.startsWith('process.env.') || value.startsWith('import.meta.env.')) {
        continue;
      }
      if (!name || !isStructuredSecretName(name) || isPlaceholderValue(value)) {
        continue;
      }

      findings.push({
        filePath,
        line: lineNumberForIndex(content, match.index ?? 0),
        reason: `Structured secret assignment for ${name}`,
        snippet: `${name}=${value}`,
      });
    }
  }

  return findings;
}

function lineNumberForIndex(content, index) {
  return content.slice(0, index).split('\n').length;
}

function hasExplicitAllow(line) {
  return line.includes('secret-scan: allow');
}

function filterWaivedFindings(content, findings) {
  if (!findings.length) return findings;
  const lines = content.split('\n');
  return findings.filter((finding) => !hasExplicitAllow(lines[finding.line - 1] ?? ''));
}

function scanFile(filePath) {
  if (!existsSync(filePath)) return [];
  if (!statSync(filePath).isFile()) return [];
  if (!isLikelyTextFile(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  if (isBinaryContent(content)) return [];

  const highConfidenceFindings = scanHighConfidencePatterns(content, filePath);
  const structuredFindings = isTestLikeFile(filePath)
    ? []
    : scanStructuredAssignments(content, filePath);

  return filterWaivedFindings(content, [...highConfidenceFindings, ...structuredFindings]);
}

function formatFinding(repoRoot, finding) {
  const relativePath = path.relative(repoRoot, finding.filePath) || path.basename(finding.filePath);
  return `${relativePath}:${finding.line} ${finding.reason} (${finding.snippet})`;
}

function main() {
  const repoRoot = findRepoRoot();
  const options = parseArgs(process.argv.slice(2));
  const files =
    options.mode === 'staged'
      ? listStagedFiles(repoRoot)
      : (options.mode === 'files'
        ? options.files
        : listRepoFiles(repoRoot));

  const findings = normalizeFiles(files).flatMap((filePath) => scanFile(filePath));

  if (findings.length) {
    const report = findings.map((finding) => `- ${formatFinding(repoRoot, finding)}`).join('\n');
    console.error(`Secret scan failed.\n${report}`);
    process.exit(1);
  }

  console.log(`Secret scan passed for ${normalizeFiles(files).length} file(s).`);
}

main();
