import mask from './land-coast-mask.data.js';

const COLUMNS = Math.round(360 / mask.cellDeg);

function decodeRow(encoded) {
  const landStarts = [];
  let col = 0;
  encoded.split('.').forEach((run, index) => {
    const length = parseInt(run, 36);
    if (index % 2 === 1) landStarts.push([col, col + length]);
    col += length;
  });
  return landStarts;
}

const decodedRows = new Map();

export function isLandOrCoast(lat, lon) {
  const row = Math.min(mask.rows.length - 1, Math.max(0, Math.floor((90 - lat) / mask.cellDeg)));
  const col = ((Math.floor((lon + 180) / mask.cellDeg) % COLUMNS) + COLUMNS) % COLUMNS;
  let spans = decodedRows.get(row);
  if (!spans) {
    spans = decodeRow(mask.rows[row]);
    decodedRows.set(row, spans);
  }
  return spans.some(([start, end]) => col >= start && col < end);
}
