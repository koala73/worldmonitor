import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { localizeShellMeta } from '../src/app/shell-meta.ts';

const BAKED_TITLE = 'Live World Map: Conflicts, Flights and Ships | World Monitor';
const BAKED_DESCRIPTION = 'Real-time global intelligence.';

function shell(): Document {
  const window = new Window();
  window.document.write(`<!doctype html><html><head>
    <title>${BAKED_TITLE}</title>
    <meta name="description" content="${BAKED_DESCRIPTION}">
    <meta property="og:title" content="${BAKED_TITLE}">
    <meta property="og:description" content="${BAKED_DESCRIPTION}">
    <meta name="twitter:title" content="${BAKED_TITLE}">
    <meta name="twitter:description" content="${BAKED_DESCRIPTION}">
  </head><body></body></html>`);
  return window.document as unknown as Document;
}

const content = (doc: Document, selector: string) => doc.querySelector(selector)?.getAttribute('content');
const catalogue = (key: string) => ({
  'shell.documentTitle': 'Tableau de bord mondial',
  'shell.metaDescription': 'Renseignement mondial en temps réel.',
})[key] ?? key;

describe('localizeShellMeta', () => {
  it('keeps the baked per-variant English title and description', () => {
    const doc = shell();
    localizeShellMeta(doc, 'en', catalogue);
    assert.equal(doc.title, BAKED_TITLE);
    assert.equal(content(doc, 'meta[name="description"]'), BAKED_DESCRIPTION);
    assert.equal(content(doc, 'meta[property="og:title"]'), BAKED_TITLE);
    assert.equal(content(doc, 'meta[name="twitter:title"]'), BAKED_TITLE);
  });

  it('swaps every title and description to the catalogue for other languages', () => {
    const doc = shell();
    localizeShellMeta(doc, 'fr', catalogue);
    assert.equal(doc.title, 'Tableau de bord mondial');
    assert.equal(content(doc, 'meta[name="description"]'), 'Renseignement mondial en temps réel.');
    assert.equal(content(doc, 'meta[property="og:title"]'), 'Tableau de bord mondial');
    assert.equal(content(doc, 'meta[property="og:description"]'), 'Renseignement mondial en temps réel.');
    assert.equal(content(doc, 'meta[name="twitter:title"]'), 'Tableau de bord mondial');
    assert.equal(content(doc, 'meta[name="twitter:description"]'), 'Renseignement mondial en temps réel.');
  });
});
