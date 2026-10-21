import {
  computePreRegionalFeedRolloutDefaultDisabledSources,
  computePreStrategicDefaultDisabledSources,
  FEEDS,
  FREE_CAP_PROTECTED_SOURCES,
  FRONTLINE_EUROPE_PROTECTED_SOURCES,
  getLanguageMatchedSources,
  getStrategicDefaultSources,
  INTEL_SOURCES,
  REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
  REGIONAL_FEED_ROLLOUT_OPT_IN_SOURCES,
  REGIONAL_FEED_ROLLOUT_STAGES,
} from '@/config/feeds';
import {
  canonicalStringSet,
  computeRolloutLegacyDisabledStates,
  selectSourcesUnderCap,
} from './source-cap';

export interface RegionalFeedRolloutMigrationTarget {
  legacyDisabled: ReadonlySet<string>;
  defaultNames: ReadonlySet<string>;
  optInNames: ReadonlySet<string>;
}

const REGIONAL_FEED_ROLLOUT_NAMES = new Set(
  REGIONAL_FEED_ROLLOUT_STAGES.flatMap((stage) => [...stage.introducedNames]),
);
const STRATEGIC_DEFAULT_SOURCES = getStrategicDefaultSources();
const PRE_STRATEGIC_FREE_CAP_PROTECTED_SOURCES = new Set(FREE_CAP_PROTECTED_SOURCES);

// Frozen chronology immediately before the regional wave. These names cannot
// be derived from today's defaults: doing so makes an exact migration
// fingerprint drift every time another feed is added to the catalog.
const INITIAL_FRONTLINE_DEFAULT_SOURCES = [
  'Kyiv Independent',
  'TVN24',
  'Rzeczpospolita',
  'Meduza',
  'Moscow Times',
] as const;

const UKRAINE_DEPTH_ROLLOUT_DEFAULT_SOURCES = [
  'Ukrainska Pravda EN',
  'NV EN',
  'ISW',
] as const;

const UKRAINE_DEPTH_ROLLOUT_OPT_IN_SOURCES = [
  'Ukrinform',
  'Suspilne',
  'Hromadske EN',
] as const;

const UKRAINE_DEPTH_ROLLOUT_NAMES = new Set<string>([
  ...UKRAINE_DEPTH_ROLLOUT_DEFAULT_SOURCES,
  ...UKRAINE_DEPTH_ROLLOUT_OPT_IN_SOURCES,
]);

const RECONCILED_ROLLOUT_NAMES = new Set<string>([
  ...INITIAL_FRONTLINE_DEFAULT_SOURCES,
  ...UKRAINE_DEPTH_ROLLOUT_NAMES,
  ...REGIONAL_FEED_ROLLOUT_NAMES,
]);

function catalogLanguages(): string[] {
  const languages = new Set(['en']);
  for (const feed of [...Object.values(FEEDS).flat(), ...INTEL_SOURCES]) {
    if (feed.lang) languages.add(feed.lang.toLowerCase());
    if (typeof feed.url === 'object') {
      for (const language of Object.keys(feed.url)) languages.add(language.toLowerCase());
    }
  }
  return [...languages].sort();
}

function legacyLocaleProtectedNames(locale: string): Set<string> {
  const protectedNames = getLanguageMatchedSources(locale);
  // NewsMaker only became `lang: ru` in the repair release. Its broken feed
  // was unscoped during the historical rollout, so treating it as a legacy RU
  // locale boost would recognize a state the old application never produced.
  protectedNames.delete('NewsMaker');
  return protectedNames;
}

/**
 * Exact untouched default/cap states from immediately before PR #6000.
 * Locale metadata is not stored in cloud rows, so an omitted locale enumerates
 * every configured language. NewsMaker is excluded from the historical RU
 * boost because its `lang: ru` tag only arrives in this repair release.
 */
export function buildPreStrategicDefaultDisabledStates(
  cap: number,
  locale?: string,
): Set<string>[] {
  const locales = locale
    ? [(locale.split('-')[0] ?? 'en').toLowerCase()]
    : catalogLanguages();
  const baseDisabled = computePreStrategicDefaultDisabledSources();
  const uniqueStates = new Map<string, Set<string>>();

  for (const language of locales) {
    const localeProtected = legacyLocaleProtectedNames(language);
    const defaultDisabled = new Set(baseDisabled);
    // NewsMaker was briefly an unscoped default before the repair changed it
    // to a native `lang: ru` feed. The old app therefore could not have
    // produced a locale-boosted RU state with NewsMaker enabled.
    if (language === 'ru') defaultDisabled.add('NewsMaker');
    for (const name of localeProtected) defaultDisabled.delete(name);

    const protectedNames = new Set([
      ...PRE_STRATEGIC_FREE_CAP_PROTECTED_SOURCES,
      ...localeProtected,
    ]);
    const { autoDisabled } = selectSourcesUnderCap(
      FEEDS,
      INTEL_SOURCES,
      defaultDisabled,
      cap,
      protectedNames,
    );
    const capDisabled = new Set([...defaultDisabled, ...autoDisabled]);
    uniqueStates.set(canonicalStringSet(defaultDisabled), defaultDisabled);
    uniqueStates.set(canonicalStringSet(capDisabled), capDisabled);
  }

  return [...uniqueStates.values()];
}

