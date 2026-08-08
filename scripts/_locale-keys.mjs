/**
 * Shared helpers for i18n locale tooling (sync script + completeness test).
 */

/**
 * Flatten a nested translation object into dot-delimited leaf paths.
 * Arrays are treated as leaf values (translations are objects of strings).
 *
 * Assumes individual keys contain no literal `.` — matching i18next's default
 * `keySeparator: '.'`, where a dotted key would itself be ambiguous at runtime.
 *
 * @param {unknown} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function flattenKeys(obj, prefix = '') {
  /** @type {string[]} */
  const keys = [];

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        keys.push(...flattenKeys(value, path));
      } else {
        keys.push(path);
      }
    }
  }

  return keys;
}
