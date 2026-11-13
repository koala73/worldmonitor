import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { isAllowedPreviewUrl } from '../../utils/imagery-preview';

/** West, south, east and north edges in degrees; never crosses the antimeridian. */
export interface CropBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const KM_PER_DEGREE = 111.32;
const COORDINATE_DECIMALS = 4;
export const DEFAULT_CROP_HALF_SIZE_KM = 3;
export const DEFAULT_CROP_PIXELS = 512;

const round = (value: number) => Number(value.toFixed(COORDINATE_DECIMALS));

/** Fixed-decimal text for a coordinate in a URL; never exponent form, so telemetry scrubbing always recognises it. */
export function formatCoordinate(value: number, decimals = 6): string {
  const text = value.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

const boxText = (...values: number[]) => values.map((value) => formatCoordinate(value)).join(',');

/** A span of `2 * half` degrees centred on `centre`, slid rather than wrapped so it stays inside [min, max]. */
function slide(centre: number, half: number, min: number, max: number): [number, number] {
  if (2 * half >= max - min) return [min, max];
  const low = Math.min(Math.max(centre - half, min), max - 2 * half);
  return [low, low + 2 * half];
}

export function cropBox(point: GeoPoint, halfSizeKm = DEFAULT_CROP_HALF_SIZE_KM): CropBox {
  const latHalf = halfSizeKm / KM_PER_DEGREE;
  const [south, north] = slide(point.lat, latHalf, -90, 90);
  const widestLat = Math.max(Math.abs(south), Math.abs(north));
  const cosLat = Math.cos((widestLat * Math.PI) / 180);
  const lonHalf = cosLat > 1e-6 ? latHalf / cosLat : 180;
  const [west, east] = slide(point.lon, lonHalf, -180, 180);
  return { west: round(west), south: round(south), east: round(east), north: round(north) };
}

const allowed = (url: string): string | null => (isAllowedPreviewUrl(url) ? url : null);

/**
 * Crops a Planetary Computer item to the box, keeping the rendering the
 * archive itself publishes in the item's rendered preview link.
 */
export function planetaryComputerCropUrl(renderedPreviewHref: string, box: CropBox, pixels = DEFAULT_CROP_PIXELS): string | null {
  let preview: URL;
  try {
    preview = new URL(renderedPreviewHref);
  } catch {
    return null;
  }
  if (!preview.pathname.endsWith('/item/preview.png')) return null;
  preview.pathname = preview.pathname.replace(
    /\/item\/preview\.png$/,
    `/item/bbox/${boxText(box.west, box.south, box.east, box.north)}/${pixels}x${pixels}.png`,
  );
  preview.searchParams.delete('format');
  return allowed(preview.toString());
}

/** A WMS 1.3.0 GetMap in EPSG:4326, whose axis order is latitude first. */
function wmsGetMapUrl(endpoint: string, layer: string, time: string, box: CropBox, pixels: number, format: string): string | null {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    CRS: 'EPSG:4326',
    BBOX: boxText(box.south, box.west, box.north, box.east),
    WIDTH: String(pixels),
    HEIGHT: String(pixels),
    FORMAT: format,
    TIME: time,
  });
  return allowed(`${endpoint}?${params}`);
}

export const GIBS_WMS_ENDPOINT = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
export const EUMETSAT_WMS_ENDPOINT = 'https://view.eumetsat.int/geoserver/wms';

export function gibsSnapshotUrl(layer: string, time: string, box: CropBox, pixels = DEFAULT_CROP_PIXELS): string | null {
  return wmsGetMapUrl(GIBS_WMS_ENDPOINT, layer, time, box, pixels, 'image/jpeg');
}

export function eumetsatSnapshotUrl(layer: string, time: string, box: CropBox, pixels = DEFAULT_CROP_PIXELS): string | null {
  return wmsGetMapUrl(EUMETSAT_WMS_ENDPOINT, layer, time, box, pixels, 'image/png');
}
