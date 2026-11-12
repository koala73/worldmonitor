#!/usr/bin/env node
// Review inventory, not a proof of bounded execution: a signal can be plain
// cancellation, and an SDK can hide retries or stop its timer at headers.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';

const excluded = /(?:^|\/)(?:node_modules|vendor|generated|tests?|e2e|demos)(?:\/|$)|\.(?:test|spec)\.|-test-preload\./;
// -z: NUL-separated raw paths. Newline output C-quotes non-ASCII names
// (e.g. "r\303\251sum\303\251.md"), which readFileSync cannot open.
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter(file => file && !excluded.test(file));
const records = [];

for (const file of files) {
  if (!/\.(?:[cm]?js|[cm]?ts|tsx|rs|py|rb|go|sh)$/.test(file) || !existsSync(file)) continue;
  const code = readFileSync(file, 'utf8');
  if (!/\.(?:[cm]?js|[cm]?ts|tsx)$/.test(file)) {
    // Keep non-JS network boundaries visible for manual review as well.
    if (/\.(?:rs|py|rb|go|sh)$/.test(file)) {
      code.split('\n').forEach((line, index) => {
        if (/\b(?:curl|urlopen|opener\.open|http\.Do|http\.Client|http_transport|reqwest::Client)\b|\.send\(\)/.test(line)) {
          records.push({ file, line: index + 1, kind: 'native-language-review', expression: line.trim() });
        }
      });
    }
    continue;
  }
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const record = (node, kind, extra = {}) => records.push({
    file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    kind, expression: node.expression?.getText(source), ...extra,
  });
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (/^(?:(?:globalThis|window|global|self)\.)?fetch$/.test(expression)) {
        const options = node.arguments[1];
        const signal = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(prop => prop.name?.getText(source) === 'signal') : undefined;
        const spread = options && ts.isObjectLiteralExpression(options)
          && options.properties.some(ts.isSpreadAssignment);
        record(node, node.arguments.some(ts.isSpreadElement) ? 'forwarding-fetch'
          : signal ? 'fetch-with-signal-review-deadline'
            : spread || (options && !ts.isObjectLiteralExpression(options)) ? 'fetch-options-forwarded-review'
              : 'fetch-missing-signal', {
          target: node.arguments[0]?.getText(source),
          signal: signal?.getText(source),
        });
      } else if (/^(?:(?:https?|transport)\.(?:request|get)|httpsGet(?:Fn)?|requestFn|fetchImpl|fetchFn)$/.test(expression)
        || /\.(?:messages\.(?:create|stream)|emails\.send|send|query|connect)$/.test(expression)) {
        record(node, 'transport-or-sdk-call-review');
      }
    } else if (ts.isNewExpression(node) && /(?:Redis|Pool|Agent|Anthropic|OpenAI|S3Client|ConvexHttpClient|Resend|DodoPayments|WebSocket)$/.test(node.expression.getText(source))) {
      record(node, 'client-configuration-review', { options: node.arguments?.map(arg => arg.getText(source)) });
    } else if ((ts.isForStatement(node) || ts.isWhileStatement(node))
      && /\b(?:attempt|retries|retryCount)\b/i.test(node.condition?.getText(source) ?? '')) {
      let fn = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      records.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        kind: 'retry-loop-review', function: fn?.name?.getText(source),
        condition: node.condition?.getText(source) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const counts = {};
for (const record of records) counts[record.kind] = (counts[record.kind] ?? 0) + 1;

// --check is the CI gate: a fetch() with no options object and no signal has
// no deadline at all. Every other kind is a review prompt, not a failure.
if (process.argv.includes('--check')) {
  const missing = records.filter(record => record.kind === 'fetch-missing-signal');
  if (missing.length > 0) {
    for (const record of missing) process.stderr.write(`${record.file}:${record.line} fetch(${record.target ?? ''}) has no signal\n`);
    process.stderr.write(`\n${missing.length} fetch call(s) without a signal. Pass a deadline, e.g. { signal: AbortSignal.timeout(ms) }.\n`);
    process.exit(1);
  }
  process.stdout.write(`audit-outbound-calls: no fetch without a signal (${counts['fetch-with-signal-review-deadline'] ?? 0} with a signal)\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({
  scope: 'Tracked and unignored application, worker, CLI and SDK source; excludes generated, vendor, tests and demos',
  limits: 'Static candidates only. Review signal ownership, body consumption, SDK internals, replay safety, caller budgets and deployment concurrency.',
  counts, records,
}, null, 2)}\n`);
