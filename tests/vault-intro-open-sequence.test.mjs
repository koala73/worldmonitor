import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(repoRoot, 'src', 'app', 'vault-intro.ts'), 'utf8');

test('vault intro overlay builds a dedicated WebGL scene and stores refs needed for opening choreography', () => {
  assert.match(
    src,
    /interface OverlayRefs \{\s+overlay:\s+HTMLDivElement;[\s\S]*vault:\s+VaultScene;/m,
    'overlay refs should include the vault scene handle used by the runtime animation loop',
  );
  assert.match(
    src,
    /const threeCanvas = document\.createElement\('canvas'\);[\s\S]*overlay\.append\(threeCanvas\);/m,
    'overlay should mount a dedicated canvas for the Three.js vault scene',
  );
  assert.match(
    src,
    /const interiorLight = new THREE\.PointLight\(0xA0_C0_FF,\s*0,\s*22\);[\s\S]*scene\.add\(interiorLight\);/m,
    'vault scene should include an interior light that starts dark and ramps during open',
  );
  assert.match(
    src,
    /const vault = buildVaultScene\(threeCanvas, pbr\);[\s\S]*vault\.overlayEl = overlay;[\s\S]*return \{ overlay, scanBtn, quitBtn, statusEl, flashEl, state, vault \};/m,
    'overlay builder should wire DOM refs and the vault scene together for lifecycle control',
  );
});

test('vault intro open sequence animates the full 3D choreography', () => {
  assert.match(
    src,
    /refs\.state\.boltRetractStart = performance\.now\(\);[\s\S]*refs\.state\.openStartTime = performance\.now\(\);/m,
    'open sequence should time-gate the bolt retract phase before triggering door opening',
  );
  assert.match(
    src,
    /vs\.doorLeft\.position\.x\s*=\s*-ease \* 6;[\s\S]*vs\.doorRight\.position\.x\s*=\s*ease \* 6;/m,
    'render loop should split left and right door halves apart during open',
  );
  assert.match(
    src,
    /vs\.camera\.position\.z = vs\.cameraStartZ - ease \* 5;/m,
    'camera should push forward through the opening',
  );
  assert.match(
    src,
    /interiorLight\.intensity = ease \* 28;[\s\S]*vs\.overlayEl\.style\.transition = 'opacity 1\.2s ease';[\s\S]*vs\.overlayEl\.style\.opacity = '0';/m,
    'interior lighting and overlay fade should be driven by the open-progress curve',
  );
});
