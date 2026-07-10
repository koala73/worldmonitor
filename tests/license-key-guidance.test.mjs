import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const documentationTab = docsConfig.navigation.tabs.find((tab) => tab.tab === 'Documentation');
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
