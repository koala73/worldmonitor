import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const gateSrc = readFileSync(path.join(repoRoot, 'src/app/biometric-gate.ts'), 'utf8');

describe('biometric gate 3d capability policy', () => {
  it('disables the 3d intro when reduced motion is enabled', async () => {
    const mod = await import('../src/app/biometric-gate-3d.ts');
    assert.equal(
      mod.shouldEnableBiometricGate3D({
        webgl2: true,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        prefersReducedMotion: true,
      }),
      false,
      'reduced motion should force fallback to the non-3d intro',
    );
  });

  it('disables the 3d intro on low-capability devices', async () => {
    const mod = await import('../src/app/biometric-gate-3d.ts');
    assert.equal(
      mod.shouldEnableBiometricGate3D({
        webgl2: false,
        hardwareConcurrency: 2,
        deviceMemory: 2,
        prefersReducedMotion: false,
      }),
      false,
      'low capability profile should keep the fallback intro path',
    );
  });

  it('enables the 3d intro on capable devices', async () => {
    const mod = await import('../src/app/biometric-gate-3d.ts');
    assert.equal(
      mod.shouldEnableBiometricGate3D({
        webgl2: true,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        prefersReducedMotion: false,
      }),
      true,
      'capable profile should allow the 3d intro path',
    );
  });
});

describe('biometric gate 3d integration', () => {
  it('lazy-loads and drives the 3d scene through unlock states', () => {
    assert.match(
      gateSrc,
      /import\('\.\/biometric-gate-3d'\)/,
      'biometric gate should lazy-load the 3d renderer so startup cost only applies to desktop unlock',
    );
    assert.match(
      gateSrc,
      /setAuthenticating\(/,
      'biometric gate should notify the 3d scene when authentication is in progress',
    );
    assert.match(
      gateSrc,
      /setAccessGranted\(/,
      'biometric gate should trigger a 3d success state once authentication succeeds',
    );
    assert.match(
      gateSrc,
      /setDoorOpenProgress\(/,
      'biometric gate should drive 3d door travel progress in sync with the unlock sequence',
    );
  });
});
