/**
 * Tests for Ollama thinking token / reasoning leak fixes.
 *
 * Verifies:
 * - message.reasoning fallback is removed (Fix 1)
 * - Multiple thinking tag formats are stripped (Fix 2)
 * - Plain-text reasoning preambles are detected (Fix 3)
 * - Mode guard only applies to brief/analysis (Fix 3)
 * - Cache version bumped to v4 (Fix 4)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// Fix 1: message.reasoning fallback removed
// ========================================================================

describe('Fix 1: message.reasoning fallback', () => {
  const src = readSrc('server/worldmonitor/news/v1/summarize-article.ts');

  it('does NOT fall back to message.reasoning', () => {
    assert.doesNotMatch(src, /message\?\.reasoning/,
      'Should not reference message.reasoning — reasoning tokens must never be used as summary');
  });

  it('only uses message.content', () => {
    assert.match(src, /message\?\.content/,
      'Should extract content from message.content');
  });
});

// ========================================================================
// Fix 2: Extended tag stripping
// ========================================================================

describe('Fix 2: thinking tag stripping formats', () => {
  const src = readSrc('server/worldmonitor/news/v1/summarize-article.ts');

  it('strips <think> tags', () => {
    assert.match(src, /<think>/i, 'Should handle <think> tags');
  });

  it('strips <|thinking|> tags', () => {
    assert.ok(src.includes('\\|thinking\\|'), 'Should handle <|thinking|> tags');
  });

  it('strips <reasoning> tags', () => {
    assert.match(src, /<reasoning>/, 'Should handle <reasoning> tags');
  });

  it('strips <reflection> tags', () => {
    assert.match(src, /<reflection>/, 'Should handle <reflection> tags');
  });

  it('handles unterminated <think> blocks', () => {
    // Second .replace block should have <think> without closing tag pattern
    const lines = src.split('\n');
    const unterminatedSection = lines.findIndex(l => l.includes('Strip unterminated'));
    assert.ok(unterminatedSection > -1, 'Should have unterminated block stripping section');
    const sectionSlice = lines.slice(unterminatedSection, unterminatedSection + 8).join('\n');
    assert.ok(sectionSlice.includes('<think>'), 'Should strip unterminated <think>');
  });

  it('handles unterminated <|thinking|> blocks', () => {
    const lines = src.split('\n');
    const unterminatedSection = lines.findIndex(l => l.includes('Strip unterminated'));
    const sectionSlice = lines.slice(unterminatedSection, unterminatedSection + 8).join('\n');
    assert.ok(sectionSlice.includes('\\|thinking\\|'), 'Should strip unterminated <|thinking|>');
  });

  it('handles unterminated <reasoning> blocks', () => {
    const lines = src.split('\n');
    const unterminatedSection = lines.findIndex(l => l.includes('Strip unterminated'));
    const sectionSlice = lines.slice(unterminatedSection, unterminatedSection + 8).join('\n');
    assert.ok(sectionSlice.includes('<reasoning>'), 'Should strip unterminated <reasoning>');
  });

  it('handles unterminated <reflection> blocks', () => {
    const lines = src.split('\n');
    const unterminatedSection = lines.findIndex(l => l.includes('Strip unterminated'));
    const sectionSlice = lines.slice(unterminatedSection, unterminatedSection + 8).join('\n');
    assert.ok(sectionSlice.includes('<reflection>'), 'Should strip unterminated <reflection>');
  });
});

// ========================================================================
// Fix 3: Reasoning preamble detection
// ========================================================================

describe('Fix 3: hasReasoningPreamble', () => {
  const src = readSrc('server/worldmonitor/news/v1/summarize-article.ts');

  // Extract production regexes from source to avoid drift between test and implementation.
  // Pattern: `export const TASK_NARRATION = /.../.../;`
  function extractRegex(source, name) {
    const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(/[^;]+/[gimsuy]*)`));
    if (!match) throw new Error(`Could not extract ${name} from source`);
    const [, full] = match;
    const lastSlash = full.lastIndexOf('/');
    const pattern = full.slice(1, lastSlash);
    const flags = full.slice(lastSlash + 1);
    return new RegExp(pattern, flags);
  }

  const TASK_NARRATION = extractRegex(src, 'TASK_NARRATION');
  const PROMPT_ECHO = extractRegex(src, 'PROMPT_ECHO');

  function hasReasoningPreamble(text) {
    const trimmed = text.trim();
    return TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed);
  }

  // Task narration patterns
  it('detects "We need to summarize..."', () => {
    assert.ok(hasReasoningPreamble('We need to summarize the top story.'));
  });

  it('detects "Let me analyze..."', () => {
    assert.ok(hasReasoningPreamble('Let me analyze these headlines.'));
  });

  it('detects "I should lead with..."', () => {
    assert.ok(hasReasoningPreamble('I should lead with what happened.'));
  });

  it('detects "So we need to..."', () => {
    assert.ok(hasReasoningPreamble('So we need to lead with WHAT happened and WHERE.'));
  });

  it('detects "Okay, I\'ll summarize..."', () => {
    assert.ok(hasReasoningPreamble("Okay, I'll summarize the top story."));
  });

  it('detects "Okay, let me..."', () => {
    assert.ok(hasReasoningPreamble('Okay, let me analyze these headlines.'));
  });

  it('detects "Sure, here is..."', () => {
    assert.ok(hasReasoningPreamble('Sure, here is the summary.'));
  });

  it('passes "Okay" without reasoning continuation', () => {
    assert.ok(!hasReasoningPreamble('Okay results from the summit are mixed.'));
  });

  // Prompt echo patterns
  it('detects "Summarize the top story..."', () => {
    assert.ok(hasReasoningPreamble('Summarize the top story: the headline says...'));
  });

  it('detects "The top story is likely..."', () => {
    assert.ok(hasReasoningPreamble('The top story is likely the first headline about Russia.'));
  });

  it('detects "Rules:" echo', () => {
    assert.ok(hasReasoningPreamble('Rules: lead with WHAT happened'));
  });

  // Valid summaries that must NOT be detected
  it('passes clean geopolitical summary', () => {
    assert.ok(!hasReasoningPreamble("Iran's nuclear program faces increased international scrutiny."));
  });

  it('passes clean event summary', () => {
    assert.ok(!hasReasoningPreamble('The US Treasury announced new sanctions against Russian entities.'));
  });

  it('passes clean protest summary', () => {
    assert.ok(!hasReasoningPreamble('Protests erupted in multiple cities across France.'));
  });

  it('passes summary starting with country name', () => {
    assert.ok(!hasReasoningPreamble('Russia has escalated its nuclear rhetoric.'));
  });

  // Mode guard
  it('is gated to brief and analysis modes in source', () => {
    assert.match(src, /\['brief',\s*'analysis'\]\.includes\(mode\)/,
      'Reasoning preamble check must be gated to brief/analysis modes');
  });

  it('does not apply to translate mode', () => {
    assert.doesNotMatch(src, /mode\s*!==\s*'translate'.*hasReasoningPreamble/,
      'Should NOT use negation-based mode guard');
  });
});

// ========================================================================
// Fix 4: Cache version bump
// ========================================================================

describe('Fix 4: cache version bump', () => {
  const src = readSrc('server/worldmonitor/news/v1/_shared.ts');

  it('CACHE_VERSION is v4', () => {
    assert.match(src, /CACHE_VERSION\s*=\s*'v4'/,
      'CACHE_VERSION must be v4 to invalidate polluted entries');
  });
});
