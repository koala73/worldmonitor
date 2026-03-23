/**
 * Ireland Variant Config Integrity Tests
 *
 * Verifies the Ireland variant configuration structure and completeness
 * by reading the source files directly (avoids runtime dependency issues).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const IRELAND_DIR = resolve(import.meta.dirname, '../src/config/variants/ireland');

describe('Ireland Variant Config Integrity', () => {
  describe('Directory structure', () => {
    it('has data/ directory with required files', () => {
      const dataDir = resolve(IRELAND_DIR, 'data');
      assert.ok(existsSync(dataDir), 'data/ directory should exist');
      assert.ok(existsSync(resolve(dataDir, 'data-centers.ts')), 'data-centers.ts should exist');
      assert.ok(existsSync(resolve(dataDir, 'tech-hqs.ts')), 'tech-hqs.ts should exist');
      assert.ok(existsSync(resolve(dataDir, 'unicorns.ts')), 'unicorns.ts should exist');
      assert.ok(existsSync(resolve(dataDir, 'semiconductor-hubs.ts')), 'semiconductor-hubs.ts should exist');
      assert.ok(existsSync(resolve(dataDir, 'index.ts')), 'data/index.ts should exist');
    });

    it('has utils/ directory with required files', () => {
      const utilsDir = resolve(IRELAND_DIR, 'utils');
      assert.ok(existsSync(utilsDir), 'utils/ directory should exist');
      assert.ok(existsSync(resolve(utilsDir, 'filters.ts')), 'filters.ts should exist');
      assert.ok(existsSync(resolve(utilsDir, 'index.ts')), 'utils/index.ts should exist');
    });
  });

  describe('Config file structure', () => {
    it('ireland.ts exports VariantConfig', () => {
      const configPath = resolve(IRELAND_DIR, '../ireland.ts');
      const content = readFileSync(configPath, 'utf-8');
      
      assert.ok(content.includes('VARIANT_CONFIG'), 'should export VARIANT_CONFIG');
      assert.ok(content.includes('VariantConfig'), 'should reference VariantConfig type');
      assert.ok(content.includes('name:'), 'VARIANT_CONFIG should have name field');
      assert.ok(content.includes('description:'), 'VARIANT_CONFIG should have description field');
      assert.ok(content.includes('panels:'), 'VARIANT_CONFIG should have panels field');
      assert.ok(content.includes('mapLayers:'), 'VARIANT_CONFIG should have mapLayers field');
    });

    it('has Ireland-specific FEEDS configuration', () => {
      const configPath = resolve(IRELAND_DIR, '../ireland.ts');
      const content = readFileSync(configPath, 'utf-8');
      
      assert.ok(content.includes('ieTech'), 'should have ieTech feeds');
      assert.ok(content.includes('ieAcademic'), 'should have ieAcademic feeds');
      assert.ok(content.includes('ieSemiconductors'), 'should have ieSemiconductors feeds');
      assert.ok(content.includes('ieBusiness'), 'should have ieBusiness feeds');
      assert.ok(content.includes('ieDeals'), 'should have ieDeals feeds');
      assert.ok(content.includes('ieJobs'), 'should have ieJobs feeds');
    });

    it('has Ireland-specific PANELS configuration', () => {
      const configPath = resolve(IRELAND_DIR, '../ireland.ts');
      const content = readFileSync(configPath, 'utf-8');
      
      assert.ok(content.includes("PANELS:"), 'should define PANELS');
      assert.ok(content.includes("ieTech:"), 'should have ieTech panel');
      assert.ok(content.includes("ieSemiconductors:"), 'should have ieSemiconductors panel');
    });

    it('has Ireland geographic constants', () => {
      const configPath = resolve(IRELAND_DIR, '../ireland.ts');
      const content = readFileSync(configPath, 'utf-8');
      
      assert.ok(content.includes('IRELAND_BOUNDS'), 'should export IRELAND_BOUNDS');
      assert.ok(content.includes('IRELAND_CENTER'), 'should export IRELAND_CENTER');
      assert.ok(content.includes('IRELAND_DEFAULT_ZOOM'), 'should export IRELAND_DEFAULT_ZOOM');
      assert.ok(content.includes('IRELAND_MIN_ZOOM'), 'should export IRELAND_MIN_ZOOM');
    });

    it('enables Ireland-specific map layers', () => {
      const configPath = resolve(IRELAND_DIR, '../ireland.ts');
      const content = readFileSync(configPath, 'utf-8');
      
      assert.ok(content.includes('semiconductorHubs: true'), 'should enable semiconductorHubs');
      assert.ok(content.includes('irelandDataCenters: true'), 'should enable irelandDataCenters');
      assert.ok(content.includes('irelandTechHQs: true'), 'should enable irelandTechHQs');
      assert.ok(content.includes('irishUnicorns: true'), 'should enable irishUnicorns');
    });
  });

  describe('No global Ireland-specific dependencies', () => {
    it('ireland.ts does not import from @/data/', () => {
      const configPath = resolve(IRELAND_DIR, '../ireland.ts');
      const content = readFileSync(configPath, 'utf-8');
      
      // Should not import from old @/data/ location
      assert.ok(!content.includes("from '@/data/"), 'should not import from @/data/');
    });

    it('ireland/data/*.ts files are self-contained', () => {
      const dataDir = resolve(IRELAND_DIR, 'data');
      const files = ['data-centers.ts', 'tech-hqs.ts', 'unicorns.ts', 'semiconductor-hubs.ts'];
      
      for (const file of files) {
        const content = readFileSync(resolve(dataDir, file), 'utf-8');
        // Data files should not import from global configs
        assert.ok(!content.includes("from '@/config/"), `${file} should not import from @/config/`);
      }
    });

    it('ireland/utils/*.ts files are self-contained', () => {
      const utilsDir = resolve(IRELAND_DIR, 'utils');
      const content = readFileSync(resolve(utilsDir, 'filters.ts'), 'utf-8');
      
      // Utils should not import from global configs
      assert.ok(!content.includes("from '@/config/"), 'filters.ts should not import from @/config/');
    });
  });

  describe('base.ts VariantConfig interface', () => {
    it('defines VariantConfig interface', () => {
      const basePath = resolve(IRELAND_DIR, '../base.ts');
      const content = readFileSync(basePath, 'utf-8');
      
      assert.ok(content.includes('interface VariantConfig'), 'should define VariantConfig interface');
      assert.ok(content.includes('name: string'), 'VariantConfig should have name field');
      assert.ok(content.includes('description: string'), 'VariantConfig should have description field');
      assert.ok(content.includes('panels:'), 'VariantConfig should have panels field');
      assert.ok(content.includes('mapLayers:'), 'VariantConfig should have mapLayers field');
    });
  });
});
