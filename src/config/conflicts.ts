/** A named conflict scene that the user can jump to from the Conflicts dropdown. */
export interface ConflictSceneConfig {
  /** Unique identifier for the scene. */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** Map centre latitude. */
  lat: number;
  /** Map centre longitude. */
  lon: number;
  /** Zoom level to fly to when selected. */
  zoom: number;
  /**
   * Google My Maps KML export URL (or any public KML URL).
   * Pattern: https://www.google.com/maps/d/kml?mid={MAP_ID}&forcekml=1
   * The overlay is fetched, parsed, and rendered as native WebGL layers.
   */
  kmlUrl?: string;
  /**
   * KML folder names → English labels shown in the conflict legend.
   * Only folders listed here are rendered; all others are hidden.
   */
  folderTranslations?: Record<string, string>;
}

/**
 * Conflict scenes available in the Conflicts dropdown.
 * To add a new entry append a ConflictSceneConfig here — no other code changes required.
 * For Google My Maps: open the map → Share → copy the link → extract the `mid=` value and
 * build the KML export URL: https://www.google.com/maps/d/kml?mid={VALUE}&forcekml=1
 */
export const CONFLICT_SCENES: ConflictSceneConfig[] = [
  {
    id: 'south-lebanon',
    label: 'Israeli invasion of South Lebanon / Gaza',
    lat: 33.19923,
    lon: 35.57413,
    zoom: 11,
    kmlUrl: 'https://www.google.com/maps/d/kml?mid=1rSOCMJ8VTxNOl6wWCMByZE93qcKqDD4&forcekml=1',
    folderTranslations: {
      'مناطق تقدم\\تمركز الجيش الإسرائيلي': 'IDF Advance / Deployment Areas',
    },
  },
];
