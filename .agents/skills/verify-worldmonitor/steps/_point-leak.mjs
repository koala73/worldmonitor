// Finds a picked point in request text the way a reader would recover it: as a lat/lon pair,
// or as the midpoint of a box, at any precision finer than LEAK_DEGREES (1 decimal included).
import { scrubCoordinates } from '../../../../shared/sensitive-url-params.ts';

export const LEAK_DEGREES = 0.1;
// A minus is a sign unless it joins two words, as in `at-25.1-55.1`.
const NUMBER = /(?<![\w.])[-+]?\d+(?:\.\d+)?|\d+(?:\.\d+)?/g;
// Coordinates sit side by side in a URL or body, with at most a zoom or similar between them.
const PAIR_SPAN = 3;

function decoded(text) {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    let next;
    try { next = decodeURIComponent(out); } catch { break; }
    if (next === out) break;
    out = next;
  }
  return out;
}

function numbersIn(text) {
  return [...decoded(text).matchAll(NUMBER)].map(([raw]) => ({ value: Number(raw), decimal: raw.includes('.') }));
}

const near = (a, b) => Math.abs(a - b) < LEAK_DEGREES;

/** A box read either way round, west-south-east-north or south-west-north-east, centred on the point. */
function boxCentredOn([a, b, c, d], point) {
  if ([a, b, c, d].filter((n) => n.decimal).length < 2) return false;
  if (!(a.value < c.value && b.value < d.value)) return false;
  const first = (a.value + c.value) / 2;
  const second = (b.value + d.value) / 2;
  return (near(first, point.lon) && near(second, point.lat)) || (near(first, point.lat) && near(second, point.lon));
}

/** Reads the sheet's `25.112°N 55.139°E` heading. */
export function pointFromText(text) {
  const match = /([\d.]+)°\s*([NS])\s+([\d.]+)°\s*([EW])/.exec(text);
  if (!match) throw new Error(`no point in ${JSON.stringify(text)}`);
  const [, lat, ns, lon, ew] = match;
  return { lat: ns === 'N' ? +lat : -lat, lon: ew === 'E' ? +lon : -lon };
}

/** How `text` gives the point away: 'point', 'box', or null. */
export function pointLeak(text, point) {
  const numbers = numbersIn(text);
  for (let i = 0; i < numbers.length; i += 1) {
    if (i + 3 < numbers.length && boxCentredOn(numbers.slice(i, i + 4), point)) return 'box';
    const n = numbers[i];
    if (!n.decimal) continue;
    for (let j = i + 1; j <= i + PAIR_SPAN && j < numbers.length; j += 1) {
      const m = numbers[j];
      if (!m.decimal) continue;
      if ((near(n.value, point.lat) && near(m.value, point.lon)) || (near(n.value, point.lon) && near(m.value, point.lat))) return 'point';
    }
  }
  return null;
}

/** The archive URL as telemetry keeps it, after the coordinate params and path segments are scrubbed. */
export function archiveUrlAfterScrub(url) {
  const parsed = new URL(url);
  scrubCoordinates(parsed);
  return parsed.toString();
}
