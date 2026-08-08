import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const source = fs.readFileSync(new URL('../src/services/telegram-intel.ts', import.meta.url), 'utf8');

describe('formatTelegramTime', () => {
  it('treats relay timestamp fallback as unknown instead of decades-old', () => {
    assert.match(source, /MISSING_TIMESTAMP_ISO\s*=\s*new Date\(0\)\.toISOString\(\)/);
    assert.match(source, /ts\s*===\s*MISSING_TIMESTAMP_ISO\)\s*return 'unknown'/);
  });

  it('treats malformed timestamps as unknown', () => {
    assert.match(source, /!Number\.isFinite\(time\)[\s\S]{0,80}return 'unknown'/);
  });
});
