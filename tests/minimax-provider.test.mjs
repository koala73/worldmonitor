/**
 * Tests for MiniMax LLM provider implementation.
 *
 * Verifies:
 * - Provider credential resolution
 * - API URL construction
 * - Model configuration
 * - Header configuration
 * - Environment variable handling
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
// Source code verification tests
// ========================================================================

describe('MiniMax provider: source code verification', () => {
  const src = readSrc('server/worldmonitor/news/v1/_shared.ts');

  it('includes minimax provider in getProviderCredentials', () => {
    assert.match(src, /if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)/,
      'Should have minimax provider case in getProviderCredentials');
  });

  it('reads MINIMAX_API_KEY from environment', () => {
    assert.match(src, /process\.env\.MINIMAX_API_KEY/,
      'Should read MINIMAX_API_KEY from environment');
  });

  it('returns null when MINIMAX_API_KEY is not set', () => {
    assert.match(src, /const apiKey = process\.env\.MINIMAX_API_KEY;[\s\S]*?if \(!apiKey\) return null;/,
      'Should return null when API key is not configured');
  });

  it('supports custom MINIMAX_API_URL', () => {
    assert.match(src, /process\.env\.MINIMAX_API_URL/,
      'Should support custom MINIMAX_API_URL');
  });

  it('uses default API URL when not specified', () => {
    assert.match(src, /https:\/\/api\.minimax\.io\/v1/,
      'Should use https://api.minimax.io/v1 as default base URL');
  });

  it('constructs correct chat completions endpoint', () => {
    assert.match(src, /\/chat\/completions/,
      'Should construct /chat/completions endpoint');
  });

  it('supports custom MINIMAX_MODEL', () => {
    assert.match(src, /process\.env\.MINIMAX_MODEL/,
      'Should support custom MINIMAX_MODEL');
  });

  it('uses MiniMax-M2.5 as default model', () => {
    assert.match(src, /MiniMax-M2\.5/,
      'Should use MiniMax-M2.5 as default model');
  });

  it('sets Authorization header with Bearer token', () => {
    const minimaxSection = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)[\s\S]*?return\s*\{[\s\S]*?\};/);
    assert.ok(minimaxSection, 'Should have minimax provider section');
    assert.match(minimaxSection[0], /Authorization.*Bearer.*apiKey/,
      'Should set Authorization header with Bearer token');
  });

  it('sets Content-Type header to application/json', () => {
    const minimaxSection = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)[\s\S]*?return\s*\{[\s\S]*?\};/);
    assert.ok(minimaxSection, 'Should have minimax provider section');
    assert.match(minimaxSection[0], /Content-Type.*application\/json/,
      'Should set Content-Type header to application/json');
  });
});

// ========================================================================
// Summarize article handler verification
// ========================================================================

describe('MiniMax provider: summarize-article handler', () => {
  const src = readSrc('server/worldmonitor/news/v1/summarize-article.ts');

  it('includes minimax in skipReasons', () => {
    assert.match(src, /minimax:\s*['"]MINIMAX_API_KEY not configured['"]/,
      'Should have skip reason for minimax when API key is not configured');
  });
});

// ========================================================================
// Credential resolution logic verification (static analysis)
// ========================================================================

describe('MiniMax provider: credential resolution logic', () => {
  const src = readSrc('server/worldmonitor/news/v1/_shared.ts');

  it('returns null when API key is not present (guard clause)', () => {
    const minimaxBlock = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/);
    assert.ok(minimaxBlock, 'Should have minimax provider block');
    assert.match(minimaxBlock[0], /if\s*\(\s*!apiKey\s*\)\s*return\s*null/,
      'Should return null when API key is not set');
  });

  it('constructs API URL using URL constructor', () => {
    const minimaxBlock = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/);
    assert.ok(minimaxBlock, 'Should have minimax provider block');
    assert.match(minimaxBlock[0], /new URL\(['"]\/chat\/completions['"],\s*baseUrl\)/,
      'Should use URL constructor to build chat/completions endpoint');
  });

  it('uses environment variable fallback pattern for base URL', () => {
    const minimaxBlock = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/);
    assert.ok(minimaxBlock, 'Should have minimax provider block');
    assert.match(minimaxBlock[0], /process\.env\.MINIMAX_API_URL\s*\|\|\s*['"]https:\/\/api\.minimax\.io\/v1['"]/,
      'Should use env var with default fallback for API URL');
  });

  it('uses environment variable fallback pattern for model', () => {
    const minimaxBlock = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/);
    assert.ok(minimaxBlock, 'Should have minimax provider block');
    assert.match(minimaxBlock[0], /process\.env\.MINIMAX_MODEL\s*\|\|\s*['"]MiniMax-M2\.5['"]/,
      'Should use env var with default fallback for model');
  });

  it('does not include extraBody property (unlike ollama)', () => {
    const minimaxBlock = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/);
    assert.ok(minimaxBlock, 'Should have minimax provider block');
    assert.doesNotMatch(minimaxBlock[0], /extraBody/,
      'Should not have extraBody property (minimax does not need it)');
  });

  it('uses template literal for Authorization header', () => {
    const minimaxBlock = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/);
    assert.ok(minimaxBlock, 'Should have minimax provider block');
    assert.match(minimaxBlock[0], /Authorization.*`Bearer \$\{apiKey\}`/,
      'Should use template literal for Bearer token');
  });
});

// ========================================================================
// Provider comparison tests
// ========================================================================

describe('MiniMax provider: comparison with other providers', () => {
  const src = readSrc('server/worldmonitor/news/v1/_shared.ts');

  it('follows same structure as groq provider', () => {
    const groqMatch = src.match(/if\s*\(\s*provider\s*===\s*['"]groq['"]\s*\)[\s\S]*?return\s*\{[\s\S]*?\};/);
    const minimaxMatch = src.match(/if\s*\(\s*provider\s*===\s*['"]minimax['"]\s*\)[\s\S]*?return\s*\{[\s\S]*?\};/);
    
    assert.ok(groqMatch, 'Should have groq provider');
    assert.ok(minimaxMatch, 'Should have minimax provider');
    
    assert.match(minimaxMatch[0], /apiUrl:/i, 'minimax should have apiUrl like groq');
    assert.match(minimaxMatch[0], /model:/i, 'minimax should have model like groq');
    assert.match(minimaxMatch[0], /headers:/i, 'minimax should have headers like groq');
  });

  it('is listed alongside other cloud providers', () => {
    const cloudProviders = ['groq', 'openrouter', 'minimax'];
    for (const provider of cloudProviders) {
      assert.match(src, new RegExp(`provider\\s*===\\s*['"]${provider}['"]`),
        `Should have ${provider} as a cloud provider option`);
    }
  });
});

// ========================================================================
// Settings integration tests
// ========================================================================

describe('MiniMax provider: settings integration', () => {
  it('is listed in settings-constants.ts', () => {
    const settingsSrc = readSrc('src/services/settings-constants.ts');
    assert.match(settingsSrc, /minimax/i,
      'Should be referenced in settings-constants.ts');
  });

  it('is handled in runtime-config.ts', () => {
    const runtimeSrc = readSrc('src/services/runtime-config.ts');
    assert.match(runtimeSrc, /minimax/i,
      'Should be handled in runtime-config.ts');
  });

  it('is supported in summarization.ts', () => {
    const summarizationSrc = readSrc('src/services/summarization.ts');
    assert.match(summarizationSrc, /minimax/i,
      'Should be supported in summarization.ts');
  });
});
