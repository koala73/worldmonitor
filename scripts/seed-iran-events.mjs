#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REDIS_KEY = 'conflict:iran-events:v1';

const LOCATION_COORDS = {
  'tehran': { lat: 35.6892, lon: 51.3890, name: 'Tehran, Iran' },
  'isfahan': { lat: 32.6546, lon: 51.6680, name: 'Isfahan, Iran' },
  'shiraz': { lat: 29.5918, lon: 52.5837, name: 'Shiraz, Iran' },
  'bushehr': { lat: 28.9684, lon: 50.8385, name: 'Bushehr, Iran' },
  'karaj': { lat: 35.8400, lon: 50.9391, name: 'Karaj, Iran' },
  'zanjan': { lat: 36.6736, lon: 48.4787, name: 'Zanjan, Iran' },
  'sanandaj': { lat: 35.3219, lon: 46.9862, name: 'Sanandaj, Iran' },
  'chabahar': { lat: 25.2919, lon: 60.6430, name: 'Chabahar, Iran' },
  'marand': { lat: 38.4319, lon: 45.7742, name: 'Marand, Iran' },
  'minab': { lat: 27.1061, lon: 57.0801, name: 'Minab, Iran' },
  'kish': { lat: 26.5396, lon: 53.9801, name: 'Kish Island, Iran' },
  'tel aviv': { lat: 32.0853, lon: 34.7818, name: 'Tel Aviv, Israel' },
  'haifa': { lat: 32.7940, lon: 34.9896, name: 'Haifa, Israel' },
  'israel': { lat: 31.7683, lon: 35.2137, name: 'Israel' },
  'sharon': { lat: 32.3500, lon: 34.8833, name: 'Sharon, Israel' },
  'dubai': { lat: 25.2048, lon: 55.2708, name: 'Dubai, UAE' },
  'abu dhabi': { lat: 24.4539, lon: 54.3773, name: 'Abu Dhabi, UAE' },
  'palm jumeirah': { lat: 25.1124, lon: 55.1390, name: 'Palm Jumeirah, Dubai' },
  'burj khalifa': { lat: 25.1972, lon: 55.2744, name: 'Burj Khalifa, Dubai' },
  'doha': { lat: 25.2854, lon: 51.5310, name: 'Doha, Qatar' },
  'qatar': { lat: 25.3548, lon: 51.1839, name: 'Qatar' },
  'bahrain': { lat: 26.0667, lon: 50.5577, name: 'Bahrain' },
  'manama': { lat: 26.2285, lon: 50.5860, name: 'Manama, Bahrain' },
  'riyadh': { lat: 24.7136, lon: 46.6753, name: 'Riyadh, Saudi Arabia' },
  'saudi': { lat: 24.7136, lon: 46.6753, name: 'Saudi Arabia' },
  'kuwait': { lat: 29.3759, lon: 47.9774, name: 'Kuwait' },
  'ali al salem': { lat: 29.3467, lon: 47.5211, name: 'Ali Al Salem Air Base, Kuwait' },
  'erbil': { lat: 36.1912, lon: 44.0119, name: 'Erbil, Iraq' },
  'baghdad': { lat: 33.3152, lon: 44.3661, name: 'Baghdad, Iraq' },
  'jurf al-sakhr': { lat: 32.8500, lon: 44.1000, name: 'Jurf al-Sakhr, Iraq' },
  'iraq': { lat: 33.3152, lon: 44.3661, name: 'Iraq' },
  'jordan': { lat: 31.9454, lon: 35.9284, name: 'Jordan' },
  'daraa': { lat: 32.6189, lon: 36.1021, name: 'Daraa, Syria' },
  'syria': { lat: 34.8021, lon: 38.9968, name: 'Syria' },
  'lebanon': { lat: 33.8547, lon: 35.8623, name: 'Lebanon' },
  'hormuz': { lat: 26.5944, lon: 56.4667, name: 'Strait of Hormuz' },
  'iran': { lat: 32.4279, lon: 53.6880, name: 'Iran' },
  'uae': { lat: 24.4539, lon: 54.3773, name: 'UAE' },
  'united arab emirates': { lat: 24.4539, lon: 54.3773, name: 'UAE' },
  'oman': { lat: 23.5880, lon: 58.3829, name: 'Oman' },
  'egypt': { lat: 30.0444, lon: 31.2357, name: 'Egypt' },
  'turkey': { lat: 39.9334, lon: 32.8597, name: 'Turkey' },
  'china': { lat: 39.9042, lon: 116.4074, name: 'China' },
  'pakistan': { lat: 33.6844, lon: 73.0479, name: 'Pakistan' },
  'afghanistan': { lat: 34.5553, lon: 69.2075, name: 'Afghanistan' },
  'kurdistan': { lat: 36.1912, lon: 44.0119, name: 'Kurdistan, Iraq' },
  'duhok': { lat: 36.8669, lon: 42.9503, name: 'Duhok, Iraq' },
  'hawler': { lat: 36.1912, lon: 44.0119, name: 'Hawler (Erbil), Iraq' },
  'beersheba': { lat: 31.2518, lon: 34.7913, name: 'Beersheba, Israel' },
  "be'er sheva": { lat: 31.2518, lon: 34.7913, name: "Be'er Sheva, Israel" },
  'beer sheva': { lat: 31.2518, lon: 34.7913, name: "Be'er Sheva, Israel" },
  'beit shemesh': { lat: 31.7465, lon: 34.9866, name: 'Beit Shemesh, Israel' },
  'negev': { lat: 30.8500, lon: 34.7818, name: 'Negev, Israel' },
  'cyprus': { lat: 34.7071, lon: 33.0226, name: 'Cyprus' },
  'akrotiri': { lat: 34.5839, lon: 32.9568, name: 'Akrotiri, Cyprus' },
  'dhekelia': { lat: 34.9833, lon: 33.7167, name: 'Dhekelia, Cyprus' },
  'paphos': { lat: 34.7720, lon: 32.4297, name: 'Paphos, Cyprus' },
  'bandar abbas': { lat: 27.1865, lon: 56.2808, name: 'Bandar Abbas, Iran' },
  'kerman': { lat: 30.2839, lon: 57.0834, name: 'Kerman, Iran' },
  'lorestan': { lat: 33.4963, lon: 48.3558, name: 'Lorestan, Iran' },
  'mahabad': { lat: 36.7631, lon: 45.7222, name: 'Mahabad, Iran' },
  'shahinshahr': { lat: 32.8631, lon: 51.5505, name: 'Shahinshahr, Iran' },
  'fars': { lat: 29.1043, lon: 53.0450, name: 'Fars Province, Iran' },
  'natanz': { lat: 33.5131, lon: 51.9164, name: 'Natanz, Iran' },
  'beirut': { lat: 33.8938, lon: 35.5018, name: 'Beirut, Lebanon' },
  'baalbek': { lat: 34.0047, lon: 36.2110, name: 'Baalbek, Lebanon' },
  'ras tanura': { lat: 26.6444, lon: 50.0555, name: 'Ras Tanura, Saudi Arabia' },
  'aramco': { lat: 26.3927, lon: 50.0993, name: 'Aramco, Saudi Arabia' },
  'ras al khaimah': { lat: 25.7895, lon: 55.9432, name: 'Ras Al Khaimah, UAE' },
  'muscat': { lat: 23.5880, lon: 58.3829, name: 'Muscat, Oman' },
  'ras laffan': { lat: 25.9170, lon: 51.5360, name: 'Ras Laffan, Qatar' },
  'quneitra': { lat: 33.1260, lon: 35.8240, name: 'Quneitra, Syria' },
  'khomein': { lat: 33.6351, lon: 50.0755, name: 'Khomein, Iran' },
  'markazi': { lat: 34.0950, lon: 49.6952, name: 'Markazi Province, Iran' },
  'kashan': { lat: 33.9849, lon: 51.4346, name: 'Kashan, Iran' },
  'qom': { lat: 34.6401, lon: 50.8764, name: 'Qom, Iran' },
  'ahvaz': { lat: 31.3183, lon: 48.6706, name: 'Ahvaz, Iran' },
  'dezful': { lat: 32.3884, lon: 48.3989, name: 'Dezful, Iran' },
  'khorramshahr': { lat: 30.4389, lon: 48.1800, name: 'Khorramshahr, Iran' },
  'ilam': { lat: 33.6374, lon: 46.4227, name: 'Ilam, Iran' },
  'laar': { lat: 27.6835, lon: 54.3374, name: 'Laar, Fars Province, Iran' },
  'lar': { lat: 27.6835, lon: 54.3374, name: 'Lar, Fars Province, Iran' },
  'kermanshah': { lat: 34.3142, lon: 47.0650, name: 'Kermanshah, Iran' },
  'fujairah': { lat: 25.1288, lon: 56.3265, name: 'Fujairah, UAE' },
  'hermel': { lat: 34.3975, lon: 36.3867, name: 'Hermel, Lebanon' },
  'amman': { lat: 31.9454, lon: 35.9284, name: 'Amman, Jordan' },
  'jeddah': { lat: 21.4858, lon: 39.1925, name: 'Jeddah, Saudi Arabia' },
  'dhahran': { lat: 26.3234, lon: 50.1315, name: 'Dhahran, Saudi Arabia' },
  'al minhad': { lat: 25.0267, lon: 55.3660, name: 'Al Minhad Air Base, UAE' },
  'galilee': { lat: 32.8823, lon: 35.4960, name: 'Galilee, Israel' },
  'evin': { lat: 35.7762, lon: 51.3690, name: 'Evin, Tehran, Iran' },
  'bukan': { lat: 36.5211, lon: 46.2089, name: 'Bukan, Iran' },
  'saqqez': { lat: 36.2498, lon: 46.2735, name: 'Saqqez, Iran' },
  'sardasht': { lat: 36.1551, lon: 45.4773, name: 'Sardasht, Iran' },
  'marivan': { lat: 35.5275, lon: 46.1761, name: 'Marivan, Iran' },
  'baneh': { lat: 35.9975, lon: 45.8853, name: 'Baneh, Iran' },
  'sulaymaniyah': { lat: 35.5568, lon: 45.4351, name: 'Sulaymaniyah, Iraq' },
  'riffa': { lat: 26.1300, lon: 50.5550, name: 'Riffa, Bahrain' },
  'al-kharj': { lat: 24.1500, lon: 47.3000, name: 'Al-Kharj, Saudi Arabia' },
  'al-jawf': { lat: 29.8144, lon: 39.8742, name: 'Al-Jawf, Saudi Arabia' },
  'mehrabad': { lat: 35.6892, lon: 51.3134, name: 'Mehrabad Airport, Tehran, Iran' },
  'mahallati': { lat: 35.7500, lon: 51.4500, name: 'Mahallati, Tehran, Iran' },
  'tehransar': { lat: 35.7000, lon: 51.2800, name: 'Tehransar, Tehran, Iran' },
  'borujerdi': { lat: 35.6500, lon: 51.4200, name: 'Borujerdi Town, Tehran, Iran' },
  'incirlik': { lat: 37.0021, lon: 35.4259, name: 'Incirlik Air Base, Turkey' },
  'aqaba': { lat: 29.5267, lon: 35.0078, name: 'Aqaba, Jordan' },
  'ashkelon': { lat: 31.6688, lon: 34.5743, name: 'Ashkelon, Israel' },
  'jerusalem': { lat: 31.7683, lon: 35.2137, name: 'Jerusalem, Israel' },
  'sri lanka': { lat: 7.8731, lon: 80.7718, name: 'Sri Lanka' },
  'tabriz': { lat: 38.0800, lon: 46.2919, name: 'Tabriz, Iran' },
  'yazd': { lat: 31.8974, lon: 54.3569, name: 'Yazd, Iran' },
  'hatay': { lat: 36.4018, lon: 36.3498, name: 'Hatay, Turkey' },
  'najaf': { lat: 32.0000, lon: 44.3360, name: 'Najaf, Iraq' },
  'hazmieh': { lat: 33.8500, lon: 35.5400, name: 'Hazmieh, Beirut, Lebanon' },
  'paveh': { lat: 35.0431, lon: 46.3556, name: 'Paveh, Kermanshah, Iran' },
  'parchin': { lat: 35.5200, lon: 51.7700, name: 'Parchin, Tehran, Iran' },
  'rasht': { lat: 37.2808, lon: 49.5832, name: 'Rasht, Iran' },
  'khorramabad': { lat: 33.4878, lon: 48.3558, name: 'Khorramabad, Iran' },
  'damavand': { lat: 35.7131, lon: 52.0634, name: 'Damavand, Iran' },
  'parand': { lat: 35.4897, lon: 51.0088, name: 'Parand, Tehran, Iran' },
  'javanrud': { lat: 34.8039, lon: 46.4936, name: 'Javanrud, Kermanshah, Iran' },
  'basra': { lat: 30.5085, lon: 47.7804, name: 'Basra, Iraq' },
  'karbala': { lat: 32.6160, lon: 44.0249, name: 'Karbala, Iraq' },
  'nakhchivan': { lat: 39.2089, lon: 45.4122, name: 'Nakhchivan, Azerbaijan' },
  'koya': { lat: 36.0833, lon: 44.6333, name: 'Koya, Kurdistan, Iraq' },
  'elad': { lat: 32.0522, lon: 34.9508, name: 'Elad, Israel' },
  'juffair': { lat: 26.2167, lon: 50.6000, name: 'Juffair, Bahrain' },
  'hodeidah': { lat: 14.7979, lon: 42.9540, name: 'Hodeidah, Yemen' },
  "sana'a": { lat: 15.3694, lon: 44.1910, name: "Sana'a, Yemen" },
  'sanaa': { lat: 15.3694, lon: 44.1910, name: "Sana'a, Yemen" },
  "ma'ameer": { lat: 26.1500, lon: 50.5300, name: "Ma'ameer, Bahrain" },
  'maameer': { lat: 26.1500, lon: 50.5300, name: "Ma'ameer, Bahrain" },
  'pakdasht': { lat: 35.4700, lon: 51.6800, name: 'Pakdasht, Tehran, Iran' },
  'alborz': { lat: 35.8366, lon: 50.9714, name: 'Alborz Province, Iran' },
  'khor al-zubair': { lat: 30.2833, lon: 47.7500, name: 'Khor al-Zubair, Iraq' },
  'prince sultan': { lat: 24.0625, lon: 47.5802, name: 'Prince Sultan Air Base, Saudi Arabia' },
  'ben gurion': { lat: 32.0055, lon: 34.8854, name: 'Ben Gurion Airport, Israel' },
  'tel nof': { lat: 31.8394, lon: 34.8227, name: 'Tel Nof Air Base, Israel' },
  'azerbaijan': { lat: 40.4093, lon: 49.8671, name: 'Azerbaijan' },
  'yemen': { lat: 15.5527, lon: 48.5164, name: 'Yemen' },
};

