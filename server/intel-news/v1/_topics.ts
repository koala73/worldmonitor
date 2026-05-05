/**
 * Intel News topics — mapped to GDELT 2.0 Doc API queries.
 *
 * Each topic surfaces in the iOS feed as its own filter chip and contributes
 * articles to a unified intel-news digest. Topic IDs are stable (used as
 * cache key namespaces) — renaming requires a migration.
 *
 * # Query design notes
 *
 * GDELT's boolean query syntax matches phrases or single keywords. Single
 * common words (e.g. bare "nuclear", "war", "fleet") over-match and pull
 * in irrelevant noise — "nuclear family", "war on poverty", "fleet of
 * vehicles". We deliberately quote multi-word phrases and avoid bare
 * generic terms unless the term is overwhelmingly news-coded (e.g. "IPO",
 * "OFAC", "CIA").
 *
 * Width target: ~12–18 OR clauses per topic. Wide enough to catch real
 * coverage even when an outlet uses synonyms; narrow enough that the
 * top-50 articles GDELT returns aren't diluted with off-topic noise.
 */

export interface IntelTopic {
  /** Stable id used as the iOS chip enum case + Redis key suffix. */
  id: string;
  /** Human-readable label shown in the iOS chip. */
  label: string;
  /** GDELT boolean query, ASCII only. */
  query: string;
}

export const INTEL_TOPICS: IntelTopic[] = [
  {
    id: 'conflict',
    label: 'CONFLICT',
    // Active armed-conflict events. Strict definition matching the
    // live-news LLM's `isConflict` classifier — kinetic events on the
    // ground, not diplomacy or commentary. Pinned first so it leads
    // the topic-fetch order on every refresh.
    query:
      '("armed conflict" OR airstrike OR "air strike" OR "drone strike" OR ' +
      '"missile strike" OR "missile attack" OR "rocket attack" OR shelling OR ' +
      'artillery OR "ground assault" OR firefight OR "armed clash" OR ' +
      'ceasefire OR "civilian casualties" OR "war crime" OR insurgent OR ' +
      'militant OR Hezbollah OR Hamas OR Houthi OR offensive OR "military strike") ' +
      'sourcelang:eng',
  },
  {
    id: 'cyber',
    label: 'CYBER',
    query:
      '(cyberattack OR "cyber attack" OR cybersecurity OR ransomware OR hacking OR hacker OR ' +
      '"data breach" OR "security breach" OR "data leak" OR phishing OR malware OR ' +
      '"zero-day" OR DDoS OR APT OR "supply chain attack" OR "denial of service" OR ' +
      '"hacked" OR "exploit") sourcelang:eng',
  },
  {
    id: 'military',
    label: 'MILITARY',
    query:
      '("armed forces" OR Pentagon OR "missile strike" OR "drone strike" OR airstrike OR ' +
      '"air strike" OR "troop deployment" OR "military exercise" OR "naval exercise" OR ' +
      '"military operation" OR "military aid" OR ceasefire OR "fighter jet" OR ' +
      '"ground forces" OR "missile launch" OR "war crime" OR "military base" OR ' +
      '"defense ministry" OR "joint exercise") sourcelang:eng',
  },
  {
    id: 'nuclear',
    label: 'NUCLEAR',
    query:
      // Avoid bare "nuclear" — matches "nuclear family" et al.
      '("nuclear weapon" OR "nuclear program" OR "nuclear test" OR "nuclear deal" OR ' +
      '"nuclear power" OR "nuclear plant" OR "nuclear reactor" OR "nuclear missile" OR ' +
      '"nuclear arsenal" OR "nuclear threat" OR "nuclear talks" OR uranium OR ' +
      '"uranium enrichment" OR plutonium OR IAEA OR "atomic bomb" OR "atomic energy" OR ' +
      '"non-proliferation" OR "nuclear inspection") sourcelang:eng',
  },
  {
    id: 'sanctions',
    label: 'SANCTIONS',
    query:
      '(sanctions OR sanctioned OR embargo OR OFAC OR "export controls" OR tariff OR ' +
      'tariffs OR "trade war" OR "frozen assets" OR blacklisted OR "asset freeze" OR ' +
      '"trade restriction" OR "economic pressure" OR "secondary sanctions" OR ' +
      '"sanctions package" OR "sanctions list" OR "designated entity") sourcelang:eng',
  },
  {
    id: 'intelligence',
    label: 'INTELLIGENCE',
    query:
      '(espionage OR spy OR CIA OR MI6 OR Mossad OR FSB OR FBI OR ' +
      '"intelligence agency" OR "intelligence officer" OR "intelligence service" OR ' +
      'covert OR surveillance OR wiretap OR "classified document" OR informant OR ' +
      '"intelligence leak" OR counterintelligence OR "double agent" OR ' +
      '"national security" OR defector) sourcelang:eng',
  },
  {
    id: 'maritime',
    label: 'MARITIME',
    query:
      // "fleet" alone over-matches ("fleet of vehicles") — drop it.
      '(warship OR "naval blockade" OR "naval base" OR "naval drill" OR "naval ship" OR ' +
      'piracy OR "Strait of Hormuz" OR "South China Sea" OR "Suez Canal" OR ' +
      '"shipping lane" OR "oil tanker" OR freighter OR submarine OR "coast guard" OR ' +
      '"Bab al-Mandeb" OR "Red Sea attack" OR "naval patrol" OR ' +
      '"freedom of navigation" OR "maritime security") sourcelang:eng',
  },

  // ────────────────────────────────────────────────────────────────────
  // Consumer topic chips — added to fill the gap noted in user feedback.
  // ────────────────────────────────────────────────────────────────────

  {
    id: 'business',
    label: 'BUSINESS',
    query:
      '(earnings OR IPO OR "stock market" OR "interest rate" OR "Federal Reserve" OR ' +
      '"central bank" OR merger OR acquisition OR layoffs OR "quarterly results" OR ' +
      '"Wall Street" OR Nasdaq OR "Dow Jones" OR inflation OR recession OR GDP OR ' +
      '"earnings report" OR "stock price" OR "market crash" OR "rate cut" OR ' +
      '"rate hike" OR "trade deal" OR "corporate profits") sourcelang:eng',
  },
  {
    id: 'scitech',
    label: 'SCI & TECH',
    query:
      '("artificial intelligence" OR "machine learning" OR semiconductor OR microchip OR ' +
      '"quantum computing" OR biotech OR vaccine OR "clinical trial" OR ' +
      '"space launch" OR rocket OR satellite OR "renewable energy" OR ' +
      '"nuclear fusion" OR "electric vehicle" OR robotics OR startup OR ' +
      '"venture capital" OR "AI model" OR "drug approval" OR "FDA approval" OR ' +
      '"genome editing" OR "scientific breakthrough") sourcelang:eng',
  },
  {
    id: 'entertainment',
    label: 'ENTERTAINMENT',
    query:
      '("box office" OR streaming OR Hollywood OR Netflix OR "film festival" OR ' +
      '"music album" OR concert OR Spotify OR "video game" OR Oscars OR Grammys OR ' +
      '"TV series" OR "film premiere" OR celebrity OR "movie release" OR ' +
      '"song release" OR "music video" OR "Emmy Awards" OR "Cannes Film" OR ' +
      '"album release" OR "world tour" OR "film studio") sourcelang:eng',
  },
];

export const VALID_TOPIC_IDS = new Set(INTEL_TOPICS.map((t) => t.id));
