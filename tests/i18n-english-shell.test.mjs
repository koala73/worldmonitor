import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  replaceRawI18nKeyPlaceholderText,
  replaceRawI18nKeyPlaceholders,
  translateRawI18nKeyPlaceholder,
} from '../src/app/i18n-raw-key-healer.ts';

const I18N_SOURCE = 'src/services/i18n.ts';
const APP_SOURCE = 'src/App.ts';
const EN_LOCALE = 'src/locales/en.json';
const EN_SHELL_LOCALE = 'src/locales/en.shell.json';
const COMPONENTS_DIR = 'src/components';
const SHELL_BUDGET_BYTES = 50 * 1024;

function tsFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

const EAGER_CHROME_FILES = [
  'src/App.ts',
  'src/app/panel-layout.ts',
  'src/settings-main.ts',
  'src/settings-window.ts',
  ...tsFilesUnder(COMPONENTS_DIR),
];

const SHELL_KEY_PREFIXES = [
  'shell.',
  'header.',
  'panels.',
  'common.',
  'connectivity.',
  'premium.',
  'auth.',
  'mcp.',
  'widgets.',
  'countryBrief.levels.',
  'countryBrief.trends.',
  'countryBrief.fallback.',
  'contextMenu.',
  'components.deckgl.views.',
  'components.map.',
  'components.panel.',
  'components.proBanner.',
  'components.settings.',
  'modals.runtimeConfig.',
  'modals.settingsWindow.',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function lookup(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function leafPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.keys(value).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return leafPaths(value[key], path);
  });
}

