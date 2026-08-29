/**
 * @module hud
 * @description Intelligence HUD Overlay — NRO/NGA Satellite Aesthetic.
 *
 * Renders authentic reconnaissance metadata over the Cesium canvas:
 * classification banners, live MGRS/lat-lon coordinates, sensor metrics
 * (GSD, NIIRS, ONA), timestamps, and orbital data — all updating in
 * real-time at configurable cadences.
 *
 * The HUD auto-activates when a military-style shader (NVG, FLIR, CRT) is
 * selected and supports three layout variants: tactical, operator, minimal.
 *
 * Color theming is driven by the active shader mode via CSS custom properties.
 */

import * as Cesium from 'cesium';
import { forward as toMGRS } from 'mgrs';
import { CITY_POIS } from './locations.js';
import { composeLocalityTag } from './hudLocality.js';
import { ellipsoidalToMslDisplayM, ensureGeoidReady, geoidHeight } from './data/geoid.js';
import { getBasemapLabelContext } from './voice/gevActions.js';

/** Color palettes keyed by shader mode; applied as CSS custom properties. */
const HUD_COLORS = {
  surveillance: { main: 'rgba(51, 255, 51, 0.8)',  glow: 'rgba(51, 255, 51, 0.5)',  border: 'rgba(51, 255, 51, 0.2)' },
  thermal:      { main: 'rgba(255, 255, 255, 0.7)', glow: 'rgba(255, 255, 255, 0.4)', border: 'rgba(255, 255, 255, 0.15)' },
  retro:        { main: 'rgba(255, 170, 0, 0.8)',   glow: 'rgba(255, 170, 0, 0.5)',   border: 'rgba(255, 170, 0, 0.2)' },
  _default:     { main: 'rgba(0, 255, 255, 0.6)',   glow: 'rgba(0, 255, 255, 0.4)',   border: 'rgba(0, 255, 255, 0.15)' },
};

/** Shader modes that automatically show the HUD overlay. */
const MILITARY_STYLES = new Set(['retro', 'surveillance', 'thermal']);

/** Allowed HUD layout variants. */
const HUD_VARIANTS = new Set(['tactical', 'operator', 'minimal']);
const HUD_SUMMARY_INTERVAL_MS = 15000;
const HUD_SUMMARY_URL = '/api/gev/openai/hud-summary';

/**
 * Cell size (degrees) for the ALT readout's geoid-undulation cache. N changes
 * by well under a metre across 0.01° (~1.1 km), so one lookup per cell keeps
 * the 4 Hz telemetry tick off the EGM96 grid without a visible step.
 */
const HUD_GEOID_CELL_DEG = 0.01;

/** Flattened list of all city POIs for nearest-point lookups. */
const NEARBY_POINTS = Object.values(CITY_POIS)
  .flatMap((city) => city.pois.map((poi) => ({
    city: city.name,
    poi: poi.name,
    lat: poi.lat,
    lon: poi.lon,
  })));

/**
 * Full-screen intelligence HUD overlay rendered on top of the Cesium canvas.
 *
 * Displays classification banners, MGRS/lat-lon readouts, sensor metrics
 * (GSD, NIIRS, off-nadir angle), sun elevation, orbital metadata, and a
 * rolling semantic summary line. All values derive from the live camera
 * position and update on independent timer cadences.
 */
