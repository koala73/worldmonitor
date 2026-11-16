import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStacItem } from '../src/services/orbital/archive-stac.ts';
import { cropBox, eumetsatSnapshotUrl, gibsSnapshotUrl, planetaryComputerCropUrl, sentinel1CoPolarisation, type CropBox } from '../src/services/orbital/crop-url.ts';
import { isAllowedPreviewUrl } from '../src/utils/imagery-preview.ts';

const S2_ITEM = 'S2B_MSIL2A_20261108T065109_R020_T40RCN_20261108T103534';
const pcCrop = (box: CropBox, pixels?: number) => planetaryComputerCropUrl({ collection: 'sentinel-2-l2a', itemId: S2_ITEM }, box, pixels);

function assertValid(box: CropBox, point: { lat: number; lon: number }) {
  assert.ok(box.west >= -180 && box.east <= 180 && box.west < box.east, `longitudes ${box.west}..${box.east}`);
  assert.ok(box.south >= -90 && box.north <= 90 && box.south < box.north, `latitudes ${box.south}..${box.north}`);
  assert.ok(box.south <= point.lat && point.lat <= box.north, 'contains the latitude');
  assert.ok(box.west <= point.lon && point.lon <= box.east, 'contains the longitude');
}

function wmsBox(url: string): CropBox {
  const [south, west, north, east] = new URL(url).searchParams.get('BBOX')!.split(',').map(Number);
  return { west: west!, south: south!, east: east!, north: north! };
}

function pcBox(url: string): CropBox {
  const [west, south, east, north] = /\/item\/bbox\/([^/]+)\//.exec(new URL(url).pathname)![1]!.split(',').map(Number);
  return { west: west!, south: south!, east: east!, north: north! };
}

