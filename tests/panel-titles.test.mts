/**
 * Panel Titles Tests
 *
 * Tests for friendly panel title mappings with emoji.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IRELAND_PANEL_TITLES,
  DEFAULT_PANEL_TITLES,
  getPanelTitleConfig,
  formatPanelTitle,
} from '../src/constants/panelTitles';

// ==============================================================
// Ireland Panel Titles Tests
// ==============================================================

describe('Ireland panel titles', () => {
  it('should define all expected Ireland panels', () => {
    const expectedPanels = [
      'ieTech',
      'ieAcademic',
      'ieSemiconductors',
      'ieDeals',
      'ieJobs',
      'startups',
      'ieSummits',
      'ieBusiness',
      'ai',
    ];

    expectedPanels.forEach(panelId => {
      assert.ok(IRELAND_PANEL_TITLES[panelId], `Missing panel title for ${panelId}`);
    });
  });

  it('each Ireland panel should have emoji and title', () => {
    for (const [panelId, config] of Object.entries(IRELAND_PANEL_TITLES)) {
      assert.ok(config.emoji, `Missing emoji for ${panelId}`);
      assert.ok(config.title, `Missing title for ${panelId}`);
      assert.ok(config.emoji.length > 0, `Empty emoji for ${panelId}`);
      assert.ok(config.title.length > 0, `Empty title for ${panelId}`);
    }
  });

  it('should have correct emoji mappings', () => {
    assert.equal(IRELAND_PANEL_TITLES.ieTech?.emoji, '🇮🇪');
    assert.equal(IRELAND_PANEL_TITLES.ieAcademic?.emoji, '🎓');
    assert.equal(IRELAND_PANEL_TITLES.ieSemiconductors?.emoji, '💎');
    assert.equal(IRELAND_PANEL_TITLES.ieDeals?.emoji, '🏢');
    assert.equal(IRELAND_PANEL_TITLES.ieJobs?.emoji, '💼');
    assert.equal(IRELAND_PANEL_TITLES.startups?.emoji, '🚀');
    assert.equal(IRELAND_PANEL_TITLES.ieSummits?.emoji, '🎤');
    assert.equal(IRELAND_PANEL_TITLES.ieBusiness?.emoji, '📊');
    assert.equal(IRELAND_PANEL_TITLES.ai?.emoji, '🤖');
  });

  it('should have correct title mappings', () => {
    assert.equal(IRELAND_PANEL_TITLES.ieTech?.title, 'Irish Tech News');
    assert.equal(IRELAND_PANEL_TITLES.ieAcademic?.title, 'Academic Research');
    assert.equal(IRELAND_PANEL_TITLES.ieSemiconductors?.title, 'Semiconductor Industry');
    assert.equal(IRELAND_PANEL_TITLES.ieDeals?.title, 'Tech M&A');
    assert.equal(IRELAND_PANEL_TITLES.ieJobs?.title, 'Big Tech Jobs');
    assert.equal(IRELAND_PANEL_TITLES.startups?.title, 'Startups & VC');
    assert.equal(IRELAND_PANEL_TITLES.ieSummits?.title, 'Tech Summits');
    assert.equal(IRELAND_PANEL_TITLES.ieBusiness?.title, 'Business News');
    assert.equal(IRELAND_PANEL_TITLES.ai?.title, 'AI/ML Updates');
  });

  it('should have short titles for mobile', () => {
    // All Ireland panels should have short titles
    for (const [panelId, config] of Object.entries(IRELAND_PANEL_TITLES)) {
      assert.ok(config.shortTitle, `Missing shortTitle for ${panelId}`);
      // Short title should be shorter or equal to full title
      assert.ok(
        (config.shortTitle?.length ?? 0) <= config.title.length,
        `shortTitle should be shorter than title for ${panelId}`
      );
    }
  });
});

// ==============================================================
// Default Panel Titles Tests
// ==============================================================

describe('Default panel titles', () => {
  it('should define common panels', () => {
    const commonPanels = ['politics', 'tech', 'finance', 'ai', 'startups', 'security'];

    commonPanels.forEach(panelId => {
      assert.ok(DEFAULT_PANEL_TITLES[panelId], `Missing default panel title for ${panelId}`);
    });
  });

  it('each default panel should have emoji and title', () => {
    for (const [panelId, config] of Object.entries(DEFAULT_PANEL_TITLES)) {
      assert.ok(config.emoji, `Missing emoji for ${panelId}`);
      assert.ok(config.title, `Missing title for ${panelId}`);
    }
  });
});

// ==============================================================
// getPanelTitleConfig Tests
// ==============================================================

describe('getPanelTitleConfig', () => {
  it('should return Ireland config for Ireland panels', () => {
    const config = getPanelTitleConfig('ieTech', 'ireland');
    assert.ok(config);
    assert.equal(config.emoji, '🇮🇪');
    assert.equal(config.title, 'Irish Tech News');
  });

  it('should return Ireland config without explicit variant', () => {
    // Ireland panels should be found even without variant specified
    const config = getPanelTitleConfig('ieAcademic');
    assert.ok(config);
    assert.equal(config.emoji, '🎓');
  });

  it('should return default config for non-Ireland panels', () => {
    const config = getPanelTitleConfig('politics');
    assert.ok(config);
    assert.equal(config.emoji, '🌍');
    assert.equal(config.title, 'World News');
  });

  it('should return undefined for unknown panels', () => {
    const config = getPanelTitleConfig('unknownPanel');
    assert.equal(config, undefined);
  });

  it('should prefer Ireland config when variant is ireland', () => {
    // 'ai' exists in both Ireland and default
    const irelandConfig = getPanelTitleConfig('ai', 'ireland');
    assert.ok(irelandConfig);
    assert.equal(irelandConfig.emoji, '🤖');
    assert.equal(irelandConfig.title, 'AI/ML Updates');
  });
});

// ==============================================================
// formatPanelTitle Tests
// ==============================================================

describe('formatPanelTitle', () => {
  it('should format title with emoji', () => {
    const title = formatPanelTitle('ieTech', undefined, false, 'ireland');
    assert.equal(title, '🇮🇪 Irish Tech News');
  });

  it('should format title with count', () => {
    const title = formatPanelTitle('ieTech', 15, false, 'ireland');
    assert.equal(title, '🇮🇪 Irish Tech News (15)');
  });

  it('should use short title on mobile', () => {
    const title = formatPanelTitle('ieTech', undefined, true, 'ireland');
    assert.equal(title, '🇮🇪 Irish Tech');
  });

  it('should use short title with count on mobile', () => {
    const title = formatPanelTitle('ieAcademic', 9, true, 'ireland');
    assert.equal(title, '🎓 Academia (9)');
  });

  it('should fallback to capitalized panel ID for unknown panels', () => {
    const title = formatPanelTitle('customPanel');
    assert.equal(title, 'CustomPanel');
  });

  it('should fallback with count for unknown panels', () => {
    const title = formatPanelTitle('customPanel', 5);
    assert.equal(title, 'CustomPanel (5)');
  });

  it('should handle zero count', () => {
    const title = formatPanelTitle('ieBusiness', 0, false, 'ireland');
    assert.equal(title, '📊 Business News (0)');
  });
});

// ==============================================================
// Panel Title Consistency Tests
// ==============================================================

describe('Panel title consistency', () => {
  it('Ireland and default should not have conflicting configs', () => {
    // If a panel exists in both, they should have consistent emoji
    for (const panelId of Object.keys(IRELAND_PANEL_TITLES)) {
      const irelandConfig = IRELAND_PANEL_TITLES[panelId];
      const defaultConfig = DEFAULT_PANEL_TITLES[panelId];
      
      if (irelandConfig && defaultConfig) {
        // Both configs exist - emoji should match
        assert.equal(
          irelandConfig.emoji,
          defaultConfig.emoji,
          `Emoji mismatch for ${panelId}: Ireland=${irelandConfig.emoji}, Default=${defaultConfig.emoji}`
        );
      }
    }
  });

  it('all emojis should be non-empty strings', () => {
    const allConfigs = { ...DEFAULT_PANEL_TITLES, ...IRELAND_PANEL_TITLES };
    
    for (const [panelId, config] of Object.entries(allConfigs)) {
      // Emoji should be non-empty (composed emoji can be up to 7+ code points)
      assert.ok(
        config.emoji.length >= 1,
        `Empty emoji for ${panelId}`
      );
      // Emoji shouldn't be too long (probably misconfigured if > 10 chars)
      assert.ok(
        config.emoji.length <= 10,
        `Suspiciously long emoji for ${panelId}: "${config.emoji}" (length: ${config.emoji.length})`
      );
    }
  });
});