export class IntelHUD {
  /**
   * @param {Cesium.Viewer} viewer - The Cesium Viewer instance used for
   *   camera telemetry and coordinate derivation.
   */
  constructor(viewer) {
    this.viewer = viewer;
    this._visible = false;
    this._autoMode = true; // auto show/hide based on style
    this._currentStyle = 'normal';
    this._el = null;
    this._variant = 'tactical';
    this._recBlinkState = true;
    this._updateInterval = null;
    this._recBlinkInterval = null;
    this._timestampInterval = null;
    this._summaryInterval = null;
    this._summaryTypingInterval = null;
    this._latestMetrics = null;
    this._dataManager = null;
    this._dataManagerUnsubscribe = null;
    this._summaryDirty = true;
    this._summaryRequest = null;
    this._lastSummarySignature = '';
    this._summaryRevision = 0;
    // One-shot guards so the very first summary lands immediately instead of
    // waiting for the 15s interval tick: B) swap the "Awaiting telemetry..."
    // placeholder for the deterministic line as soon as metrics exist, then
    // A) kick a real AI summary once the intro fly-to settles.
    this._firstMetricsShown = false;
    this._firstSummaryKicked = false;
    // ALT readout datum: the camera height Cesium reports is ELLIPSOIDAL, the
    // number a viewer reads is MSL. N comes from the same lazy ~2.7 MB EGM96
    // chunk the flight layers use — requested on the first telemetry tick of a
    // VISIBLE HUD, never at construction, so a hidden HUD costs nothing — and
    // cached per coarse cell. Until it resolves, or if it never does,
    // `ellipsoidalToMslDisplayM` passes the raw height straight through.
    this._geoidRequested = false;
    this._geoidReady = false;
    this._geoidCellKey = null;
    this._geoidN = null;
    // Whether the LAST painted tick actually had N. The grid resolves mid-
    // session, so this flips once — and both altitude readouts have to move
    // together when it does (see the repaint in _updateCameraData).
    this._geoidCorrectionApplied = false;
    this._onCameraMoveEnd = () => {
      this._markSummaryDirty();
      // The 250 ms telemetry timer and 15 s semantic-summary timer must not
      // leave the prior city on-screen after a long CCTV focus flight.
      // Refresh deterministic camera context synchronously on settle; the AI
      // summary can still upgrade it on its normal cadence.
      if (this._visible) {
        this._updateCameraData();
        this._setSummaryText(this._composeSummary(), false);
      }
      // First settled view: request the AI summary now rather than waiting for
      // the periodic tick (saves up to ~15s of "Awaiting telemetry...").
      if (!this._firstSummaryKicked && this._visible && this._latestMetrics) {
        this._firstSummaryKicked = true;
        void this._updateSummary(true, true);
      }
    };

    // Session-consistent pseudorandom identifiers (generated once at construction)
    this._missionId = `KH11-${4000 + Math.floor(Math.random() * 200)}`;
    this._sensorId = `OPS-${4100 + Math.floor(Math.random() * 100)}`;
    this._orbitNum = 47000 + Math.floor(Math.random() * 1000);
    this._passNum = 100 + Math.floor(Math.random() * 200);

    this._buildDOM();
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._startTimers();
  }

  /**
   * Construct the HUD DOM structure inside the existing `#intel-hud` element.
   * Populates corner brackets, classification banners, sensor readouts,
   * edge metadata strips, and the bottom summary bar.
   */
  _buildDOM() {
    this._el = document.getElementById('intel-hud');
    if (!this._el) return;

    this._el.innerHTML = `
      <div class="hud-top-bar">
        <span class="hud-top-bar-left">TOP SECRET // SI-TK // NOFORN</span>
        <span class="hud-top-bar-center">${this._missionId}</span>
        <span class="hud-top-bar-right">PAGE 1/1</span>
      </div>

      <div class="hud-corner hud-top-left">
        <div class="hud-bracket">┌</div>
        <div class="hud-content">
          <div class="hud-classification">TOP SECRET // SI-TK // NOFORN</div>
          <div class="hud-system">${this._missionId}  ${this._sensorId}</div>
          <div class="hud-mode" id="hud-mode">NORMAL</div>
          <div class="hud-summary-wrap">
            <div class="hud-summary-label">SUMMARY</div>
            <div class="hud-summary" id="hud-summary">Awaiting telemetry...</div>
          </div>
        </div>
      </div>

      <div class="hud-corner hud-top-right">
        <div class="hud-content" style="text-align:right">
          <div class="hud-rec"><span id="hud-rec-dot">●</span> REC  <span id="hud-timestamp">2026-01-01 00:00:00Z</span></div>
          <div class="hud-orbital">ORB: ${this._orbitNum}  PASS: DESC-${this._passNum}</div>
        </div>
        <div class="hud-bracket">┐</div>
      </div>

      <div class="hud-corner hud-bottom-left">
        <div class="hud-bracket">└</div>
        <div class="hud-content">
          <div id="hud-mgrs">MGRS: ---</div>
          <div id="hud-latlon">--°--'--"N ---°--'--"W</div>
        </div>
      </div>

      <div class="hud-corner hud-bottom-right">
        <div class="hud-content" style="text-align:right">
          <div id="hud-gsd">GSD: --m  NIIRS: --</div>
          <div id="hud-alt">ALT: --m   SUN: --° EL</div>
          <div id="hud-ais-vessel" class="hud-ais-vessel">AIS: --</div>
        </div>
        <div class="hud-bracket">┘</div>
      </div>

      <div class="hud-edge hud-left-edge">
        <div id="hud-coll">COLL: --:--:--Z</div>
        <div id="hud-ona">ONA: --°</div>
      </div>

      <div class="hud-edge hud-right-edge">
        <div>BAND: PAN</div>
        <div>BITS: 11</div>
        <div>LVL: 1A</div>
      </div>

      <div class="hud-bottom-bar">
        <span id="hud-bottom-line">LAT: --  LON: --  MGRS: ---</span>
      </div>
    `;
    this._el.dataset.variant = this._variant;
  }

