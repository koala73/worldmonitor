import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('license-key help documents the real creation and recovery flow', () => {
  const guide = read('docs/api-keys.mdx');

  assert.match(guide, /Select \*\*Settings\*\*/);
  assert.match(guide, /Open the \*\*API Keys\*\* tab/);
  assert.match(guide, /API Starter[^\n]+API Business/);
  assert.match(guide, /Dashboard Pro and Pro Business do not include API keys/);
  assert.match(guide, /select \*\*Create desktop key\*\*/);
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

  // Plan 2026-10-25-001 U6: Pro works through sign-in, so sign-in leads and
  // the key box is the "Desktop key" alternative that API-plan keys also fit.
  assert.equal(fullCopy.apiKey.title, 'Desktop key');
  assert.match(fullCopy.signIn.description, /sign in/i);
  assert.match(fullCopy.apiKey.description, /Settings → API Keys/);
  assert.match(fullCopy.apiKey.description, /API-plan keys also work/);
  assert.match(fullCopy.apiKey.description, /shared or public deployments need an API plan/);
  assert.match(fullCopy.apiKey.description, /worldmonitor\.app\/docs\/api-keys/);
  assert.equal(fullCopy.register.submitBtn, 'View plans');
  assert.deepEqual(shellCopy, fullCopy);
});

test('every locale describes the launched key flow instead of a waitlist', () => {
  const localeDir = new URL('../src/locales/', import.meta.url);
  const localeFiles = readdirSync(localeDir).filter((file) => file.endsWith('.json'));

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'));
    const copy = locale.modals.settingsWindow.worldMonitor;

    assert.match(copy.apiKey.description, /Settings → API Keys/, `${file}: key description must give the exact dashboard path`);
    assert.match(JSON.stringify(copy), /worldmonitor\.app\/docs\/api-keys/, `${file}: help copy must link the guide`);
    assert.doesNotMatch(JSON.stringify(copy), /waitlist/i, `${file}: no waitlist copy`);
  }
});
