import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStacItem } from '../src/services/orbital/archive-stac.ts';
import { cropBox, eumetsatSnapshotUrl, gibsSnapshotUrl, planetaryComputerCropUrl, type CropBox } from '../src/services/orbital/crop-url.ts';
import { isAllowedPreviewUrl } from '../src/utils/imagery-preview.ts';

const PREVIEW = 'https://planetarycomputer.microsoft.com/api/data/v1/item/preview.png?collection=sentinel-2-l2a&item=S2B_MSIL2A_20261108T065109_R020_T40RCN_20261108T103534&assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0&format=png';

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
      for (const url of [planetaryComputerCropUrl(PREVIEW, box)!, gibsSnapshotUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-11-12', box)!]) {
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

  it('crops a Planetary Computer item with the rendering the archive publishes', () => {
    const url = new URL(planetaryComputerCropUrl(PREVIEW, cropBox({ lat: 25.2, lon: 55.27 }), 256)!);
    assert.match(url.pathname, /^\/api\/data\/v1\/item\/bbox\/55\.2\d+,25\.1\d+,55\.2\d+,25\.2\d+\/256x256\.png$/);
    assert.equal(url.searchParams.get('assets'), 'visual');
    assert.equal(url.searchParams.get('asset_bidx'), 'visual|1,2,3');
    assert.equal(url.searchParams.get('format'), null);
  });
});

describe('preview allowlist', () => {
  it('renders no archive URL that is off the preview allowlist', () => {
    const box = cropBox({ lat: 25.2, lon: 55.27 });
    assert.equal(planetaryComputerCropUrl(PREVIEW.replace('planetarycomputer.microsoft.com', 'tiles.example.com'), box), null);
    assert.equal(planetaryComputerCropUrl(PREVIEW.replace('https:', 'http:'), box), null);
    assert.equal(planetaryComputerCropUrl('not a url', box), null);
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
    for (const url of [planetaryComputerCropUrl(PREVIEW, box), gibsSnapshotUrl('MODIS_Aqua_CorrectedReflectance_TrueColor', '2026-11-12', box), eumetsatSnapshotUrl('mtg_fd:rgb_geocolour', '2026-11-13T11:50:00Z', box)]) {
      assert.ok(url && isAllowedPreviewUrl(url), url ?? 'null');
    }
  });
});
