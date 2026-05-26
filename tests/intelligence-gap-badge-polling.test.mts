import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'src', 'components', 'IntelligenceGapBadge.ts'), 'utf-8');

describe('IntelligenceGapBadge polling', () => {
  it('setInterval callback includes visibilityState check', () => {
    assert.match(
      src,
      /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?visibilityState/s,
      'setInterval callback must check document.visibilityState to avoid background-tab polling',
    );
  });
});
