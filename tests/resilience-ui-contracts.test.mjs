import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const widgetSource = readFileSync(new URL('../src/components/ResilienceWidget.ts', import.meta.url), 'utf8');
const countryBriefSource = readFileSync(new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');
const mapSource = readFileSync(new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8');
const scoreHandlerSource = readFileSync(new URL('../server/worldmonitor/resilience/v1/get-resilience-score.ts', import.meta.url), 'utf8');
const rankingHandlerSource = readFileSync(new URL('../server/worldmonitor/resilience/v1/get-resilience-ranking.ts', import.meta.url), 'utf8');
const sharedScoreSource = readFileSync(new URL('../server/worldmonitor/resilience/v1/_shared.ts', import.meta.url), 'utf8');
const statsSource = readFileSync(new URL('../server/_shared/resilience-stats.ts', import.meta.url), 'utf8');

test('ResilienceWidget keeps score, trend, domains, and confidence visible in the rendered score card', () => {
  assert.match(widgetSource, /h\('span', \{ className: 'resilience-widget__overall-score' \}, String\(Math\.round\(clampScore\(data\.overallScore\)\)\)\)/);
  assert.match(widgetSource, /h\('span', \{ className: 'resilience-widget__overall-trend' \}, `\$\{getResilienceTrendArrow\(data\.trend\)\} \$\{data\.trend\}`\)/);
  assert.match(widgetSource, /\{ className: 'resilience-widget__domains' \}/);
  assert.match(widgetSource, /className: `resilience-widget__confidence\$\{data\.lowConfidence \? ' resilience-widget__confidence--low' : ''\}`/);
  assert.match(countryBriefSource, /summaryGrid\.append\(scoreCard, this\.resilienceWidget\.getElement\(\)\);/);
});

test('DeckGLMap keeps resilience legend entries wired to layer visibility updates', () => {
  assert.match(mapSource, /const resilienceLegendItems: \{ shape: string; label: string; layerKey: keyof MapLayers \}\[] = \[/);
  assert.match(mapSource, /\.\.\.resilienceLegendItems,/);
  assert.match(mapSource, /data-layer="\$\{layerKey\}"/);
  assert.match(mapSource, /item\.style\.display = this\.state\.layers\[layerKey as keyof MapLayers\] \? '' : 'none';/);
});

test('resilience score computation stays pure and does not depend on LLM helpers', () => {
  for (const source of [scoreHandlerSource, rankingHandlerSource, sharedScoreSource, statsSource]) {
    assert.doesNotMatch(source, /callLlm|generateText|generateObject|openai|anthropic/i);
  }
});
