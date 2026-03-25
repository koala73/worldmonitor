#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function parseFileList(output) {
  return output
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

function isMissingCommand(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function listTrackedYamlFiles() {
  try {
    const output = execFileSync('rg', [
      '--files',
      '-g',
      '*.yml',
      '-g',
      '*.yaml',
      '-g',
      '!node_modules/**',
      '-g',
      '!dist/**',
      '-g',
      '!src-tauri/target/**',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return parseFileList(output);
  } catch (error) {
    if (!isMissingCommand(error)) throw error;
    const output = execFileSync('git', [
      'ls-files',
      '--',
      '*.yml',
      '*.yaml',
      ':(exclude)node_modules/**',
      ':(exclude)dist/**',
      ':(exclude)src-tauri/target/**',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return parseFileList(output);
  }
}

function resolveRuby() {
  try {
    return execFileSync('bash', ['-lc', 'command -v ruby'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

const RUBY_LINT_SCRIPT = `
require "psych"

errors = []
ARGV.each do |path|
  begin
    Psych.parse_stream(File.read(path), filename: path)
  rescue Psych::SyntaxError => error
    line = error.line || 1
    column = error.column || 1
    errors << "#{path}:#{line}:#{column} #{error.problem}"
  rescue => error
    errors << "#{path}: #{error.class}: #{error.message}"
  end
end

if errors.empty?
  puts "[lint:yaml] Parsed #{ARGV.length} tracked YAML file(s)."
  exit 0
end

warn "[lint:yaml] Invalid YAML detected:"
errors.each { |error| warn "- #{error}" }
exit 1
`;

function main() {
  const files = listTrackedYamlFiles();
  if (files.length === 0) {
    console.log('[lint:yaml] No tracked YAML files found.');
    return;
  }

  const ruby = resolveRuby();
  if (!ruby) {
    console.error('[lint:yaml] Ruby is required to parse YAML files but was not found on PATH.');
    process.exit(1);
  }

  const result = spawnSync(ruby, ['-e', RUBY_LINT_SCRIPT, ...files], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();
