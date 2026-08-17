/**
 * Theater coverage presets (#5956).
 *
 * One-click curated source sets for Settings → Sources. Applying a preset is
 * ADDITIVE: it removes the preset's sources from the user's disabled-sources
 * set (via the existing `setSourcesEnabled` bulk primitive) and never touches
 * any other enabled/disabled choice. `DEFAULT_ENABLED_SOURCES` remains the
 * baseline; presets are user-applied overlays persisted in the same
 * `worldmonitor-disabled-feeds` storage.
 *
 * Editorial rules:
 * - State propaganda that the catalog keeps as manual opt-in only (TASS, RT,
 *   Xinhua, Fars/IRNA/Mehr, Azertag, Armenpress, …) is NEVER in a preset —
 *   same rule as the #5950 EN-default balance. Locked by
 *   tests/theater-presets.test.mts (STATE_PROPAGANDA_OPT_IN_ONLY).
 * - Risk-tagged national institutions that a theater pack added deliberately
 *   (e.g. Ukrinform, Suspilne) MAY be included; the UI keeps showing their
 *   provenance risk tags.
 * - EN-readable sources are preferred. Locale-gated feeds normally stay with
 *   the locale boost, except when a country-specific validation explicitly
 *   selects the theater preset as its opt-in discovery path (#6829/#6830).
 *
 * Names must resolve in the feed catalog (feeds.ts / INTEL_SOURCES); the
 * drift test asserts every name resolves in `listConfiguredFeedNames()`.
 * Application still filters against the runtime-known source set, so a preset
 * name that a variant doesn't load is a silent no-op rather than an error.
 */

export interface TheaterPreset {
  /** Stable id, used for the chip's data attribute and future analytics. */
  id: string;
  /** i18n key for the chip label (theaterPresets.<id>.label). */
  labelKey: string;
  /** i18n key for the tooltip/description (theaterPresets.<id>.description). */
  descriptionKey: string;
  /** Feed `name` values to enable on apply (additive). */
  sourceNames: readonly string[];
}

export const THEATER_PRESETS: readonly TheaterPreset[] = [
  {
    id: 'ukraine-war',
    labelKey: 'theaterPresets.ukraineWar.label',
    descriptionKey: 'theaterPresets.ukraineWar.description',
    sourceNames: [
      'Kyiv Independent',
      'Ukrinform',
      'Suspilne',
      'Ukrainska Pravda EN',
      'NV EN',
      'Hromadske EN',
      'Meduza',
      'Moscow Times',
      'Zerkalo',
      'NewsMaker',
      'ISW',
    ],
  },
  {
    id: 'indo-pacific',
    labelKey: 'theaterPresets.indoPacific.label',
    descriptionKey: 'theaterPresets.indoPacific.description',
    sourceNames: [
      'Focus Taiwan',
      'Taipei Times',
      'Taiwan News',
      'CNA',
      'South China Morning Post',
      'Reuters Asia',
      'The Diplomat',
      'Nikkei Asia',
      'Japan Today',
      'Island Times (Palau)',
      'Jakarta Post',
      'Rappler',
      'The Star (Malaysia)',
      'Irrawaddy',
      'Dawn',
      'Geo News',
      'Amu TV',
      'Pajhwok Afghan News',
      'The Daily Star',
      'Dhaka Tribune',
    ],
  },
  {
    id: 'sahel-west-africa',
    labelKey: 'theaterPresets.sahelWestAfrica.label',
    descriptionKey: 'theaterPresets.sahelWestAfrica.description',
    sourceNames: [
      'Sahel Crisis',
      'BBC Africa',
      'Africa News',
      'Africanews',
      'Premium Times',
      'Vanguard Nigeria',
      'Channels TV',
      'Daily Trust',
      'ThisDay',
      'MyJoyOnline',
      'Studio Tamani',
      'leFaso.net',
      'ActuNiger',
      'Aïr Info',
      'Daily Nation',
      'The Guardian Post',
      'Tchadinfos',
      'Alwihda Info',
      'Radio Ndeke Luka',
    ],
  },
  {
    id: 'caucasus-central-asia',
    labelKey: 'theaterPresets.caucasusCentralAsia.label',
    descriptionKey: 'theaterPresets.caucasusCentralAsia.description',
    sourceNames: [
      'Civil.ge',
      'OC Media',
      'JAMnews',
      'Eurasianet',
      'RFE/RL Central Asia',
      'The Astana Times',
      'The Times of Central Asia',
    ],
  },
  {
    id: 'middle-east-flashpoints',
    labelKey: 'theaterPresets.middleEastFlashpoints.label',
    descriptionKey: 'theaterPresets.middleEastFlashpoints.description',
    sourceNames: [
      'BBC Middle East',
      'Al Jazeera',
      'Al Arabiya',
      'Guardian ME',
      'BBC Persian',
      'Iran International',
      'Haaretz',
      'Jerusalem Post',
      'Ynetnews',
      'Arab News',
      'The National',
      'Oman Observer',
      'Asharq Business',
      'Rudaw',
      'Yemen Online',
      "Sana'a Center",
      'Syria Direct',
      'Enab Baladi English',
      '+972 Magazine',
      'Naharnet Lebanon',
      "L'Orient Today",
      'Annahar',
      'Libya Herald',
      'Egypt Independent',
      'Mada Masr',
    ],
  },
];

export function getTheaterPreset(id: string): TheaterPreset | undefined {
  return THEATER_PRESETS.find((preset) => preset.id === id);
}

/**
 * Names the preset would enable for the given catalog: preset sources that
 * exist in `knownNames` (the runtime-loaded source set). Unknown names are
 * dropped so presets survive catalog/variant drift.
 */
export function resolveTheaterPresetSources(
  preset: TheaterPreset,
  knownNames: ReadonlySet<string>,
): string[] {
  return preset.sourceNames.filter((name) => knownNames.has(name));
}

/**
 * Additive apply semantics: the names to enable are the preset's resolvable
 * sources that are currently disabled. Everything else in the user's
 * disabled/enabled state is untouched.
 */
export function getTheaterPresetEnableList(
  preset: TheaterPreset,
  disabledSources: ReadonlySet<string>,
  knownNames: ReadonlySet<string>,
): string[] {
  return resolveTheaterPresetSources(preset, knownNames).filter((name) => disabledSources.has(name));
}
