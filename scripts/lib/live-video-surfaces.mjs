// Where each live video slot appears on the dashboard, read from the panels that render it.
// The panels import the DOM, so their default lists are read from source, and any list that can no
// longer be read fails loudly instead of silently placing nothing (as mcp-preset-liveness.mjs does).
import { readFileSync } from 'node:fs';

const WEBCAMS_PANEL = 'src/components/LiveWebcamsPanel.ts';
// The Live News channel lists live in src/services/live-channels.ts (#8293), not in the panel.
const NEWS_PANEL = 'src/services/live-channels.ts';

/**
 * The body of every `const <NAME>: Type = [` array whose name matches `pattern`. The `[` must end the
 * declaration line, so `const DEFAULT_LIVE_CHANNELS = x ? [] : y;` never swallows the next array.
 */
function arrays(source, pattern) {
  return [...source.matchAll(new RegExp(`const (${pattern})\\b[^=\\n]*=[ \\t]*\\[[ \\t]*\\n([\\s\\S]*?)\\n\\];`, 'g'))]
    .map(([, name, body]) => ({ name, body }));
}

/** Every `{ id: '...' }` object in `body`, failing when one of them cannot be read. */
function readObjects(body, objectPattern, file, name) {
  const read = [...body.matchAll(objectPattern)];
  const declared = [...body.matchAll(/\bid:/g)].length;
  if (declared === 0 || read.length !== declared) throw new Error(`${file}: cannot read every entry of ${name}`);
  return read;
}

/**
 * @param {{ webcamsPanel: string, newsPanel: string }} sources the two panel files' text
 * @returns {{ webcamFeeds: { id: string, region: string }[], gridCells: number,
 *   newsDefaults: Record<string, string[]>, newsOptional: string[] }}
 */
export function extractLiveVideoSurfaces({ webcamsPanel, newsPanel }) {
  const [feeds] = arrays(webcamsPanel, 'WEBCAM_FEEDS');
  if (!feeds) throw new Error(`${WEBCAMS_PANEL}: cannot find WEBCAM_FEEDS`);
  const webcamFeeds = readObjects(feeds.body, /\{\s*id:\s*'([^']+)'[^}]*?\bregion:\s*'([^']+)'[^}]*\}/g, WEBCAMS_PANEL, 'WEBCAM_FEEDS')
    .map(([, id, region]) => ({ id, region }));

  const gridCells = Number(/const MAX_GRID_CELLS\s*=\s*(\d+)\s*;/.exec(webcamsPanel)?.[1]);
  if (!Number.isSafeInteger(gridCells) || gridCells < 1) throw new Error(`${WEBCAMS_PANEL}: cannot read MAX_GRID_CELLS`);

  const newsDefaults = {};
  let newsOptional = null;
  for (const { name, body } of arrays(newsPanel, '[A-Z]+_LIVE_CHANNELS')) {
    const ids = readObjects(body, /\{\s*id:\s*'([^']+)'/g, NEWS_PANEL, name).map(([, id]) => id);
    if (name === 'OPTIONAL_LIVE_CHANNELS') newsOptional = ids;
    else newsDefaults[name.replace(/_LIVE_CHANNELS$/, '').toLowerCase()] = ids;
  }
  if (!newsOptional) throw new Error(`${NEWS_PANEL}: cannot find OPTIONAL_LIVE_CHANNELS`);
  if (Object.keys(newsDefaults).length === 0) throw new Error(`${NEWS_PANEL}: cannot find a default *_LIVE_CHANNELS list`);

  return { webcamFeeds, gridCells, newsDefaults, newsOptional };
}

export function readLiveVideoSurfaces(root = new URL('../../', import.meta.url)) {
  return extractLiveVideoSurfaces({
    webcamsPanel: readFileSync(new URL(WEBCAMS_PANEL, root), 'utf8'),
    newsPanel: readFileSync(new URL(NEWS_PANEL, root), 'utf8'),
  });
}
