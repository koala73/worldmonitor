const locale = process.env.WM_GENERATOR_LOCALE;
export const portableLocale = process.env.WM_GENERATOR_PORTABLE_LOCALE === '1'
  || new Intl.Collator().resolvedOptions().locale !== locale;

// Windows ICU uses the user locale instead of LANG. Override only implicit
// comparisons in these test processes; keep explicit production locales intact.
if (portableLocale) {
  const compare = String.prototype.localeCompare;
  String.prototype.localeCompare = function (other, locales, options) {
    return Reflect.apply(compare, this, [other, locales === undefined ? locale : locales, options]);
  };
}
