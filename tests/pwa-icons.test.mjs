import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const config = readFileSync(new URL('vite.config.ts', root), 'utf8');
// Shortcuts carry their own one-line `icons: [...]`; the manifest list is the
// multi-line array.
const icons = vm.runInNewContext(config.match(/icons: (\[\n[\s\S]*?\n\s*\]),/)[1]);

it('advertises real PNGs at every install size with separate maskable assets', async () => {
  for (const size of [192, 384, 512, 1024]) {
    const dimensions = `${size}x${size}`;
    const any = icons.find(icon => icon.sizes === dimensions && (!icon.purpose || icon.purpose === 'any'));
    const maskable = icons.find(icon => icon.sizes === dimensions && icon.purpose === 'maskable');
    assert.ok(any, `missing any icon at ${dimensions}`);
    assert.ok(maskable, `missing maskable icon at ${dimensions}`);
    assert.notEqual(any.src, maskable.src);
    for (const icon of [any, maskable]) {
      const metadata = await sharp(fileURLToPath(new URL(`public${icon.src}`, root))).metadata();
      assert.equal(icon.type, 'image/png');
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
    }
  }
});

it('keeps maskable artwork inside the central 80% circle on an opaque theme background', async () => {
  for (const icon of icons.filter(icon => icon.purpose === 'maskable')) {
    const { data, info } = await sharp(fileURLToPath(new URL(`public${icon.src}`, root)))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let artworkPixels = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * 4;
        assert.equal(data[offset + 3], 255, `${icon.src}: transparent pixel`);
        const background = data[offset] === 10 && data[offset + 1] === 15 && data[offset + 2] === 10;
        if (!background) artworkPixels++;
        if (Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) > info.width * 0.4) {
          assert.ok(background, `${icon.src}: artwork outside safe circle at ${x},${y}`);
        }
      }
    }
    assert.ok(artworkPixels > info.width * info.height * 0.2, `${icon.src}: missing artwork`);
  }
});
