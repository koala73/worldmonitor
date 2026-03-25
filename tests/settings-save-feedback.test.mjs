import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(path) {
  return readFileSync(join(root, path), 'utf-8');
}

describe('settings save feedback guardrails', () => {
  const toastSrc = src('src/utils/toast.ts');
  const settingsSrc = src('src/components/UnifiedSettings.ts');
  const prefsSrc = src('src/services/preferences-content.ts');
  const handlersSrc = src('src/app/event-handlers.ts');
  const countryIntelSrc = src('src/app/country-intel.ts');

  it('uses a shared body-level toast utility with role=status', () => {
    assert.match(toastSrc, /export function showToast\(message: string\): void/);
    assert.match(toastSrc, /toast\.setAttribute\('role', 'status'\)/);
    assert.match(toastSrc, /document\.querySelector\('\.toast-notification'\)\?\.remove\(\)/);
  });

  it('shows saved feedback for Preferences through renderPreferences callback', () => {
    assert.match(settingsSrc, /onSettingSaved:\s*\(\)\s*=>\s*showToast\(t\('modals\.settingsWindow\.saved'\)\)/);
    assert.match(prefsSrc, /onSettingSaved\?: \(\) => void;/);
    assert.match(prefsSrc, /host\.onSettingSaved\?\.\(\);/);
  });

  it('keeps Panels save on inline status only', () => {
    const saveMatch = settingsSrc.match(/private savePanelChanges\(\): void \{([\s\S]*?)\n {2}\}/);
    assert.ok(saveMatch, 'savePanelChanges() not found');
    assert.doesNotMatch(saveMatch[1], /showToast\(/);
  });

  it('removes duplicate global toast implementations from event handlers and country intel', () => {
    assert.match(handlersSrc, /import \{ showToast \} from '@\/utils\/toast';/);
    assert.match(countryIntelSrc, /import \{ showToast \} from '@\/utils\/toast';/);
    assert.doesNotMatch(handlersSrc, /\n\s*showToast\(msg: string\): void \{/);
    assert.doesNotMatch(countryIntelSrc, /\n\s*showToast\(msg: string\): void \{/);
  });
});
