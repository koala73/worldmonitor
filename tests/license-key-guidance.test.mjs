import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('license-key help documents the real creation and recovery flow', () => {
  const guide = read('docs/api-keys.mdx');

  assert.match(guide, /Select \*\*Settings\*\*/);
  assert.match(guide, /Open the \*\*API Keys\*\* tab/);
  assert.match(guide, /API Starter[^\n]+API Business/);
  assert.match(guide, /Dashboard Pro does not include manual API keys/);
  assert.match(guide, /full key is shown only once/i);
  assert.match(guide, /Revoke the key whose full value you lost/);
  assert.match(guide, /never send a complete key/i);
});

test('license-key help is discoverable from docs navigation and support', () => {
  const docsConfig = JSON.parse(read('docs/docs.json'));
  const navigation = docsConfig.navigation;
  const englishTabs = navigation.tabs ?? navigation.languages.find((lang) => lang.language === 'en').tabs;
  const documentationTab = englishTabs.find((tab) => tab.tab === 'Documentation');
  const usageGroup = documentationTab.groups.find((group) => group.group === 'Usage');

  assert.ok(usageGroup.pages.includes('api-keys'));
  assert.match(read('docs/support.mdx'), /\/api-keys/);
  assert.match(read('public/support.md'), /\/docs\/api-keys/);
});

test('desktop settings give blocked users an exact help path', () => {
  const english = JSON.parse(read('src/locales/en.json'));
  const englishShell = JSON.parse(read('src/locales/en.shell.json'));
  const fullCopy = english.modals.settingsWindow.worldMonitor;
  const shellCopy = englishShell.modals.settingsWindow.worldMonitor;

  assert.equal(fullCopy.apiKey.title, 'License / API Key');
  assert.match(fullCopy.apiKey.description, /Settings → API Keys/);
  assert.match(fullCopy.register.description, /worldmonitor\.app\/docs\/api-keys/);
  assert.equal(fullCopy.register.submitBtn, 'View API plans');
  assert.deepEqual(shellCopy, fullCopy);
});

test('every locale describes the launched API-key flow instead of a waitlist', () => {
  const localeDir = new URL('../src/locales/', import.meta.url);
  const localeFiles = readdirSync(localeDir).filter((file) => file.endsWith('.json'));

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'));
    const copy = locale.modals.settingsWindow.worldMonitor;

    assert.match(copy.apiKey.title, /API/, `${file}: key title must identify the API key`);
    assert.match(copy.apiKey.description, /API Starter/, `${file}: key description must name API Starter`);
    assert.match(copy.apiKey.description, /API Business/, `${file}: key description must name API Business`);
    assert.match(copy.apiKey.description, /Settings → API Keys/, `${file}: key description must give the exact dashboard path`);
    assert.match(copy.register.title, /API/, `${file}: help title must identify the API key`);
    assert.match(copy.register.description, /worldmonitor\.app\/docs\/api-keys/, `${file}: help copy must link the guide`);
    assert.match(copy.register.description, /API Starter/, `${file}: help copy must name API Starter`);
    assert.match(copy.register.description, /API Business/, `${file}: help copy must name API Business`);
    assert.match(copy.register.submitBtn, /API/, `${file}: CTA must point to API plans`);
  }
});
