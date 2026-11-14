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

const PLANETARY_COMPUTER_CROP_URL = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';

/**
 * The "Natural color" render options Planetary Computer publishes per
 * collection at /api/data/v1/mosaic/info?collection=<id> (read 2026-11-13).
 * The items' own rendered previews use the visual (TCI) asset, which clips
 * bright ground such as desert, snow and cloud to flat white or yellow.
 */
export const PLANETARY_COMPUTER_NATURAL_COLOUR: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  'sentinel-2-l2a': [
    ['assets', 'B04'], ['assets', 'B03'], ['assets', 'B02'], ['nodata', '0'],
    ['color_formula', 'Gamma RGB 3.2 Saturation 0.8 Sigmoidal RGB 25 0.35'],
  ],
  'landsat-c2-l2': [
    ['assets', 'red'], ['assets', 'green'], ['assets', 'blue'], ['nodata', '0'],
    ['color_formula', 'gamma RGB 2.7, saturation 1.5, sigmoidal RGB 15 0.55'],
  ],
};

/** Crops a Planetary Computer item to the box in the archive's natural-colour rendering. */
export function planetaryComputerCropUrl(collection: string, itemId: string, box: CropBox, pixels = DEFAULT_CROP_PIXELS): string | null {
  const render = PLANETARY_COMPUTER_NATURAL_COLOUR[collection];
  if (!render) return null;
  const params = new URLSearchParams([['collection', collection], ['item', itemId], ...render.map(([key, value]): [string, string] => [key, value])]);
  return allowed(`${PLANETARY_COMPUTER_CROP_URL}/${boxText(box.west, box.south, box.east, box.north)}/${pixels}x${pixels}.png?${params}`);
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