/**
 * Exact disabled-set fingerprints for untouched profiles across the frontline,
 * Ukraine-depth, and four chronological regional feed releases. Passing a
 * locale limits local-startup work to that profile's language; omitting it
 * enumerates every configured language for cloud rows whose last-writing
 * device locale is not recorded.
 */
export function buildRegionalFeedRolloutMigrationTargets(
  cap: number,
  locale?: string,
): RegionalFeedRolloutMigrationTarget[] {
  const locales = locale
    ? [(locale.split('-')[0] ?? 'en').toLowerCase()]
    : catalogLanguages();
  const targets: RegionalFeedRolloutMigrationTarget[] = [];

  for (const language of locales) {
    const localeProtected = legacyLocaleProtectedNames(language);
    const localeDefaults = new Set(
      [...getLanguageMatchedSources(language)]
        .filter((name) => RECONCILED_ROLLOUT_NAMES.has(name)),
    );
    const defaultNames = new Set([
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...UKRAINE_DEPTH_ROLLOUT_DEFAULT_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...STRATEGIC_DEFAULT_SOURCES,
      ...localeDefaults,
    ]);
    const optInNames = new Set(
      [...UKRAINE_DEPTH_ROLLOUT_OPT_IN_SOURCES, ...REGIONAL_FEED_ROLLOUT_OPT_IN_SOURCES]
        .filter((name) => !defaultNames.has(name)),
    );

    const postUkraineDefault = new Set(
      computePreRegionalFeedRolloutDefaultDisabledSources(language),
    );
    const postFrontlineDefault = new Set(postUkraineDefault);
    for (const name of UKRAINE_DEPTH_ROLLOUT_NAMES) postFrontlineDefault.delete(name);
    const preFrontlineDefault = new Set(postFrontlineDefault);
    for (const name of INITIAL_FRONTLINE_DEFAULT_SOURCES) {
      if (!localeProtected.has(name)) preFrontlineDefault.add(name);
    }

    const regionalStages = REGIONAL_FEED_ROLLOUT_STAGES.map((stage) => ({
      introducedNames: new Set<string>(stage.introducedNames),
      protectedNames: new Set<string>([...stage.protectedNames, ...localeProtected]),
    }));
    const postFrontlineStages = [
      {
        introducedNames: UKRAINE_DEPTH_ROLLOUT_NAMES,
        protectedNames: new Set<string>([
          ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
          ...localeProtected,
        ]),
      },
      ...regionalStages,
    ];
    const languageStates = [
      // Dormant schema-1/2 rows last written before #5949. This sequence is
      // intentionally rooted in a frozen pre-frontline fingerprint so later
      // catalog additions cannot strand it before schema 4.
      ...computeRolloutLegacyDisabledStates(
        FEEDS,
        INTEL_SOURCES,
        preFrontlineDefault,
        cap,
        localeProtected,
        postFrontlineStages,
      ),
      // Profiles that consumed the frontline migration but predate the
      // Ukraine depth pack.
      ...computeRolloutLegacyDisabledStates(
        FEEDS,
        INTEL_SOURCES,
        postFrontlineDefault,
        cap,
        new Set([...INITIAL_FRONTLINE_DEFAULT_SOURCES, ...localeProtected]),
        postFrontlineStages,
      ),
      // Fresh profiles created after the Ukraine depth pack but before one or
      // more of the regional releases.
      ...computeRolloutLegacyDisabledStates(
        FEEDS,
        INTEL_SOURCES,
        postUkraineDefault,
        cap,
        new Set([...FRONTLINE_EUROPE_PROTECTED_SOURCES, ...localeProtected]),
        regionalStages,
      ),
    ];
    const uniqueStates = new Map<string, Set<string>>();
    for (const legacyDisabled of languageStates) {
      uniqueStates.set(canonicalStringSet(legacyDisabled), legacyDisabled);
    }
    for (const legacyDisabled of uniqueStates.values()) {
      targets.push({ legacyDisabled, defaultNames, optInNames });
    }
  }

  return targets;
}
