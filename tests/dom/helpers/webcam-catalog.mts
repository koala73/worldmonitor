type Catalog = typeof import('@/config/live-video-sources');

// Slots left empty in the fixture. Every other slot gets one stand-in video.
const EMPTY_SLOTS: ReadonlySet<string> = new Set(['tel-aviv', 'beirut-mtv', 'nasa-live', 'space-x']);

const GRID_PRIORITY = [
  'jerusalem', 'middle-east', 'kyiv', 'washington',
  'taipei', 'tel-aviv', 'beirut-mtv', 'mecca', 'st-petersburg', 'tokyo', 'los-angeles', 'sydney', 'iss-earth',
];

/**
 * The catalog module with frozen entries and wall order, so the owner emptying a dead slot or
 * reordering the wall in src/config/live-video-sources.ts never reds a panel test. Slot ids still
 * come from the real catalog, which tests/live-video-catalog.test.mts keeps in step with the panel.
 */
export function withFixtureWebcamCatalog(real: Catalog): Catalog {
  const sources = Object.fromEntries(Object.keys(real.WEBCAM_SOURCES).map((slot, index) => [
    slot,
    EMPTY_SLOTS.has(slot) ? [] : [`https://www.youtube.com/watch?v=fixture${String(index).padStart(4, '0')}`],
  ]));
  return {
    ...real,
    WEBCAM_SOURCES: sources as unknown as Catalog['WEBCAM_SOURCES'],
    WEBCAM_GRID_PRIORITY: GRID_PRIORITY as unknown as Catalog['WEBCAM_GRID_PRIORITY'],
  };
}