function extractLiteralTranslationKeys(source) {
  return [...source.matchAll(/\bt\(\s*['`]([^'`$]+)['`]/g)]
    .map((match) => match[1])
    .filter((key) => key && !key.endsWith('.'));
}

function isShellKey(key) {
  return SHELL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    || key.endsWith('.infoTooltip')
    || key.endsWith('.methodologyNote')
    || key.endsWith('.title');
}

function eagerChromeKeys() {
  const keys = new Set();
  for (const file of EAGER_CHROME_FILES) {
    for (const key of extractLiteralTranslationKeys(readFileSync(file, 'utf8'))) {
      if (isShellKey(key)) keys.add(key);
    }
  }
  return [...keys].sort();
}

describe('English i18n shell split', () => {
  it('keeps the full English dictionary out of static i18n imports', () => {
    const source = readFileSync(I18N_SOURCE, 'utf8');

    assert.doesNotMatch(
      source,
      /import\s+[^;]*['"]\.\.\/locales\/en\.json['"]/,
      'src/services/i18n.ts must not statically import the full English locale',
    );
    assert.match(
      source,
      /import\s+[^;]*['"]\.\.\/locales\/en\.shell\.json['"]/,
      'src/services/i18n.ts should statically import only the English shell locale',
    );
    assert.match(
      source,
      /!\.\.\/locales\/en\.shell\.json/,
      'the locale glob should exclude only en.shell.json so en.json remains lazy-loadable',
    );
    assert.doesNotMatch(
      source,
      /!\.\.\/locales\/en\.json/,
      'the full English locale must not be excluded from lazy locale modules',
    );
    assert.match(
      source,
      /then\(\(language\)\s*=>\s*notifyLanguageResourcesLoaded\(language\)\)/,
      'full English preload should notify translation listeners after the lazy bundle loads',
    );
    assert.match(
      source,
      /wm:i18n:resources-loaded/,
      'full English preload should expose a browser event for resource-aware UI updates',
    );

    const appSource = readFileSync(APP_SOURCE, 'utf8');
    assert.match(
      appSource,
      /addEventListener\('wm:i18n:resources-loaded',\s*this\.handleI18nResourcesLoaded\)/,
      'App should listen for full English preload completion',
    );
    assert.match(
      appSource,
      /replaceRawI18nKeyPlaceholders\(this\.state\.container,\s*t\)/,
      'App should heal already-rendered raw i18n keys after full English loads',
    );
  });

  it('keeps first-paint English shell strings bounded and in sync with en.json', () => {
    const full = readJson(EN_LOCALE);
    const shell = readJson(EN_SHELL_LOCALE);
    const shellBytes = Buffer.byteLength(readFileSync(EN_SHELL_LOCALE, 'utf8'));

    assert.ok(
      shellBytes < SHELL_BUDGET_BYTES,
      `expected ${EN_SHELL_LOCALE} to stay below ${SHELL_BUDGET_BYTES} bytes, got ${shellBytes}`,
    );

    const requiredPaths = [
      'shell',
      'header',
      'panels',
      'common',
      'connectivity',
      'components.deckgl.views',
      'components.map.hideMap',
      'components.map.showMap',
      'components.panel.addPanel',
      'modals.runtimeConfig.title',
      'widgets.createInteractive',
      'widgets.proBadge',
      'countryBrief.levels',
      'countryBrief.trends',
      'countryBrief.fallback',
      ...eagerChromeKeys(),
    ];

    for (const path of [...new Set(requiredPaths)].sort()) {
      assert.notEqual(lookup(full, path), undefined, `${path} should exist in ${EN_LOCALE}`);
      assert.deepEqual(lookup(shell, path), lookup(full, path), `${path} should match ${EN_LOCALE}`);
    }

  });

  it('keeps every English shell leaf byte-for-byte aligned with en.json', () => {
    const full = readJson(EN_LOCALE);
    const shell = readJson(EN_SHELL_LOCALE);

    for (const path of leafPaths(shell).sort()) {
      assert.notEqual(lookup(full, path), undefined, `${path} shell leaf should exist in ${EN_LOCALE}`);
      assert.deepEqual(
        lookup(shell, path),
        lookup(full, path),
        `${path} shell leaf should match ${EN_LOCALE} exactly`,
      );
    }
  });

  it('heals exact raw i18n placeholders without rewriting unresolved or prose-like text', () => {
    const translations = new Map([
      ['components.panel.addPanel', 'Add panel'],
      ['header.live', 'Live'],
      ['common.search', 'Find $& $1 $$'],
    ]);
    const translate = (key) => translations.get(key) ?? key;

    assert.equal(
      translateRawI18nKeyPlaceholder('components.panel.addPanel', translate),
      'Add panel',
      'exact raw keys should translate when the full English dictionary has the key',
    );
    assert.equal(
      translateRawI18nKeyPlaceholder('domain/v1.2-like text', translate),
      null,
      'domain/version-like prose should not match the raw i18n key heuristic',
    );
    assert.equal(
      translateRawI18nKeyPlaceholder('forecast.deepMissingKey', translate),
      null,
      'unresolved i18n keys should remain untouched',
    );
    assert.equal(
      replaceRawI18nKeyPlaceholderText('\n  common.search  \t', translate),
      '\n  Find $& $1 $$  \t',
      'replacement should preserve outer whitespace and treat $ literally',
    );
  });

  it('heals text nodes and translatable attributes inside a container', () => {
    class FakeText {
      constructor(value) {
        this.nodeType = 3;
        this.nodeValue = value;
        this.childNodes = [];
      }
    }

    class FakeElement {
      constructor(attrs = {}, children = []) {
        this.nodeType = 1;
        this.childNodes = children;
        this.attrs = { ...attrs };
      }

      getAttribute(name) {
        return this.attrs[name] ?? null;
      }

      setAttribute(name, value) {
        this.attrs[name] = value;
      }

      querySelectorAll() {
        const elements = [];
        const visit = (node) => {
          if (node.nodeType !== 1) return;
          if (['aria-label', 'title', 'placeholder'].some((attr) => node.getAttribute(attr))) {
            elements.push(node);
          }
          for (const child of node.childNodes) visit(child);
        };
        for (const child of this.childNodes) visit(child);
        return elements;
      }
    }

    const text = new FakeText('  components.panel.addPanel\n');
    const unresolved = new FakeText(' domain/v1.2-like text ');
    const child = new FakeElement({ 'aria-label': 'header.live', title: 'forecast.deepMissingKey' }, [
      text,
      unresolved,
    ]);
    const root = new FakeElement({}, [child]);
    const translations = new Map([
      ['components.panel.addPanel', 'Add panel'],
      ['header.live', 'Live'],
    ]);

    replaceRawI18nKeyPlaceholders(root, (key) => translations.get(key) ?? key);

    assert.equal(text.nodeValue, '  Add panel\n');
    assert.equal(unresolved.nodeValue, ' domain/v1.2-like text ');
    assert.equal(child.getAttribute('aria-label'), 'Live');
    assert.equal(child.getAttribute('title'), 'forecast.deepMissingKey');
  });
});
