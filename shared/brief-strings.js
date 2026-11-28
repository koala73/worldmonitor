// Server-side chrome strings for the WorldMonitor Brief across every UI
// language. Plain ESM with no Node-only imports: loaded by Vercel edge
// routes, server/_shared/brief-render.js and the digest cron.

import { BRIEF_STRINGS } from './brief-strings.data.js';

export const BRIEF_STRING_KEYS = Object.freeze(Object.keys(BRIEF_STRINGS.en));

const GREETING_KEYS = {
  'Good morning.': 'greeting.morning',
  'Good afternoon.': 'greeting.afternoon',
  'Good evening.': 'greeting.evening',
};

/** Intl locale for a UI language (same mapping as src/services/i18n.ts). */
export function briefIntlLocale(lang) {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'zh-TW') return 'zh-TW';
  return typeof lang === 'string' && Object.hasOwn(BRIEF_STRINGS, lang) ? lang : 'en';
}

function table(lang) {
  return typeof lang === 'string' && Object.hasOwn(BRIEF_STRINGS, lang) ? BRIEF_STRINGS[lang] : BRIEF_STRINGS.en;
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match);
}

function entry(lang, key) {
  const own = table(lang)[key];
  return own === undefined ? BRIEF_STRINGS.en[key] : own;
}

export function briefT(lang, key, vars) {
  let value = entry(lang, key);
  if (value && typeof value === 'object') value = value.other;
  if (typeof value !== 'string') value = BRIEF_STRINGS.en[key];
  if (value && typeof value === 'object') value = value.other;
  return typeof value === 'string' ? interpolate(value, vars) : key;
}

export function briefPlural(lang, key, count, vars) {
  const localized = table(lang)[key];
  const allVars = { n: count, ...(vars ?? {}) };
  if (typeof localized === 'string') return briefT(lang, key, allVars);
  const value = localized && typeof localized === 'object' ? localized : BRIEF_STRINGS.en[key];
  const useLang = value === localized ? lang : 'en';
  if (!value || typeof value !== 'object') return briefT(useLang, key, allVars);
  let category = 'other';
  try {
    category = new Intl.PluralRules(briefIntlLocale(useLang)).select(count);
  } catch {
    category = 'other';
  }
  const template = typeof value[category] === 'string' ? value[category] : value.other;
  return interpolate(template, allVars);
}

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function toDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }
  return date instanceof Date ? date : new Date(date);
}

const STYLE_OPTIONS = {
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  short: { month: 'short', day: 'numeric' },
  full: { month: 'long', day: 'numeric', year: 'numeric' },
};

export function formatBriefDate(lang, date, style, timeZone = 'UTC') {
  const d = toDate(date);
  const isCalendarDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const tz = isCalendarDate ? 'UTC' : timeZone;
  const locale = briefIntlLocale(lang);
  if (locale === 'en') {
    if (style === 'long') {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', month: 'numeric', year: 'numeric' })
        .formatToParts(d);
      const get = (type) => Number(parts.find((p) => p.type === type)?.value);
      return `${get('day')} ${EN_MONTHS[get('month') - 1]} ${get('year')}`;
    }
    return new Intl.DateTimeFormat('en-US', { ...STYLE_OPTIONS[style], timeZone: tz }).format(d);
  }
  return new Intl.DateTimeFormat(locale, { ...STYLE_OPTIONS[style], timeZone: tz }).format(d);
}

export function greetingKey(englishGreeting) {
  return GREETING_KEYS[englishGreeting] ?? 'greeting.evening';
}
