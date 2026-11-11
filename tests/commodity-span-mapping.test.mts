import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// Execute the actual mapping expressions, keeping these checks independent of
// dashboard boot, credentials and unrelated market requests.
const quote = { symbol: 'GC=F', name: 'Gold', display: 'Gold', price: 1, change: 0,
  sparkline: [1, 2], sparklineIntervalSeconds: 300, sparklineStartAt: '2026-11-10T13:40:00Z' };
function objects(path: string) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'symbol')) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found.map(node => node.getText(source));
}
function check(expression: string, parameter: string) {
  const js = ts.transpile(`return (${expression});`);
  const model = new Function(parameter, 'm', 'symbolMetaMap', js)(quote, undefined, new Map());
  assert.equal(model.sparklineIntervalSeconds, 300);
  assert.equal(model.sparklineStartAt, quote.sparklineStartAt);
}
it('market service preserves commodity span fields from API response', () => {
  const expression = objects('../src/services/market/index.ts').find(x => x.includes('symbol: q.symbol') && x.includes('priceSource: q.priceSource'));
  assert.ok(expression);
  check(expression, 'q');
});
it('data loader bootstrap preserves commodity span fields', () => {
  const expression = objects('../src/app/data-loader.ts').find(x => x.includes('symbol: q.symbol') && x.includes('symbolMetaMap.get(q.symbol)') && x.includes('priceSource: q.priceSource'));
  assert.ok(expression);
  check(expression, 'q');
});
it('data loader panel mapping preserves commodity span fields', () => {
  const expression = objects('../src/app/data-loader.ts').find(x => x.includes('symbol: c.symbol') && x.includes('sparkline: c.sparkline'));
  assert.ok(expression);
  check(expression, 'c');
});
it('English exposure tooltip explains precision and separate source rows', () => {
  const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  const text = en.components.populationExposure.infoTooltip;
  assert.match(text, /unrest.*precise location/i);
  assert.match(text, /UCDP.*imprecise/i);
  assert.match(text, /two sources.*two rows/i);
});
