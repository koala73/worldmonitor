/**
 * Conservation Wins panel: a tile whose photo fails to load shows the fallback
 * SVG. The data URI must decode to an SVG with valid fill colours; an invalid
 * fill renders black.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { fetchConservationWins } from '@/services/conservation-data';

import { initTestI18n } from './helpers/i18n.mts';

const { SpeciesComebackPanel } = await import('@/components/SpeciesComebackPanel');

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Decode an `data:image/svg+xml,` URI the way a browser does: one percent-decode pass. */
function parseSvgDataUri(uri: string): Document {
  const prefix = 'data:image/svg+xml,';
  expect(uri.startsWith(prefix)).toBe(true);
  const markup = decodeURIComponent(uri.slice(prefix.length));
  return new DOMParser().parseFromString(markup, 'image/svg+xml');
}

beforeAll(async () => {
  await initTestI18n();
});

describe('SpeciesComebackPanel photo fallback', () => {
  it('replaces a failed photo with an SVG whose fills are valid colours', async () => {
    const species = await fetchConservationWins();
    const panel = new SpeciesComebackPanel();
    document.body.appendChild(panel.getElement());
    panel.setData(species.slice(0, 1));

    const img = panel.getElement().querySelector<HTMLImageElement>('.species-photo img');
    expect(img).not.toBeNull();
    img!.dispatchEvent(new Event('error'));

    const svg = parseSvgDataUri(img!.src);
    const filled = Array.from(svg.querySelectorAll('[fill]'));
    expect(filled.length).toBeGreaterThan(0);
    for (const el of filled) {
      expect(el.getAttribute('fill'), `<${el.tagName}> fill`).toMatch(HEX_COLOUR);
    }
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#f0f4ed');

    panel.destroy();
  });
});
