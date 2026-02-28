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
  'bandar abbas': { lat: 27.1865, lon: 56.2808, name: 'Bandar Abbas, Iran' },
  'nahavand': { lat: 34.1883, lon: 48.3733, name: 'Nahavand, Iran' },
  'tabriz': { lat: 38.0800, lon: 46.2919, name: 'Tabriz, Iran' },
  'konarak': { lat: 25.3500, lon: 60.3833, name: 'Konarak, Iran' },
  'basra': { lat: 30.5085, lon: 47.7804, name: 'Basra, Iraq' },
  'jebel ali': { lat: 24.9857, lon: 55.0272, name: 'Jebel Ali, Dubai' },
  'al udeid': { lat: 25.1174, lon: 51.3150, name: 'Al Udeid Air Base, Qatar' },
  'eilat': { lat: 29.5577, lon: 34.9519, name: 'Eilat, Israel' },
  'homs': { lat: 34.7324, lon: 36.7137, name: 'Homs, Syria' },
  'gaza': { lat: 31.3547, lon: 34.3088, name: 'Gaza' },
  'rafah': { lat: 31.2969, lon: 34.2455, name: 'Rafah' },
  'shuaiba': { lat: 29.0333, lon: 48.1667, name: 'Shuaiba Port, Kuwait' },
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
