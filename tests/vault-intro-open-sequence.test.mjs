import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(repoRoot, 'src', 'app', 'vault-intro.ts'), 'utf8');

test('vault intro overlay builds a dedicated 3D scene with interior light', () => {
  assert.match(
    src,
    /type OverlayRefs = DoorParts & \{\s+overlay: HTMLDivElement;\s+scene: HTMLDivElement;\s+interior: HTMLDivElement;/m,
    'overlay refs should track the dedicated scene container and interior light layer',
  );
  assert.match(
    src,
    /const scene = document\.createElement\('div'\);[\s\S]*perspective:1400px;/m,
    'overlay should create a perspective scene container for the vault door',
  );
  assert.match(
    src,
    /const interior = document\.createElement\('div'\);[\s\S]*opacity:0;[\s\S]*z-index:0;/m,
    'overlay should create a hidden interior light layer behind the door',
  );
  assert.match(
    src,
    /scene\.appendChild\(interior\);\s+scene\.appendChild\(parts\.root\);/m,
    'interior light should sit behind the door inside the shared 3D scene',
  );
  assert.match(
    src,
    /overlay\.appendChild\(scene\);/m,
    'interior light should sit behind the door inside the shared 3D scene',
  );
});

test('vault intro open sequence animates the full 3D choreography', () => {
  assert.match(
    src,
    /p\.scene\.style\.animation = 'vi-seal-jitter \.34s ease both';/,
    'open sequence should jitter the full scene before the heavy door swing',
  );
  assert.match(
    src,
    /Object\.assign\(p\.interior\.style, \{\s+transition: 'opacity 2\.2s ease 0\.15s',\s+opacity: '1',\s+\}\);/m,
    'open sequence should reveal the interior light as the door opens',
  );
  assert.match(
    src,
    /transformOrigin: 'left center',\s+transform: 'rotateY\(82deg\)',/m,
    'door should swing open from the left hinge inside the 3D scene',
  );
  assert.match(
    src,
    /transition: 'transform 3\.0s cubic-bezier\(0\.2,0,0\.4,1\), opacity 2\.0s ease 0\.1s',\s+transform: 'scale\(1\.06\)',\s+opacity: '0',/m,
    'overlay should dolly forward and fade after the door swing starts',
  );
});
