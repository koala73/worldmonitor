/**
 * Guards CMD+K discoverability + deep-linking for the Consumer Prices "World"
 * tab (all-countries IMF inflation).
 *
 * A user typing "inflation" must not only find the panel but land on the
 * global inflation view. That contract spans three files:
 *   - commands.ts        — a `panel:consumer-prices@world` command exists and
 *                          carries enough inflation keywords to match queries.
 *   - search-manager.ts  — the panel handler parses the `@<tab>` suffix and
 *                          dispatches the panel's open-tab event.
 *   - ConsumerPricesPanel — listens for that event and has a `world` tab.
 *
 * These are source-text assertions (same style as
 * search-add-disabled-panel-wiring.test.mjs) so a refactor that silently
 * severs any link turns this red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf-8');
const commandsSrc = read('../src/config/commands.ts');
const searchModalSrc = read('../src/components/SearchModal.ts');
const searchManagerSrc = read('../src/app/search-manager.ts');
const panelSrc = read('../src/components/ConsumerPricesPanel.ts');

describe('Consumer Prices World tab — CMD+K discoverability', () => {
  it('exposes a panel:consumer-prices@world deep-link command', () => {
    assert.match(
      commandsSrc,
      /id:\s*'panel:consumer-prices@world'/,
      'missing the global-inflation deep-link command in commands.ts',
    );
  });

  it('the deep-link command carries the bare inflation query plus inflation-by-country keywords', () => {
    const m = commandsSrc.match(/id:\s*'panel:consumer-prices@world'[^\n]*?keywords:\s*\[([^\]]*)\]/);
    assert.ok(m, 'could not parse keywords for panel:consumer-prices@world');
    const keywords = m[1];
    for (const kw of ['inflation', 'global inflation', 'inflation by country', 'inflation ranking']) {
      assert.ok(keywords.includes(kw), `World command keywords missing "${kw}"`);
    }
  });

  it('the base consumer-prices command does not outrank the World tab for bare "inflation"', () => {
    const m = commandsSrc.match(/id:\s*'panel:consumer-prices'[^\n]*?keywords:\s*\[([^\]]*)\]/);
    assert.ok(m, 'could not parse keywords for panel:consumer-prices');
    assert.ok(!m[1].includes("'inflation'"), 'base panel command should not own bare "inflation"');
  });

  it('SearchModal gates suffixed panel commands by their base panel id', () => {
    assert.match(searchModalSrc, /function\s+panelCommandTargetId/, 'missing panel command id normalizer');
    assert.match(searchModalSrc, /split\('@'\)\[0\]/, 'panel command normalizer must strip @tab suffix');
    assert.match(searchModalSrc, /action\.includes\('@'\)[\s\S]*\?\s*fallback/, 'suffixed panel commands should keep their explicit deep-link label');
    assert.match(searchModalSrc, /isPanelCommandVisible\(panelId\)/, 'search results must gate by normalized panel id');
    assert.match(searchModalSrc, /isAddablePanel\(cmd: Command\)/, 'addable affordance must route through normalized panel id');
  });

  it('the @world id is invisible to the panel-parity guardrail parser', () => {
    // panel-config-guardrails uses /panel:([a-zA-Z0-9_-]+)'/ — the `@` means
    // the suffixed id is skipped, so it cannot register a bogus panel id.
    const guardrailRe = /id:\s*'panel:([a-zA-Z0-9_-]+)'/g;
    const ids = [...commandsSrc.matchAll(guardrailRe)].map((g) => g[1]);
    assert.ok(ids.includes('consumer-prices'), 'base panel id must still be parsed');
    assert.ok(
      !ids.some((id) => id.includes('@') || id === 'world'),
      'the @world suffix leaked into the guardrail parser',
    );
  });

  it('search-manager parses the @<tab> suffix and dispatches the open-tab event', () => {
    assert.match(searchManagerSrc, /action\.split\('@'\)/, 'panel handler no longer splits on @');
    assert.match(searchManagerSrc, /dispatchPanelTab\(/, 'panel handler no longer deep-links to a tab');
    assert.match(
      searchManagerSrc,
      /wm-consumer-prices-open-tab/,
      'search-manager no longer dispatches the consumer-prices open-tab event',
    );
  });

  it('ConsumerPricesPanel listens for the open-tab event and has a world tab', () => {
    assert.match(panelSrc, /wm-consumer-prices-open-tab/, 'panel no longer listens for the open-tab event');
    assert.match(panelSrc, /'world'/, 'panel no longer defines a world tab id');
    assert.match(panelSrc, /getAllCountriesInflation/, 'panel no longer loads all-countries inflation');
  });
});
