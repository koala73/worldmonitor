import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const source = readFileSync(new URL('../pro-test/src/App.tsx', import.meta.url), 'utf8');
const signalBars = source.match(/const SignalBars = \(\) => \{[\s\S]*?\n\};\n\nconst Hero = \(\) => \{/);

function previousSignificantChar(sourceText, index) {
  for (let i = index - 1; i >= 0; i--) {
    const ch = sourceText[i];
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

function canStartRegex(sourceText, index) {
  return !/[)\]\w$]/.test(previousSignificantChar(sourceText, index));
}

function findMatchingBrace(sourceText, braceStart) {
  let depth = 0;
  let state = 'code';
  let regexCharClass = false;

  for (let i = braceStart; i < sourceText.length; i++) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i++;
      }
      continue;
    }

    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (
        (state === 'single-quote' && ch === "'") ||
        (state === 'double-quote' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (state === 'regex') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '[') regexCharClass = true;
      else if (ch === ']') regexCharClass = false;
      else if (ch === '/' && !regexCharClass) state = 'code';
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i++;
      continue;
    }
    if (ch === "'") {
      state = 'single-quote';
      continue;
    }
    if (ch === '"') {
      state = 'double-quote';
      continue;
    }
    if (ch === '`') {
      state = 'template';
      continue;
    }
    if (ch === '/' && canStartRegex(sourceText, i)) {
      state = 'regex';
      regexCharClass = false;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function findStatementEnd(sourceText, statementStart) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let state = 'code';
  let regexCharClass = false;

  for (let i = statementStart; i < sourceText.length; i++) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i++;
      }
      continue;
    }

    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (
        (state === 'single-quote' && ch === "'") ||
        (state === 'double-quote' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (state === 'regex') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '[') regexCharClass = true;
      else if (ch === ']') regexCharClass = false;
      else if (ch === '/' && !regexCharClass) state = 'code';
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i++;
      continue;
    }
    if (ch === "'") {
      state = 'single-quote';
      continue;
    }
    if (ch === '"') {
      state = 'double-quote';
      continue;
    }
    if (ch === '`') {
      state = 'template';
      continue;
    }
    if (ch === '/' && canStartRegex(sourceText, i)) {
      state = 'regex';
      regexCharClass = false;
      continue;
    }

    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === ';' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) return i;
  }

  return -1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localInitializerForIdentifier(body, identifier) {
  const declarationPattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(identifier)}\\s*=`, 'g');
  const match = declarationPattern.exec(body);
  if (!match) return null;

  let initializerStart = match.index + match[0].length;
  while (/\s/.test(body[initializerStart])) initializerStart++;
  const initializerEnd = findStatementEnd(body, initializerStart);
  assert.ok(initializerEnd > initializerStart, `${identifier} initializer must end with a semicolon`);

  return body.slice(initializerStart, initializerEnd).trim();
}

function collectLocalAnimateSources(body, sourceText, sources, visited) {
  for (const match of sourceText.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const identifier = match[0];
    if (visited.has(identifier)) continue;

    const initializer = localInitializerForIdentifier(body, identifier);
    if (!initializer) continue;

    visited.add(identifier);
    sources.push({ label: `local ${identifier}`, text: initializer });
    collectLocalAnimateSources(body, initializer, sources, visited);
  }
}

function animateSources(body) {
  const animateStart = body.indexOf('animate={');
  assert.ok(animateStart >= 0, 'SignalBars must render a motion.div animate prop');
  const expressionStart = body.indexOf('{', animateStart);
  const expressionEnd = findMatchingBrace(body, expressionStart);
  assert.ok(expressionEnd > expressionStart, 'animate prop expression must have balanced braces');

  const expression = body.slice(expressionStart + 1, expressionEnd - 1).trim();
  const sources = [{ label: 'animate prop', text: expression }];
  const visited = new Set();
  collectLocalAnimateSources(body, expression, sources, visited);

  if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
    assert.ok(visited.has(expression), `animate={${expression}} must resolve to a local initializer`);
  }

  return sources;
}

function assertNoAnimatedHeight(body) {
  // This remains a source guard, but it follows local animate={identifier} hoists
  // so a named height keyframe object cannot silently bypass the check.
  for (const { label, text } of animateSources(body)) {
    assert.doesNotMatch(
      text,
      /(?:^|[,{]\s*)height\s*:/,
      `SignalBars must not animate height in ${label}; mobile DebugBear reports this as forced layout work.`,
    );
  }
}

test('/pro SignalBars keeps hero animation on compositor-friendly transforms', () => {
  assert.ok(signalBars, 'SignalBars source block should be present');
  const body = signalBars[0];

  assert.match(body, /scaleY/, 'bars should animate scaleY instead of layout height');
  assert.match(body, /transformOrigin:\s*'bottom'/, 'bars should scale from the baseline');
  assertNoAnimatedHeight(body);
});

test('/pro SignalBars source guard follows hoisted animate objects', () => {
  const body = `
    const heightAnimate = {
      height: [8, 24],
      opacity: [0.2, 1],
    };
    return <motion.div animate={heightAnimate} transition={{ repeat: Infinity }} />;
  `;

  assert.throws(
    () => assertNoAnimatedHeight(body),
    /must not animate height in local heightAnimate/,
    'hoisted height animations must fail the regression guard',
  );
});
