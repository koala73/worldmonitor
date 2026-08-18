import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMBED_PANEL_ID,
  EMBED_PANEL_IDS,
  listEmbeddablePanels,
  parseEmbedPanelId,
  panelRequiresEmbeddingApiKey,
} from '../shared/embed-panels';

describe('embed panel allowlist', () => {
  it('starts with the live map plus two existing dashboard panels', () => {
    assert.deepEqual([...EMBED_PANEL_IDS], ['map', 'chokepoint-strip', 'fear-greed']);
    assert.equal(DEFAULT_EMBED_PANEL_ID, 'map');
    assert.equal(panelRequiresEmbeddingApiKey('map'), false);
    assert.equal(panelRequiresEmbeddingApiKey('chokepoint-strip'), true);
    assert.equal(panelRequiresEmbeddingApiKey('fear-greed'), true);
  });

  it('parses canonical ids and aliases, and rejects unknown panels', () => {
    assert.equal(parseEmbedPanelId(null), 'map');
    assert.equal(parseEmbedPanelId(''), 'map');
    assert.equal(parseEmbedPanelId('live-map'), 'map');
    assert.equal(parseEmbedPanelId('Chokepoints'), 'chokepoint-strip');
    assert.equal(parseEmbedPanelId('fear_greed'), 'fear-greed');
    assert.equal(parseEmbedPanelId('x-feed'), null);
    assert.equal(parseEmbedPanelId('intel'), null);
  });

  it('does not allowlist an X / tweet-body panel', () => {
    const ids = listEmbeddablePanels().map((panel) => panel.id);
    assert.equal(ids.some((id) => /x-|twitter|tweet/.test(id)), false);
  });
});
