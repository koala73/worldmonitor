import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(__dirname, '..', 'src', 'components', 'SupplyChainPanel.ts'), 'utf-8');

// Structural tests verify the transit chart mount/cleanup contract is implemented correctly.
// These test the source patterns rather than extracting and executing method bodies,
// which avoids fragile string-to-function compilation.

describe('SupplyChainPanel transit chart mount contract', () => {

  it('render() calls clearTransitChart() before any content change', () => {
    // The first line inside render() must clear previous chart state
    const renderMatch = panelSrc.match(/private\s+render\(\)[\s\S]*?\{([\s\S]*?)this\.setContent/);
    assert.ok(renderMatch, 'render method should exist and call setContent');
    assert.ok(
      renderMatch[1].includes('this.clearTransitChart()'),
      'render must call clearTransitChart() before setContent to prevent stale chart references'
    );
  });

  it('clearTransitChart() cancels timer, disconnects observer, and destroys chart', () => {
    const clearStart = panelSrc.indexOf('clearTransitChart(): void {');
    assert.ok(clearStart !== -1, 'clearTransitChart method should exist');
    const body = panelSrc.slice(clearStart, clearStart + 300);
    assert.ok(body.includes('clearTimeout'), 'must cancel pending timer');
    assert.ok(body.includes('chartMountTimer') && body.includes('null'), 'must null the timer handle');
    assert.ok(body.includes('disconnect'), 'must disconnect MutationObserver');
    assert.ok(body.includes('transitChart.destroy'), 'must destroy the chart instance');
  });

  it('sets up MutationObserver when chokepoint is expanded', () => {
    // After setContent, if activeTab is chokepoints and expandedChokepoint is set,
    // a MutationObserver should be created to detect DOM readiness
    assert.ok(
      panelSrc.includes('new MutationObserver'),
      'render must create a MutationObserver for chart mount detection'
    );
    assert.ok(
      panelSrc.includes('.observe(this.content'),
      'observer must watch this.content for childList mutations'
    );
  });

  it('has a fallback timer for no-op renders where MutationObserver does not fire', () => {
    // When setContent short-circuits (identical HTML), no mutation fires.
    // A fallback timer ensures the chart still mounts.
    const timerMatch = panelSrc.match(/this\.chartMountTimer\s*=\s*setTimeout\(/);
    assert.ok(timerMatch, 'must schedule a fallback setTimeout for chart mount');

    // The timer should have a reasonable delay (100-500ms)
    const delayMatch = panelSrc.match(/chartMountTimer\s*=\s*setTimeout\([^,]+,\s*(\d+)\)/);
    assert.ok(delayMatch, 'timer must have an explicit delay');
    const delay = parseInt(delayMatch[1], 10);
    assert.ok(delay >= 100 && delay <= 500, `timer delay ${delay}ms should be 100-500ms`);
  });

  it('fallback timer clears itself and disconnects observer after mounting', () => {
    // Inside the fallback timer callback, after successful mount:
    // 1. Disconnect the observer (no longer needed)
    // 2. Set chartMountTimer = null (prevent double-cleanup)
    const timerBody = panelSrc.match(/chartMountTimer\s*=\s*setTimeout\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\d+\)/);
    assert.ok(timerBody, 'fallback timer callback should exist');
    const body = timerBody[1];
    assert.ok(body.includes('chartObserver') && body.includes('disconnect'), 'timer callback must disconnect observer');
    assert.ok(body.includes('chartMountTimer = null'), 'timer callback must null the timer handle');
  });

  it('MutationObserver callback clears timer and disconnects itself after mounting', () => {
    // Inside the MutationObserver callback, after successful mount:
    // 1. Clear the fallback timer (prevent double-mount)
    // 2. Disconnect self
    const observerBody = panelSrc.match(/new MutationObserver\(\(\)\s*=>\s*\{([\s\S]*?)\}\)/);
    assert.ok(observerBody, 'MutationObserver callback should exist');
    const body = observerBody[1];
    assert.ok(body.includes('clearTimeout') || body.includes('chartMountTimer'), 'observer callback must cancel fallback timer');
    assert.ok(body.includes('disconnect'), 'observer callback must disconnect itself');
  });

  it('mountTransitChart checks for chart element and transit history before mounting', () => {
    // The mount function should guard against missing DOM elements and missing data
    assert.ok(
      panelSrc.includes('querySelector(`[data-chart-cp='),
      'must query for chart container element by chokepoint name'
    );
    assert.ok(
      panelSrc.includes('transitSummary?.history?.length'),
      'must check transitSummary.history exists before mounting'
    );
    assert.ok(
      panelSrc.includes('transitChart.mount('),
      'must call transitChart.mount with element and history data'
    );
  });

  it('tab switch clears transit chart before re-rendering', () => {
    // Clicking a different tab should clear chart state before rendering new tab
    const tabHandler = panelSrc.match(/if\s*\(tab\)\s*\{([\s\S]*?)\n\s{8}return/);
    assert.ok(tabHandler, 'tab click handler should exist');
    const body = tabHandler[1];
    assert.ok(body.includes('clearTransitChart'), 'tab switch must clear chart before render');
    assert.ok(body.indexOf('clearTransitChart') < body.indexOf('render'), 'clearTransitChart must come before render()');
  });

  it('collapsing an expanded chokepoint clears the chart', () => {
    // When expandedChokepoint is set to null (collapse), chart should be cleared
    assert.ok(
      panelSrc.includes('if (!newId) this.clearTransitChart()'),
      'collapsing a chokepoint (newId=null) must clear the chart'
    );
  });
});

const serverSrc = readFileSync(resolve(__dirname, '..', 'server', 'worldmonitor', 'supply-chain', 'v1', 'get-chokepoint-status.ts'), 'utf-8');

describe('SupplyChainPanel restructure contract', () => {

  it('activeHasData for shipping tab accepts chokepointData without FRED', () => {
    const block = panelSrc.match(/const activeHasData[\s\S]*?;/);
    assert.ok(block, 'activeHasData assignment should exist');
    const shippingPart = block[0].slice(block[0].indexOf("'shipping'"));
    assert.ok(
      shippingPart.includes('chokepointData'),
      'shipping activeHasData must check chokepointData (not just shippingData)'
    );
  });

  it('renderShipping delegates to renderDisruptionSnapshot', () => {
    const shippingMethod = panelSrc.match(/private\s+renderShipping\(\)[\s\S]*?\{([\s\S]*?)\n\s{2}\}/);
    assert.ok(shippingMethod, 'renderShipping method should exist');
    assert.ok(
      shippingMethod[1].includes('renderDisruptionSnapshot()'),
      'renderShipping must call renderDisruptionSnapshot'
    );
    assert.ok(
      shippingMethod[1].includes('renderFredIndices()'),
      'renderShipping must call renderFredIndices'
    );
  });

  it('renderDisruptionSnapshot handles null chokepointData as loading state', () => {
    const method = panelSrc.match(/private\s+renderDisruptionSnapshot\(\)[\s\S]*?\{([\s\S]*?)\n\s{2}\}/);
    assert.ok(method, 'renderDisruptionSnapshot method should exist');
    assert.ok(
      method[1].includes('this.chokepointData === null'),
      'must check for null chokepointData (loading state)'
    );
    assert.ok(
      method[1].includes('loadingCorridors'),
      'must show loading placeholder when chokepointData is null'
    );
  });

  it('renderDisruptionSnapshot returns empty string for empty chokepoints', () => {
    const method = panelSrc.match(/private\s+renderDisruptionSnapshot\(\)[\s\S]*?\{([\s\S]*?)\n\s{2}\}/);
    assert.ok(method, 'renderDisruptionSnapshot method should exist');
    assert.ok(
      /if\s*\(!cps\?\.length\)\s*return\s*''/.test(method[1]),
      'must return empty string when chokepoints array is empty'
    );
  });

  it('chokepoint cards preserve data-cp-id and data-chart-cp attributes', () => {
    assert.ok(
      panelSrc.includes('data-cp-id="${escapeHtml(cp.name)}"'),
      'cards must have data-cp-id for click delegation'
    );
    assert.ok(
      panelSrc.includes('data-chart-cp="${escapeHtml(cp.name)}"'),
      'expanded cards must have data-chart-cp for transit chart mount'
    );
  });

  it('chokepoint description is conditionally hidden when empty', () => {
    assert.ok(
      panelSrc.includes("cp.description ? `<div class=\"trade-description\">"),
      'description div must be conditional on non-empty description'
    );
  });

  it('server description no longer contains riskSummary or warning count text', () => {
    const descBlock = serverSrc.match(/const descriptions:\s*string\[\]\s*=\s*\[\];([\s\S]*?)description:\s*descriptions\.join/);
    assert.ok(descBlock, 'description assembly block should exist');
    const body = descBlock[1];
    assert.ok(
      !body.includes('riskSummary'),
      'descriptions[] must not include riskSummary (it is in transitSummary)'
    );
    assert.ok(
      !body.includes('Navigational warnings:'),
      'descriptions[] must not include warning count text (use activeWarnings field)'
    );
    assert.ok(
      !body.includes('AIS vessel disruptions:'),
      'descriptions[] must not include disruption count text (use aisDisruptions field)'
    );
  });
});