describe('point crop URLs', () => {
  it('centres a small box on an ordinary point', () => {
    const point = { lat: 25.2, lon: 55.27 };
    const box = cropBox(point);
    assertValid(box, point);
    assert.ok(Math.abs((box.west + box.east) / 2 - point.lon) < 1e-3 && Math.abs((box.south + box.north) / 2 - point.lat) < 1e-3);
  });

  for (const point of [{ lat: -16.5, lon: 179.99 }, { lat: 64.8, lon: -179.995 }]) {
    it(`slides the box inside the antimeridian at ${point.lon}`, () => {
      const box = cropBox(point);
      assertValid(box, point);
      const reference = cropBox({ lat: point.lat, lon: 0 });
      assert.ok(Math.abs((box.east - box.west) - (reference.east - reference.west)) < 1e-3, 'keeps its width');
      for (const url of [pcCrop(box)!, gibsSnapshotUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-11-12', box)!]) {
        assertValid(url.includes('/item/bbox/') ? pcBox(url) : wmsBox(url), point);
      }
    });
  }

  for (const point of [{ lat: 89.99, lon: 10 }, { lat: -90, lon: -45 }, { lat: 90, lon: 179.9 }]) {
    it(`keeps the box inside the pole at ${point.lat}`, () => {
      const box = cropBox(point);
      assertValid(box, point);
      assertValid(wmsBox(eumetsatSnapshotUrl('mtg_fd:rgb_geocolour', '2026-11-13T11:50:00Z', box)!), point);
    });
  }

  it('crops each Planetary Computer collection in its published natural-colour rendering, never the clipped visual asset', () => {
    const box = cropBox({ lat: 25.2, lon: 55.27 });
    const s2 = new URL(pcCrop(box, 256)!);
    assert.match(s2.pathname, /^\/api\/data\/v1\/item\/bbox\/55\.2\d+,25\.1\d+,55\.2\d+,25\.2\d+\/256x256\.png$/);
    assert.deepEqual(s2.searchParams.getAll('assets'), ['B04', 'B03', 'B02']);
    assert.equal(s2.searchParams.get('color_formula'), 'Gamma RGB 3.2 Saturation 0.8 Sigmoidal RGB 25 0.35');
    assert.equal(s2.searchParams.get('nodata'), '0');
    const landsat = new URL(planetaryComputerCropUrl({ collection: 'landsat-c2-l2', itemId: 'LC09_L2SP_160043_20261103_02_T1' }, box)!);
    assert.deepEqual(landsat.searchParams.getAll('assets'), ['red', 'green', 'blue']);
    assert.equal(landsat.searchParams.get('color_formula'), 'gamma RGB 2.7, saturation 1.5, sigmoidal RGB 15 0.55');
    for (const url of [s2, landsat]) {
      assert.ok(!url.searchParams.getAll('assets').includes('visual'), 'not the TCI asset');
      assert.equal(url.searchParams.get('asset_bidx'), null);
    }
    assert.equal(planetaryComputerCropUrl({ collection: 'sentinel-1-slc', itemId: 'S1' }, box), null, 'no crop without a published rendering');
    const radar = new URL(planetaryComputerCropUrl({ collection: 'sentinel-1-grd', itemId: 'S1A_IW_GRDH' }, box)!);
    assert.deepEqual([radar.searchParams.getAll('assets'), radar.searchParams.get('colormap_name')], [['vv'], 'gray'], 'radar crops are greyscale backscatter, VV when the item says nothing');
  });
});

describe('Sentinel-1 co-polarised channel', () => {
  const box = cropBox({ lat: 78.22, lon: 15.65 });
  const radarFeature = (id: string, polarizations?: string[]) => ({
    id,
    collection: 'sentinel-1-grd',
    properties: { datetime: '2026-11-15T15:45:09Z', platform: 'SENTINEL-1D', 'sar:instrument_mode': 'IW', ...(polarizations ? { 'sar:polarizations': polarizations } : {}) },
    assets: Object.fromEntries((polarizations ?? []).map((p) => [p.toLowerCase(), { href: `s3://sentinel-s1-l1c/${p.toLowerCase()}.tiff` }])),
  });
  const assetOf = (url: string | null) => new URL(url!).searchParams.getAll('assets');

  it('crops an HH/HV polar scene from its HH channel', () => {
    for (const archive of ['earth-search', 'planetary-computer'] as const) {
      const item = parseStacItem(archive, radarFeature('S1D_IW_GRDH_1SDH_20261115T154457_20261115T154522_005480_00A78C', ['HH', 'HV']))!;
      assert.deepEqual(item.polarizations, ['HH', 'HV']);
      assert.deepEqual(assetOf(planetaryComputerCropUrl(item, box)), ['hh'], archive);
    }
  });

  it('crops a VV/VH scene from its VV channel', () => {
    const item = parseStacItem('earth-search', radarFeature('S1C_IW_GRDH_1SDV_20261113T104631_20261113T104708_010317_0149B2', ['VV', 'VH']))!;
    assert.deepEqual(item.polarizations, ['VV', 'VH']);
    assert.deepEqual(assetOf(planetaryComputerCropUrl(item, box)), ['vv']);
  });

  it('reads the channel from the product ID when the item has no polarisation list, as a seeded site image does', () => {
    assert.deepEqual(assetOf(planetaryComputerCropUrl({ collection: 'sentinel-1-grd', itemId: 'S1C_EW_GRDM_1SDH_20261114T060556_20261114T060656_010329_014A19' }, box)), ['hh']);
    assert.deepEqual(assetOf(planetaryComputerCropUrl({ collection: 'sentinel-1-grd', itemId: 'S1A_IW_GRDH_1SSH_20261101T000000_20261101T000025_056000_06DA00' }, box)), ['hh']);
    assert.deepEqual(assetOf(planetaryComputerCropUrl({ collection: 'sentinel-1-grd', itemId: 'S1C_IW_GRDH_1SSV_20261101T000000_20261101T000025_010000_013800' }, box)), ['vv']);
    assert.equal(parseStacItem('earth-search', radarFeature('S1D_IW_GRDH_1SDH_20261115T154457_20261115T154522_005480_00A78C'))!.polarizations, null);
  });

  it('prefers the listed polarisations over the product ID, and VV when it has both', () => {
    assert.equal(sentinel1CoPolarisation('S1D_IW_GRDH_1SDV_X', ['hh', 'hv']), 'hh');
    assert.equal(sentinel1CoPolarisation('S1D_IW_GRDH_1SDH_X', ['VV', 'VH']), 'vv');
    assert.equal(sentinel1CoPolarisation('S1D_IW_GRDH_1SDH_X', ['HH', 'VV']), 'vv');
    assert.equal(sentinel1CoPolarisation('S1D_IW_GRDH_1SDH_X', []), 'hh');
    assert.equal(sentinel1CoPolarisation('unknown'), 'vv');
  });

  it('leaves optical crops without a radar channel', () => {
    assert.deepEqual(assetOf(planetaryComputerCropUrl({ collection: 'sentinel-2-l2a', itemId: S2_ITEM, polarizations: ['HH'] }, box)), ['B04', 'B03', 'B02']);
  });
});

describe('preview allowlist', () => {
  it('renders no archive URL that is off the preview allowlist', () => {
    const box = cropBox({ lat: 25.2, lon: 55.27 });
    assert.equal(isAllowedPreviewUrl('https://gibs.earthdata.nasa.gov.example.com/wms'), false);

    const item = parseStacItem('earth-search', {
      id: 'S2C_40RCN_20261103_0_L2A',
      collection: 'sentinel-2-l2a',
      properties: { datetime: '2026-11-03T06:46:40Z', platform: 'sentinel-2c' },
      assets: { thumbnail: { href: 's3://usgs-landsat/collection02/level-2/thumb_small.jpeg' } },
    });
    assert.ok(item);
    assert.equal(item.previewUrl, null, 'a preview on a bucket off the allowlist is not rendered');
  });

  it('accepts the archive hosts the lookup calls', () => {
    const box = cropBox({ lat: 25.2, lon: 55.27 });
    for (const url of [pcCrop(box), gibsSnapshotUrl('MODIS_Aqua_CorrectedReflectance_TrueColor', '2026-11-12', box), eumetsatSnapshotUrl('mtg_fd:rgb_geocolour', '2026-11-13T11:50:00Z', box)]) {
      assert.ok(url && isAllowedPreviewUrl(url), url ?? 'null');
    }
  });
});
