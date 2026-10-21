import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function flattenValues(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => flattenValues(child, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => (
      flattenValues(child, prefix ? `${prefix}.${key}` : key)
    ));
  }
  return [[prefix, String(value ?? '')]];
}

function interpolationTokens(value) {
  return [...value.matchAll(/\{\{[^}]+\}\}/g)].map(([token]) => token).sort();
}

function htmlStructure(value) {
  return [...value.matchAll(/<\/?[a-z][^>]*>/gi)].map(([tag]) => (
    tag.toLowerCase().replace(/\s+/g, ' ').replace(/\s*=\s*/g, '=').trim()
  ));
}

function protectedPaths(value) {
  return [...value.matchAll(/https?:\/\/[^\s"'<>]+|\/docs\/[A-Za-z0-9._~/-]+/g)]
    .map(([path]) => path.replace(/[),.;:]+$/g, ''))
    .sort();
}

describe('Swahili locale contracts', () => {
  const english = Object.fromEntries(
    flattenValues(JSON.parse(readFileSync(join(ROOT, 'src/locales/en.json'), 'utf8'))),
  );
  const swahili = Object.fromEntries(
    flattenValues(JSON.parse(readFileSync(join(ROOT, 'src/locales/sw.json'), 'utf8'))),
  );

  it('preserves interpolation tokens', () => {
    const failures = [];
    for (const [key, value] of Object.entries(english)) {
      const expected = interpolationTokens(value);
      const actual = interpolationTokens(swahili[key] ?? '');
      if (JSON.stringify(expected) !== JSON.stringify(actual)) failures.push({ key, expected, actual });
    }
    assert.deepEqual(failures, []);
  });

  it('preserves rich-text tag structure', () => {
    const failures = [];
    for (const [key, value] of Object.entries(english)) {
      const expected = htmlStructure(value);
      const actual = htmlStructure(swahili[key] ?? '');
      if (JSON.stringify(expected) !== JSON.stringify(actual)) failures.push({ key, expected, actual });
    }
    assert.deepEqual(failures, []);
  });

  it('preserves protected documentation and external paths', () => {
    const failures = [];
    for (const [key, value] of Object.entries(english)) {
      const expected = protectedPaths(value);
      const actual = protectedPaths(swahili[key] ?? '');
      if (JSON.stringify(expected) !== JSON.stringify(actual)) failures.push({ key, expected, actual });
    }
    assert.deepEqual(failures, []);
  });
});
