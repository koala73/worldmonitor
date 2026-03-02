/**
 * Utility for exporting and importing World Monitor dashboard settings.
 */

export interface ExportedSettings {
  version: number;
  timestamp: string;
  variant: string;
  data: Record<string, string>;
}

// 5MB limit for imported settings JSON
const MAX_IMPORT_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Validates if a localStorage key is safe to export/import.
 * Excludes transient caches and sensitive secrets (API keys, tokens).
 */
function isKeySafeToExport(key: string): boolean {
  // Ignore massive internal caches or transient states to avoid bloated JSON
  if (
    key.startsWith('wm-cache-') ||
    key.includes('vesselPosture') ||
    key.includes('wm-secrets-updated') ||
    key.includes('wm-waitlist-registered') ||
    key.includes('wm-debug-log') ||
    key.includes('wm-settings-open')
  ) {
    return false;
  }

  // Strictly exclude potential secrets: API keys, tokens, passwords.
  if (/secret|token|key|password|auth/i.test(key)) {
    return false;
  }

  return true;
}

export function exportSettings(): void {
  try {
    const data: Record<string, string> = {};

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      if (!isKeySafeToExport(key)) {
        continue;
      }

      const value = localStorage.getItem(key);
      if (value !== null) {
        data[key] = value;
      }
    }

    const exportData: ExportedSettings = {
      version: 1,
      timestamp: new Date().toISOString(),
      variant: localStorage.getItem('worldmonitor-variant') || 'full',
      data,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `worldmonitor-settings-${timestampStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    // Surface a meaningful error when localStorage (or related browser APIs) are unavailable
    console.error('Failed to export World Monitor settings: localStorage may be unavailable or blocked.', err);
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(
        'Failed to export settings because browser storage is unavailable. ' +
        'Please check your browser privacy settings and try again.'
      );
    }
  }
}

export function importSettings(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMPORT_SIZE_BYTES) {
      reject(new Error(`File is too large. Maximum size is 5MB.`));
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const result = e.target?.result as string;
        const parsed = JSON.parse(result) as ExportedSettings;

        if (!parsed || !parsed.data || typeof parsed.data !== 'object') {
          throw new Error('Invalid format: parsed data is missing or not an object.');
        }

        // Ask for user confirmation before overwriting localStorage
        const confirmMsg = parsed.variant
          ? `Replace current settings with the imported ${parsed.variant} settings bundle?`
          : 'Replace current settings with the imported configuration?';

        if (!window.confirm(confirmMsg)) {
          resolve(); // user cancelled
          return;
        }

        // Apply settings
        let keysImported = 0;
        for (const [key, value] of Object.entries(parsed.data)) {
          // Re-apply the EXACT same safety filter as export
          if (isKeySafeToExport(key) && typeof value === 'string') {
            localStorage.setItem(key, value);
            keysImported++;
          }
        }

        if (window.confirm(`Successfully imported ${keysImported} settings. Reload now to apply changes?`)) {
          window.location.reload();
        }

        resolve();
      } catch (err) {
        console.error('Failed to parse imported settings:', err);
        reject(err);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
