import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('Daily brief i18n guardrails', () => {
  const loaderSrc = readFileSync(join(root, 'src/app/data-loader.ts'), 'utf-8');
  const panelSrc = readFileSync(join(root, 'src/components/DailyMarketBriefPanel.ts'), 'utf-8');
  const countryIntelSrc = readFileSync(join(root, 'src/app/country-intel.ts'), 'utf-8');

  it('reuses the original language snapshot when falling back to cached daily briefs', () => {
    assert.match(loaderSrc, /const lang = getCurrentLanguage\(\);[\s\S]*?catch \(error\)[\s\S]*?getCachedDailyMarketBrief\(timezone, lang\)/);
    assert.doesNotMatch(loaderSrc, /getCachedDailyMarketBrief\(timezone, getCurrentLanguage\(\)\)/);
  });

  it('waits for debounced daily brief panel content before translating copy', () => {
    assert.match(panelSrc, /const BRIEF_COPY_TRANSLATION_DELAY_MS = 200;/);
    assert.match(panelSrc, /translateUnavailableMessage\(message, lang, requestId\);\s*\}, BRIEF_COPY_TRANSLATION_DELAY_MS\)/);
    assert.match(panelSrc, /translateBriefCopy\(targetLang, requestId\);\s*\}, BRIEF_COPY_TRANSLATION_DELAY_MS\)/);
  });

  it('treats stance labels as translatable brief copy', () => {
    assert.match(panelSrc, /function stanceCopySource\(/);
    assert.match(panelSrc, /data-brief-copy="\$\{escapeHtml\(stanceSource\)\}"/);
    assert.match(panelSrc, /getBriefCopy\(stanceSource, lang\)/);
  });

  it('parallelizes translated fallback lines for country briefs', () => {
    assert.match(countryIntelSrc, /const linePromises: Promise<string>\[\] = \[];/);
    assert.match(countryIntelSrc, /const lines = \(await Promise\.all\(linePromises\)\)\.filter\(\(line\) => line\.length > 0\)/);
  });
});
