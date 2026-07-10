import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modalSrc = readFileSync(resolve(root, 'src/components/SearchModal.ts'), 'utf8');
const stylesSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');

test('mobile search mounts the sheet shell before deferred result and chip population (#5158)', () => {
  assert.doesNotMatch(modalSrc, /scheduleAfterFirstPaint/,
    'opening search must not wait for the dashboard load/idle scheduler');
  assert.match(modalSrc, /if \(this\.isMobile\) \{\s*this\.scheduleMobileInitialPopulation\(\);\s*\} else \{\s*this\.showRecentOrEmpty\(\);\s*\}/,
    'open() must leave mobile result/chip construction out of the tap task');
  assert.match(modalSrc, /private scheduleMobileInitialPopulation\(\): void \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?this\.showRecentOrEmpty\(\);[\s\S]*?this\.renderChips\(\);/,
    'the initial mobile lists should populate after the sheet reveal frame, without waiting for page load');
  assert.match(modalSrc, /mobileInitialPopulationGeneration \+= 1;/,
    'closing the sheet must invalidate deferred work from a prior open');
});

test('mobile search keeps the closed sheet out of rendering until its reveal frame (#5158)', () => {
  assert.match(stylesSrc, /\.search-overlay\.search-mobile:not\(\.open\) \.search-sheet \{[\s\S]*?content-visibility:\s*hidden;/,
    'the hidden sheet should not participate in paint work before its reveal');
});
