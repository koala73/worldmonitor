import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'src', 'services', 'oref-locations.ts'), 'utf8');

describe('oref-locations.ts', () => {
  it('exports translateLocation function', () => {
    assert.ok(SRC.includes('export function translateLocation('));
  });

  it('has a substantial number of location entries', () => {
    const matches = SRC.match(/^\s+'[^']+': '[^']+',$/gm);
    assert.ok(matches, 'should have map entries');
    assert.ok(matches.length > 1000, `expected >1000 entries, got ${matches.length}`);
  });

  it('contains known cities', () => {
    assert.ok(SRC.includes('Tel Aviv'), 'should include Tel Aviv');
    assert.ok(SRC.includes("'אשקלון'") || SRC.includes("Ashkelon"), 'should include Ashkelon');
    assert.ok(SRC.includes("'באר שבע'") || SRC.includes("Be'er Sheva") || SRC.includes("Beer Sheva"), 'should include Beer Sheva');
  });

  it('uses NFKC normalization in translateLocation', () => {
    assert.ok(SRC.includes("normalize('NFKC')"), 'should use NFKC normalization');
  });

  it('returns original string when no match found', () => {
    assert.ok(SRC.includes('?? hebrew') || SRC.includes('|| hebrew'), 'should return original on miss');
  });

  it('handles empty input', () => {
    assert.ok(SRC.includes('if (!hebrew) return hebrew'), 'should guard empty input');
  });

  it('trims and collapses whitespace', () => {
    assert.ok(SRC.includes('.trim()'), 'should trim');
    assert.ok(SRC.includes("replace(/\\s+/g, ' ')"), 'should collapse spaces');
  });

  it('includes zone translations', () => {
    assert.ok(SRC.includes("'גליל עליון'") || SRC.includes('Upper Galilee'), 'should include zone names');
  });
});
