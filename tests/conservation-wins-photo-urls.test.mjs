import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const SPECIES = JSON.parse(readFileSync(new URL('../src/data/conservation-wins.json', import.meta.url), 'utf8'));

// Wikimedia rejects hotlinked thumbnails at any other width with HTTP 400.
// https://www.mediawiki.org/wiki/Common_thumbnail_sizes
const WIKIMEDIA_THUMB_WIDTHS = new Set([20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840]);

const THUMB_URL = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)\/(\d+)px-([^/]+)$/;

describe('conservation-wins photo URLs', () => {
  for (const { id, photoUrl } of SPECIES) {
    it(`${id} requests a thumbnail Wikimedia serves`, () => {
      const m = photoUrl.match(THUMB_URL);
      assert.ok(m, `${photoUrl} is not a Commons thumbnail URL`);
      const [, dir1, dir2, file, width, thumbFile] = m;
      assert.ok(WIKIMEDIA_THUMB_WIDTHS.has(Number(width)), `${width}px is not a standard Wikimedia thumbnail width`);
      assert.equal(thumbFile, file, 'thumbnail name must match the original file name');
      // Commons stores each file under the first one and two hex digits of the MD5 of its name.
      const md5 = createHash('md5').update(decodeURIComponent(file)).digest('hex');
      assert.equal(`${dir1}/${dir2}`, `${md5[0]}/${md5.slice(0, 2)}`, `${file} is stored under a different hash directory`);
    });
  }
});
