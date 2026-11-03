/**
 * Shared helpers for i18n locale tooling.
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
const LOCALE_PATH_TOKENS_RE = /^([^[]*)((?:\[\d+\])*)$/;
const LOCALE_PATH_TOKENS_RE_2 = /\[(\d+)\]/g;

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

/**
 * Tokenize a flattened locale path into object keys and array indices.
 *
 * @param {string} dotted
 * @returns {Array<{type: 'key', value: string} | {type: 'index', value: number}>}
 */
export function localePathTokens(dotted) {
  const tokens = [];
  for (const part of dotted.split('.')) {
    const match = part.match(LOCALE_PATH_TOKENS_RE);
    if (match?.[1]) tokens.push({ type: 'key', value: match[1] });
    if (match?.[2]) {
      for (const index of match[2].matchAll(LOCALE_PATH_TOKENS_RE_2)) {
        tokens.push({ type: 'index', value: Number(index[1]) });
      }
    }
  }
  return tokens;
}
