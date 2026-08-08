import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const configSource = readFileSync(
  fileURLToPath(new URL('../src/config/military.ts', import.meta.url)),
  'utf8',
);
const serviceSource = readFileSync(
  fileURLToPath(new URL('../src/services/military-flights.ts', import.meta.url)),
  'utf8',
);

describe('browser military hex confidence', () => {
  it('treats exact observed aircraft as high confidence while ranges remain medium', () => {
    assert.match(
      configSource,
      /if \(exact\) return \{ \.\.\.exact, confidence: 'high' \};/,
      'exact aircraft registry matches must be high confidence',
    );
    assert.match(
      configSource,
      /return \{ operator: range\.operator, country: range\.country, confidence: 'medium' \};/,
      'range-only matches must remain medium confidence',
    );
    assert.match(
      serviceSource,
      /confidence: hexMatch\.confidence/,
      'the browser flight record must preserve the classifier confidence',
    );
  });
});