  /**
   * Start all periodic update timers (timestamp, REC blink, camera
   * telemetry, semantic summary). Timers run independently at different
   * cadences and are cleaned up in {@link destroy}.
   */
  _startTimers() {
    // Timestamp — every second
    this._timestampInterval = setInterval(() => {
      const el = document.getElementById('hud-timestamp');
      if (el) el.textContent = this._formatUTC();
    }, 1000);

    // REC blink — every 800ms
    this._recBlinkInterval = setInterval(() => {
      this._recBlinkState = !this._recBlinkState;
      const dot = document.getElementById('hud-rec-dot');
      if (dot) dot.style.visibility = this._recBlinkState ? 'visible' : 'hidden';
    }, 800);

    // Camera-derived data — 4 updates/second (250ms)
    this._updateInterval = setInterval(() => {
      if (!this._visible) return;
      this._updateCameraData();
    }, 250);

    // Semantic summary refresh cadence
    this._summaryInterval = setInterval(() => {
      if (!this._visible) return;
      void this._updateSummary(true);
    }, HUD_SUMMARY_INTERVAL_MS);
  }

  /**
   * Format the current wall-clock time as a UTC Zulu string.
   * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SSZ` format.
   */
  _formatUTC() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}Z`;
  }

  /**
   * Geoid undulation N at the camera subpoint, memoized per coarse cell.
   * @param {number} latDeg - Camera latitude in decimal degrees.
   * @param {number} lonDeg - Camera longitude in decimal degrees.
   * @returns {number|null} N in metres, or null while the grid is unavailable.
   */
  _geoidUndulationM(latDeg, lonDeg) {
    if (!this._geoidReady) {
      if (!this._geoidRequested) {
        this._geoidRequested = true;
        ensureGeoidReady()
          .then(() => { this._geoidReady = true; })
          .catch(() => { /* readout falls back to the uncorrected height */ });
      }
      return null;
    }
    const key = `${Math.round(latDeg / HUD_GEOID_CELL_DEG)}:${Math.round(lonDeg / HUD_GEOID_CELL_DEG)}`;
    if (key !== this._geoidCellKey) {
      try {
        this._geoidN = geoidHeight(latDeg, lonDeg);
      } catch {
        this._geoidN = null;
      }
      this._geoidCellKey = key;
    }
    return Number.isFinite(this._geoidN) ? this._geoidN : null;
  }

  /**
   * Derive all camera-based telemetry and push values to the DOM.
   * Reads the viewer camera's cartographic position and computes MGRS,
   * lat/lon DMS, GSD, NIIRS, sun elevation, off-nadir angle, and
   * collection timestamp. Stores results in {@link _latestMetrics}.
   */
  _updateCameraData() {
    const camera = this.viewer.camera;
    const cartographic = camera.positionCartographic;
    if (!cartographic) return;

    const lonDeg = Cesium.Math.toDegrees(cartographic.longitude);
    const latDeg = Cesium.Math.toDegrees(cartographic.latitude);
    const altM = cartographic.height;
    const latDMS = this._toDMS(latDeg, 'lat');
    const lonDMS = this._toDMS(lonDeg, 'lon');
    let mgrsLabel = '---';

    // MGRS
    try {
      const mgrsStr = toMGRS([lonDeg, latDeg], 4); // 4 = 10m precision
      // Format: 18SUJ23370716 → 18S UJ 2337 0716
      const formatted = this._formatMGRS(mgrsStr);
      mgrsLabel = formatted;
      const el = document.getElementById('hud-mgrs');
      if (el) el.textContent = `MGRS: ${formatted}`;
    } catch {
      const el = document.getElementById('hud-mgrs');
      if (el) el.textContent = 'MGRS: ---';
    }

    // Lat/Lon DMS
    const llEl = document.getElementById('hud-latlon');
    if (llEl) llEl.textContent = `${latDMS} ${lonDMS}`;
    const bottomEl = document.getElementById('hud-bottom-line');
    if (bottomEl) {
      bottomEl.textContent = `MGRS: ${mgrsLabel}  LAT: ${latDMS}  LON: ${lonDMS}`;
    }

    // GSD (Ground Sample Distance): approximate resolution in meters per pixel
    // derived from camera altitude. NIIRS (National Imagery Interpretability
    // Rating Scale): 0-9 quality rating computed via the General Image Quality
    // Equation (GIQE) simplified form: NIIRS = 10.25 - 3.32 * log10(GSD_inches).
    const gsd = Math.max(0.01, altM * 0.000375);
    const gsdInches = gsd * 39.37;
    const niirs = Math.max(0, Math.min(9, 10.25 - 3.32 * Math.log10(gsdInches)));
    const gsdEl = document.getElementById('hud-gsd');
    if (gsdEl) gsdEl.textContent = `GSD: ${gsd.toFixed(2)}m  NIIRS: ${niirs.toFixed(1)}`;

    // Altitude — reported as height above MEAN SEA LEVEL. `altM` is the raw
    // ellipsoidal camera height, which reads far below zero wherever the geoid
    // sits under the ellipsoid: a cockpit parked on the SFO deck (N ≈ -32 m)
    // showed "ALT: -15m", and JFK "ALT: -18m". Subtracting N restores the
    // number a viewer expects without touching the camera or any render path.
    const altEl = document.getElementById('hud-alt');
    const geoidN = this._geoidUndulationM(latDeg, lonDeg);
    const altMslM = ellipsoidalToMslDisplayM(altM, geoidN);
    const sunEl = this._estimateSunElevation(latDeg, lonDeg);
    if (altEl) altEl.textContent = `ALT: ${Math.round(altMslM)}m   SUN: ${sunEl.toFixed(1)}° EL`;

    // Collection timestamp
    const collEl = document.getElementById('hud-coll');
    if (collEl) {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, '0');
      const m = String(now.getUTCMinutes()).padStart(2, '0');
      const s = String(now.getUTCSeconds()).padStart(2, '0');
      collEl.textContent = `COLL: ${h}:${m}:${s}Z`;
    }

    // Off-nadir angle (ONA): camera pitch of -90 deg is nadir (straight down),
    // so ONA = 90 + pitch gives 0 at nadir and increases toward the horizon.
    const pitchDeg = Cesium.Math.toDegrees(camera.pitch);
    const ona = Math.max(0, 90 + pitchDeg);
    const onaEl = document.getElementById('hud-ona');
    if (onaEl) onaEl.textContent = `ONA: ${ona.toFixed(1)}°`;

    // `altM` stays the raw ellipsoidal camera height the sensor model reads
    // (GSD/NIIRS, view band). `altMslM` is the ADDITIVE display datum — the
    // only one any readout string should print.
    this._latestMetrics = {
      latDeg,
      lonDeg,
      altM,
      altMslM,
      sunEl,
      ona,
    };

    // First time we have real telemetry: replace the "Awaiting telemetry..."
    // placeholder with the deterministic summary line instantly (no network),
    // so there's always meaningful context on screen. The AI summary upgrades
    // this within a second via the moveEnd kick / periodic refresh.
    if (!this._firstMetricsShown) {
      this._firstMetricsShown = true;
      this._setSummaryText(this._composeSummary(), false);
    }

    // The EGM96 grid lands mid-session, and the corner readout picks it up on
    // the very next telemetry tick. The summary line has no such cadence — it
    // repaints on camera settle or its own 15 s retry — so without this the
    // corner reads `ALT: 17m` beside a summary still reading `ALT -15M`, for
    // up to fifteen seconds. Repaint the deterministic line in the SAME tick
    // the correction turns on (or off, if a lookup starts failing), and mark
    // the summary dirty so the AI line refreshes on its normal cadence —
    // exactly what a camera settle already does.
    const geoidCorrectionApplied = Number.isFinite(geoidN);
    if (geoidCorrectionApplied !== this._geoidCorrectionApplied) {
      this._geoidCorrectionApplied = geoidCorrectionApplied;
      this._markSummaryDirty();
      this._setSummaryText(this._composeSummary(), false);
    }
  }

  /**
   * Insert spaces into a raw MGRS string for human-readable display.
   * @param {string} mgrs - Raw MGRS string, e.g. `"18SUJ23370716"`.
   * @returns {string} Formatted string, e.g. `"18S UJ 2337 0716"`.
   */
  _formatMGRS(mgrs) {
    // Regex captures: grid zone designator (1-2 digits + band letter),
    // 100km square ID (2 letters), numeric easting+northing (split in half).
    const match = mgrs.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!match) return mgrs;
    const [, zone, square, coords] = match;
    const half = coords.length / 2;
    const easting = coords.slice(0, half);
    const northing = coords.slice(half);
    return `${zone} ${square} ${easting} ${northing}`;
  }

  /**
   * Convert a decimal-degree value to a degrees-minutes-seconds string.
   * @param {number} decimal - Coordinate in decimal degrees.
   * @param {'lat'|'lon'} type - Axis selector; controls hemisphere letter
   *   and zero-padding width (2 digits for lat, 3 for lon).
   * @returns {string} Formatted DMS string, e.g. `"38°53'23.10"N"`.
   */
  _toDMS(decimal, type) {
    const abs = Math.abs(decimal);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(2);

    let dir;
    if (type === 'lat') dir = decimal >= 0 ? 'N' : 'S';
    else dir = decimal >= 0 ? 'E' : 'W';

    const degStr = type === 'lon' ? String(deg).padStart(3, '0') : String(deg).padStart(2, '0');
    return `${degStr}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${dir}`;
  }

  /**
   * Estimate current solar elevation angle above the horizon.
   *
   * Uses a simplified astronomical model: solar declination is approximated
   * from the day of year, and elevation is derived from the standard
   * sin(elevation) formula involving latitude, declination, and hour angle.
   *
   * @param {number} lat - Observer latitude in decimal degrees.
   * @param {number} lon - Observer longitude in decimal degrees.
   * @returns {number} Estimated sun elevation in degrees (negative = below horizon).
   */
  _estimateSunElevation(lat, lon) {
    const now = new Date();
    // Approximate local solar time by shifting UTC hours by longitude offset
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15;
    const solarNoon = 12;
    const hourAngle = (hours - solarNoon) * 15;
    // Solar declination approximation (~23.45 deg amplitude sinusoidal over the year)
    const declination = 23.45 * Math.sin(Cesium.Math.toRadians((360 / 365) * (now.getUTCDate() + 30 * now.getUTCMonth() - 81)));
    const latRad = Cesium.Math.toRadians(lat);
    const decRad = Cesium.Math.toRadians(declination);
    const haRad = Cesium.Math.toRadians(hourAngle);
    // Standard formula: sin(el) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(ha)
    const sinEl = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    // Clamp to [-1,1] to guard against floating-point drift before asin
    return Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sinEl))));
  }

  /**
   * Classify the camera altitude into a named observation band.
   * @param {number} altM - Camera altitude in meters.
   * @returns {'STREET'|'CITY'|'METRO'|'REGIONAL'|'GLOBAL'} Band label.
   */
  _viewBand(altM) {
    if (altM < 1200) return 'STREET';
    if (altM < 5000) return 'CITY';
    if (altM < 30000) return 'METRO';
    if (altM < 250000) return 'REGIONAL';
    return 'GLOBAL';
  }

  /**
   * Return a coarse geographic region label based on lat/lon bounding boxes.
   * @param {number} lat - Latitude in decimal degrees.
   * @param {number} lon - Longitude in decimal degrees.
   * @returns {string} Region name (e.g. `"EUROPE"`, `"NORTHERN OCEANIC GRID"`).
   */
  _regionLabel(lat, lon) {
    if (lat > 72) return 'ARCTIC';
    if (lat < -60) return 'ANTARCTIC';
    if (lat >= 5 && lat <= 83 && lon >= -170 && lon <= -50) return 'NORTH AMERICA';
    if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30) return 'SOUTH AMERICA';
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return 'EUROPE';
    if (lat >= -35 && lat <= 38 && lon >= -20 && lon <= 55) return 'AFRICA';
    if (lat >= 5 && lat <= 80 && lon >= 45 && lon <= 180) return 'ASIA';
    if (lat >= -50 && lat <= 5 && lon >= 110 && lon <= 180) return 'OCEANIA';
    return lat >= 0 ? 'NORTHERN OCEANIC GRID' : 'SOUTHERN OCEANIC GRID';
  }

  /**
   * Compute the approximate width and height (in km) of the camera's
   * current view rectangle on the ground.
   * @param {number} latDeg - Center latitude in decimal degrees (for
   *   longitude-to-km cosine correction).
   * @returns {{ widthKm: number, heightKm: number }|null} View window
   *   dimensions, or null if the view rectangle cannot be computed.
   */
  _viewWindowKm(latDeg) {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const north = Cesium.Math.toDegrees(rect.north);
    const south = Cesium.Math.toDegrees(rect.south);
    let east = Cesium.Math.toDegrees(rect.east);
    let west = Cesium.Math.toDegrees(rect.west);
    let lonSpan = Math.abs(east - west);
    // Handle antimeridian wrap: if span exceeds 180 deg, take the shorter arc
    if (lonSpan > 180) lonSpan = 360 - lonSpan;
    const latSpan = Math.abs(north - south);
    // 111 km/deg is the approximate surface distance per degree of latitude;
    // longitude distance is scaled by cos(lat) to account for meridian convergence.
    const widthKm = Math.max(0, lonSpan * 111 * Math.cos(Cesium.Math.toRadians(latDeg)));
    const heightKm = Math.max(0, latSpan * 111);
    return { widthKm, heightKm };
  }

  /**
   * Compute the great-circle distance between two geographic points
   * using the Haversine formula.
   * @param {number} lat1 - Start latitude (decimal degrees).
   * @param {number} lon1 - Start longitude (decimal degrees).
   * @param {number} lat2 - End latitude (decimal degrees).
   * @param {number} lon2 - End longitude (decimal degrees).
   * @returns {number} Distance in kilometers.
   */
  _haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => Cesium.Math.toRadians(deg);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Find the closest known POI to the given coordinates.
   * @param {number} latDeg - Latitude in decimal degrees.
   * @param {number} lonDeg - Longitude in decimal degrees.
   * @returns {{ city: string, poi: string, lat: number, lon: number, distKm: number }|null}
   *   Nearest point with distance, or null if no POIs are loaded.
   */
  _nearestKnownPoint(latDeg, lonDeg) {
    let best = null;
    for (const point of NEARBY_POINTS) {
      const distKm = this._haversineKm(latDeg, lonDeg, point.lat, point.lon);
      if (!best || distKm < best.distKm) {
        best = { ...point, distKm };
      }
    }
    return best;
  }

  /**
   * Build the one-line semantic summary string from the latest camera metrics.
   * Includes mode, observation band, nearest POI or lat/lon sector, region,
   * altitude, view window dimensions, sun elevation, ONA, and local timezone.
   * @returns {string} Formatted summary line for the HUD summary readout.
   */
  _composeSummary() {
    const m = this._latestMetrics;
    if (!m) return 'Awaiting telemetry...';

    const modeEl = document.getElementById('hud-mode');
    const modeLabel = modeEl?.textContent || 'NORMAL';
    const region = this._regionLabel(m.latDeg, m.lonDeg);
    const nearest = this._nearestKnownPoint(m.latDeg, m.lonDeg);
    const band = this._viewBand(m.altM);
    const window = this._viewWindowKm(m.latDeg);
    // Rough local timezone from longitude (15 deg per hour)
    const utcOffset = Math.round(m.lonDeg / 15);
    const localTag = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
    // Same MSL datum as the corner ALT readout — the two are on screen
    // together, so they must never disagree. The view band above deliberately
    // keeps the ellipsoidal height: its thresholds were tuned against it.
    const altDisplayM = Number.isFinite(m.altMslM) ? m.altMslM : m.altM;
    const altTag = altDisplayM >= 1000
      ? `${(altDisplayM / 1000).toFixed(1)}KM`
      : `${Math.round(altDisplayM)}M`;
    const winTag = window
      ? `${Math.max(1, Math.round(window.widthKm))}x${Math.max(1, Math.round(window.heightKm))}KM`
      : 'N/A';
    // NEAR the nearest catalogued POI at metro range; otherwise the lat/lon sector.
    const localityTag = composeLocalityTag(nearest, m.latDeg, m.lonDeg);

    return `${modeLabel} ${band} ${localityTag} | ${region} | ALT ${altTag} | WINDOW ${winTag} | SUN ${m.sunEl.toFixed(0)}° | ONA ${m.ona.toFixed(0)}° | ${localTag}`;
  }

  /**
   * Animate the summary text into the DOM using a typewriter effect
   * (2 characters every 24ms).
   * @param {string} text - Full summary string to type out.
   */
  _typeSummary(text) {
    const el = document.getElementById('hud-summary');
    if (!el) return;
    clearInterval(this._summaryTypingInterval);
    let index = 0;
    el.textContent = '';
    this._summaryTypingInterval = setInterval(() => {
      index += 2;
      if (index >= text.length) {
        el.textContent = text;
        clearInterval(this._summaryTypingInterval);
        this._summaryTypingInterval = null;
        return;
      }
      el.textContent = text.slice(0, index);
    }, 24);
  }

  /**
   * Refresh the summary readout. Optionally animates the text via typewriter.
   * @param {boolean} [animate=false] - If true, types the summary character
   *   by character; otherwise sets it instantly.
   */
  async _updateSummary(animate = false, force = false) {
    const fallbackText = this._composeSummary();
    if (!this._latestMetrics) {
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (!force && !this._summaryDirty) return;

    const revision = this._summaryRevision;
    // Every caller invokes this as `void this._updateSummary(...)`, so nothing
    // owns the returned promise — a rejection escaping from here lands as an
    // unhandled rejection in the console. Building the context walks the live
    // scene (the view-target pick, the layer roster), so it belongs INSIDE a
    // guard rather than in front of one. A summary we cannot build is a
    // fallback line, not a crash.
    let context;
    try {
      context = await this._summaryContext();
    } catch (error) {
      console.warn('[HUD] summary context unavailable:', error);
      // Left dirty on purpose: the next periodic tick retries instead of
      // sticking on the fallback line for the rest of the session.
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (revision !== this._summaryRevision) return;
    const signature = JSON.stringify(context);
    if (!force && signature === this._lastSummarySignature) {
      this._summaryDirty = false;
      return;
    }
    if (this._summaryRequest) return;

    if (force) this._setSummaryText(fallbackText, false);
    this._summaryDirty = false;
    this._lastSummarySignature = signature;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    this._summaryRequest = controller;
    try {
      const response = await fetch(HUD_SUMMARY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.summary) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      if (revision !== this._summaryRevision) return;
      this._setSummaryText(data.summary, animate);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[HUD] AI summary unavailable:', error);
        // Invalidate the committed signature so the next periodic tick
        // retries instead of sticking on the fallback line forever.
        this._lastSummarySignature = null;
        this._summaryDirty = true;
      }
      this._setSummaryText(fallbackText, animate);
    } finally {
      window.clearTimeout(timeout);
      if (this._summaryRequest === controller) this._summaryRequest = null;
    }
  }

  _setSummaryText(text, animate) {
    if (animate) {
      this._typeSummary(text);
      return;
    }
    const el = document.getElementById('hud-summary');
    if (el) el.textContent = text;
  }

  async _summaryContext() {
    const labels = await getBasemapLabelContext(this.viewer);
    const enabledLayers = this._dataManager?.getAll?.()
      ?.filter((layer) => layer.enabled)
      .map((layer) => layer.name) || [];
    return {
      placeLabels: labels.placeLabels,
      streetLabels: labels.streetLabels,
      nearbyPlaceLabels: labels.nearbyPlaceLabels,
      enabledLayerLabels: enabledLayers,
    };
  }

  _markSummaryDirty() {
    this._summaryDirty = true;
    this._summaryRevision++;
  }

  // ── Public API ──────────────────────────

  /**
   * React to a shader-style change. Updates the mode label, HUD color
   * scheme (via CSS custom properties), and auto-shows/hides the overlay
   * when in auto mode.
   * @param {string} styleName - Active style key (e.g. `'surveillance'`,
   *   `'thermal'`, `'retro'`, `'normal'`).
   */
  onStyleChange(styleName) {
    this._currentStyle = styleName;

    // Update mode label
    const modeEl = document.getElementById('hud-mode');
    if (modeEl) {
      const modeNames = { surveillance: 'NVG', thermal: 'FLIR', retro: 'CRT' };
      modeEl.textContent = modeNames[styleName] || styleName.toUpperCase();
    }
    // Update color scheme
    const colors = HUD_COLORS[styleName] || HUD_COLORS._default;
    if (this._el) {
      this._el.style.setProperty('--hud-color', colors.main);
      this._el.style.setProperty('--hud-glow', colors.glow);
      this._el.style.setProperty('--hud-border', colors.border);
    }

    // Auto show/hide
    if (this._autoMode) {
      if (MILITARY_STYLES.has(styleName)) {
        this.show();
      } else {
        this.hide();
      }
    }
  }

  /** Make the HUD visible and immediately refresh all readouts. */
  show() {
    this._visible = true;
    if (this._el) this._el.classList.add('active');
    this._updateCameraData(); // immediate update
    this._markSummaryDirty();
    void this._updateSummary(false, true);
  }

  /** Hide the HUD overlay. */
  hide() {
    this._visible = false;
    if (this._el) this._el.classList.remove('active');
  }

  /** Toggle HUD visibility and disable auto-mode (user override). */
  toggle() {
    if (this._visible) {
      this._autoMode = false; // user override
      this.hide();
    } else {
      this._autoMode = false;
      this.show();
    }
  }

  /**
   * Explicit HUD mode control for scene/recording playback.
   * @param {'auto'|'on'|'off'} mode - `'auto'` re-enables style-driven
   *   show/hide; `'on'`/`'off'` force visibility and disable auto-mode.
   */
  setMode(mode) {
    if (mode === 'auto') {
      this._autoMode = true;
      this.onStyleChange(this._currentStyle);
      return;
    }

    this._autoMode = false;
    if (mode === 'on') this.show();
    else this.hide();
  }

  /**
   * Switch the HUD layout variant. Falls back to `'tactical'` if the
   * name is unrecognized.
   * @param {string} variantName - One of `'tactical'`, `'operator'`, `'minimal'`.
   */
  setVariant(variantName) {
    const normalized = String(variantName || '').toLowerCase();
    this._variant = HUD_VARIANTS.has(normalized) ? normalized : 'tactical';
    if (this._el) {
      this._el.dataset.variant = this._variant;
    }
  }

  /**
   * @returns {string} The current HUD layout variant name.
   */
  getVariant() {
    return this._variant;
  }

  /**
   * @returns {'auto'|'on'|'off'} Current HUD mode — `'auto'` when style-driven
   *   show/hide is active, otherwise the explicit visibility override.
   */
  getMode() {
    if (this._autoMode) return 'auto';
    return this._visible ? 'on' : 'off';
  }

  /** @returns {boolean} Whether the HUD is currently visible. */
  get visible() {
    return this._visible;
  }

  attachDataManager(dataManager) {
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._dataManager = dataManager || null;
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        if (change?.type === 'visibility') this._markSummaryDirty();
      });
    }
    this._markSummaryDirty();
  }

  /** Tear down all running intervals. Call when discarding the HUD instance. */
  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._recBlinkInterval);
    clearInterval(this._timestampInterval);
    clearInterval(this._summaryInterval);
    clearInterval(this._summaryTypingInterval);
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    this._dataManagerUnsubscribe?.();
    this._summaryRequest?.abort();
  }
}
