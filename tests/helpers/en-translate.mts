/**
 * A node stand-in for i18next's `t` over the real English catalog, for suites
 * that inject a translator instead of loading the i18n runtime. Unknown keys
 * throw so a typo cannot pass as the key string.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function catalogTranslate(locale = 'en') {
  const catalog = JSON.parse(readFileSync(resolve(root, `src/locales/${locale}.json`), 'utf8'));
  return (key: string, vars: Record<string, string | number> = {}): string => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
    if (typeof value !== 'string') throw new Error(`missing ${locale} catalog key: ${key}`);
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`missing {{${name}}} for ${key}`);
      return String(vars[name]);
    });
  };
}

export const enTranslate = catalogTranslate('en');
