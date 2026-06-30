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

describe('IntelligenceGapBadge teardown', () => {
  it('tracks the findings modal overlay and its Esc listener on the instance', () => {
    assert.match(src, /this\.findingsModalOverlay = overlay;/, 'showAllFindings must store the overlay on the instance');
    assert.match(src, /this\.findingsModalEscListener = onEsc;/, 'showAllFindings must store the Esc listener on the instance');
  });

  it('dismissFindingsModal removes the document keydown listener and the overlay', () => {
    assert.match(
      src,
      /private dismissFindingsModal\(\): void \{[\s\S]*?removeEventListener\('keydown', this\.findingsModalEscListener\)[\s\S]*?this\.findingsModalOverlay\.remove\(\)[\s\S]*?\}/,
      'dismissFindingsModal must tear down both the keydown listener and the overlay element',
    );
  });

  it('destroy tears down an open findings modal so it cannot outlive the badge', () => {
    const destroyBody = src.slice(src.indexOf('public destroy(): void'));
    assert.match(destroyBody, /this\.dismissFindingsModal\(\);/, 'destroy() must dismiss the findings modal');
  });
});