const CATEGORY_SEVERITY = {
  'cat1': 'critical',
  'cat2': 'medium',
  'cat5': 'low',
  'cat6': 'high',
  'cat7': 'medium',
  'cat9': 'low',
  'cat10': 'high',
  'cat11': 'high',
};

function geocodeFromTitle(title) {
  const lower = title.toLowerCase();
  for (const [keyword, coords] of Object.entries(LOCATION_COORDS)) {
    if (lower.includes(keyword)) {
      return coords;
    }
  }
  return { lat: 32.4279, lon: 53.6880, name: 'Iran' };
}

function loadEnvFile() {
  // Try worktree first, then main repo
  let envPath = join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) {
    envPath = join('/Users/eliehabib/Documents/GitHub/worldmonitor', '.env.local');
  }
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

async function main() {
  loadEnvFile();

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  const dataPath = join(__dirname, 'data', 'iran-events-latest.json');
  if (!existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(dataPath, 'utf8'));
  const filtered = raw.filter(e => e.id && e.title);

  console.log(`=== Iran Events Import ===`);
  console.log(`  Redis:     ${redisUrl}`);
  console.log(`  Token:     ${maskToken(redisToken)}`);
  console.log(`  Raw:       ${raw.length} entries`);
  console.log(`  Valid:     ${filtered.length} entries (after filtering empty)`);
  console.log();

  const events = filtered.map(e => {
    const geo = geocodeFromTitle(e.title);
    return {
      id: e.id,
      title: e.title,
      category: e.category || 'cat1',
      sourceUrl: e.link || '',
      latitude: geo.lat,
      longitude: geo.lon,
      locationName: geo.name,
      timestamp: Date.now(),
      severity: CATEGORY_SEVERITY[e.category] || 'medium',
    };
  });

  const payload = {
    events,
    scrapedAt: Date.now(),
  };

  console.log(`  Mapped ${events.length} events with geocoding`);
  console.log(`  Sample: ${events[0]?.title?.slice(0, 60)}... → ${events[0]?.locationName}`);
  console.log();

  const body = JSON.stringify(['SET', REDIS_KEY, JSON.stringify(payload)]);
  const resp = await fetch(`${redisUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`Redis SET failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log(`  Redis SET result:`, result);

  // Verify
  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (getResp.ok) {
    const getData = await getResp.json();
    if (getData.result) {
      const parsed = JSON.parse(getData.result);
      console.log(`\n  Verified: ${parsed.events?.length} events in Redis`);
      console.log(`  scrapedAt: ${new Date(parsed.scrapedAt).toISOString()}`);
    }
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
