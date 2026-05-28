import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

describe('energy variant renewable wiring', () => {
  it('energy variant enables the renewable panel', () => {
    const panels = src('src/config/panels.ts');
    const energyPanelsBlock = panels.match(/const ENERGY_PANELS:[\s\S]*?^};/m);
    assert.ok(energyPanelsBlock, 'ENERGY_PANELS block not found');
    assert.match(
      energyPanelsBlock[0],
      /\brenewable:\s*\{\s*name:\s*'Renewable Energy'/,
      'energy variant must keep renewable enabled in ENERGY_PANELS',
    );
  });

  it('panel-layout mounts renewable for any variant that enables it', () => {
    const layout = src('src/app/panel-layout.ts');
    assert.match(
      layout,
      /Renewable Energy is shared by happy and energy variants\.[\s\S]*?shouldCreatePanel\('renewable'\)[\s\S]*?this\.lazyPanel\('renewable'/,
      'panel-layout.ts must mount RenewableEnergyPanel via shouldCreatePanel() so energy can instantiate it',
    );
  });

  it('data-loader hydrates renewable outside the happy-only branch', () => {
    const loader = src('src/app/data-loader.ts');
    assert.match(
      loader,
      /Renewable panel is shared by happy and energy variants\.[\s\S]*?if \(shouldLoad\('renewable'\)\) \{[\s\S]*?this\.loadRenewableData\(\)/,
      'data-loader.ts must schedule renewable loading for energy as well as happy',
    );
  });
});
