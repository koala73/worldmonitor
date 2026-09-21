/**
 * AI Convo Hotspots — attention around product-era timeline windows.
 *
 * Channels in this catalog:
 * - `wiki` — Wikimedia pageviews by language edition → primary-country centroid
 *   (language ≠ nation; cited Pageviews API). Proxy for public readership attention.
 * - `trends` — Google Trends interest-by-country when CSVs present under
 *   scripts/_trends-ai-convo/<landmarkId>.csv (required otherwise).
 * - `news` — GDELT publisher-country ArtList (join-gdelt-ai-convo-hotspots.mjs).
 * - `social` — not joined yet (no reliable public geotagged social corpus).
 *
 * Missing channel ≠ 0. Regenerate wiki:
 *   node scripts/join-wiki-ai-convo-hotspots.mjs
 */

export type AiConvoChannel = 'wiki' | 'trends' | 'news' | 'social';

export type AiConvoHotspotPoint = {
  id: string;
  landmarkId: string;
  landmarkMs: number;
  channel: AiConvoChannel;
  iso2: string;
  iso3: string;
  name: string;
  lat: number;
  lon: number;
  /** Channel-native magnitude (pageviews, Trends 0–100, or article count) */
  weight: number;
  detail: string;
  sourceUrl: string;
};

export type AiConvoLandmarkMeta = {
  landmarkId: string;
  headline: string;
  landmarkMs: number;
  windowDays: number;
  channels: Partial<Record<AiConvoChannel, { pointCount: number; weightSum: number }>>;
  gaps: string[];
};

export const AI_CONVO_HOTSPOT_META: readonly AiConvoLandmarkMeta[] = [
  {
    "landmarkId": "chatgpt",
    "headline": "ChatGPT",
    "landmarkMs": 1669766400000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 5,
        "weightSum": 88348
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  },
  {
    "landmarkId": "msft-openai-2023",
    "headline": "MSFT–OpenAI",
    "landmarkMs": 1674432000000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 5,
        "weightSum": 2361309
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  },
  {
    "landmarkId": "gpt4-claude",
    "headline": "GPT-4 · Claude",
    "landmarkMs": 1678752000000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 5,
        "weightSum": 217968
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  },
  {
    "landmarkId": "llama2",
    "headline": "Llama 2",
    "landmarkMs": 1689638400000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 1,
        "weightSum": 103
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  },
  {
    "landmarkId": "devday-2023",
    "headline": "DevDay",
    "landmarkMs": 1699228800000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 5,
        "weightSum": 112388
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  },
  {
    "landmarkId": "gpt4o",
    "headline": "GPT-4o",
    "landmarkMs": 1715558400000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 5,
        "weightSum": 34829
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  },
  {
    "landmarkId": "claude-35-sonnet",
    "headline": "Claude 3.5",
    "landmarkMs": 1718928000000,
    "windowDays": 7,
    "channels": {
      "wiki": {
        "pointCount": 2,
        "weightSum": 15681
      }
    },
    "gaps": [
      "Google Trends interest-by-country CSV required",
      "GDELT news join required (rate-limited / run join-gdelt script)",
      "Social geotag corpus required"
    ]
  }
];

export const AI_CONVO_HOTSPOT_POINTS: readonly AiConvoHotspotPoint[] = [
  {
    "id": "convo-wiki-chatgpt-US",
    "landmarkId": "chatgpt",
    "landmarkMs": 1669766400000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 83510,
    "detail": "83,510 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-chatgpt-DE",
    "landmarkId": "chatgpt",
    "landmarkMs": 1669766400000,
    "channel": "wiki",
    "iso2": "DE",
    "iso3": "",
    "name": "Germany",
    "lat": 51.165691,
    "lon": 10.451526,
    "weight": 672,
    "detail": "672 Wikipedia pageviews (de)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-chatgpt-JP",
    "landmarkId": "chatgpt",
    "landmarkMs": 1669766400000,
    "channel": "wiki",
    "iso2": "JP",
    "iso3": "",
    "name": "Japan",
    "lat": 36.204824,
    "lon": 138.252924,
    "weight": 17,
    "detail": "17 Wikipedia pageviews (ja)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-chatgpt-CN",
    "landmarkId": "chatgpt",
    "landmarkMs": 1669766400000,
    "channel": "wiki",
    "iso2": "CN",
    "iso3": "",
    "name": "China",
    "lat": 35.86166,
    "lon": 104.195397,
    "weight": 3656,
    "detail": "3,656 Wikipedia pageviews (zh)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-chatgpt-ID",
    "landmarkId": "chatgpt",
    "landmarkMs": 1669766400000,
    "channel": "wiki",
    "iso2": "ID",
    "iso3": "",
    "name": "Indonesia",
    "lat": -0.789275,
    "lon": 113.921327,
    "weight": 493,
    "detail": "493 Wikipedia pageviews (id)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-msft-openai-2023-US",
    "landmarkId": "msft-openai-2023",
    "landmarkMs": 1674432000000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 1908421,
    "detail": "1,908,421 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-msft-openai-2023-DE",
    "landmarkId": "msft-openai-2023",
    "landmarkMs": 1674432000000,
    "channel": "wiki",
    "iso2": "DE",
    "iso3": "",
    "name": "Germany",
    "lat": 51.165691,
    "lon": 10.451526,
    "weight": 213724,
    "detail": "213,724 Wikipedia pageviews (de)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-msft-openai-2023-FR",
    "landmarkId": "msft-openai-2023",
    "landmarkMs": 1674432000000,
    "channel": "wiki",
    "iso2": "FR",
    "iso3": "",
    "name": "France",
    "lat": 46.227638,
    "lon": 2.213749,
    "weight": 146948,
    "detail": "146,948 Wikipedia pageviews (fr)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-msft-openai-2023-JP",
    "landmarkId": "msft-openai-2023",
    "landmarkMs": 1674432000000,
    "channel": "wiki",
    "iso2": "JP",
    "iso3": "",
    "name": "Japan",
    "lat": 36.204824,
    "lon": 138.252924,
    "weight": 51275,
    "detail": "51,275 Wikipedia pageviews (ja)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-msft-openai-2023-CN",
    "landmarkId": "msft-openai-2023",
    "landmarkMs": 1674432000000,
    "channel": "wiki",
    "iso2": "CN",
    "iso3": "",
    "name": "China",
    "lat": 35.86166,
    "lon": 104.195397,
    "weight": 40941,
    "detail": "40,941 Wikipedia pageviews (zh)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4-claude-US",
    "landmarkId": "gpt4-claude",
    "landmarkMs": 1678752000000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 186779,
    "detail": "186,779 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4-claude-FR",
    "landmarkId": "gpt4-claude",
    "landmarkMs": 1678752000000,
    "channel": "wiki",
    "iso2": "FR",
    "iso3": "",
    "name": "France",
    "lat": 46.227638,
    "lon": 2.213749,
    "weight": 2680,
    "detail": "2,680 Wikipedia pageviews (fr)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4-claude-JP",
    "landmarkId": "gpt4-claude",
    "landmarkMs": 1678752000000,
    "channel": "wiki",
    "iso2": "JP",
    "iso3": "",
    "name": "Japan",
    "lat": 36.204824,
    "lon": 138.252924,
    "weight": 13559,
    "detail": "13,559 Wikipedia pageviews (ja)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4-claude-CN",
    "landmarkId": "gpt4-claude",
    "landmarkMs": 1678752000000,
    "channel": "wiki",
    "iso2": "CN",
    "iso3": "",
    "name": "China",
    "lat": 35.86166,
    "lon": 104.195397,
    "weight": 11742,
    "detail": "11,742 Wikipedia pageviews (zh)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4-claude-ES",
    "landmarkId": "gpt4-claude",
    "landmarkMs": 1678752000000,
    "channel": "wiki",
    "iso2": "ES",
    "iso3": "",
    "name": "Spain",
    "lat": 40.463667,
    "lon": -3.74922,
    "weight": 3208,
    "detail": "3,208 Wikipedia pageviews (es)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-llama2-US",
    "landmarkId": "llama2",
    "landmarkMs": 1689638400000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 103,
    "detail": "103 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-devday-2023-US",
    "landmarkId": "devday-2023",
    "landmarkMs": 1699228800000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 89648,
    "detail": "89,648 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-devday-2023-DE",
    "landmarkId": "devday-2023",
    "landmarkMs": 1699228800000,
    "channel": "wiki",
    "iso2": "DE",
    "iso3": "",
    "name": "Germany",
    "lat": 51.165691,
    "lon": 10.451526,
    "weight": 6226,
    "detail": "6,226 Wikipedia pageviews (de)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-devday-2023-FR",
    "landmarkId": "devday-2023",
    "landmarkMs": 1699228800000,
    "channel": "wiki",
    "iso2": "FR",
    "iso3": "",
    "name": "France",
    "lat": 46.227638,
    "lon": 2.213749,
    "weight": 5978,
    "detail": "5,978 Wikipedia pageviews (fr)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-devday-2023-JP",
    "landmarkId": "devday-2023",
    "landmarkMs": 1699228800000,
    "channel": "wiki",
    "iso2": "JP",
    "iso3": "",
    "name": "Japan",
    "lat": 36.204824,
    "lon": 138.252924,
    "weight": 4226,
    "detail": "4,226 Wikipedia pageviews (ja)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-devday-2023-CN",
    "landmarkId": "devday-2023",
    "landmarkMs": 1699228800000,
    "channel": "wiki",
    "iso2": "CN",
    "iso3": "",
    "name": "China",
    "lat": 35.86166,
    "lon": 104.195397,
    "weight": 6310,
    "detail": "6,310 Wikipedia pageviews (zh)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4o-US",
    "landmarkId": "gpt4o",
    "landmarkMs": 1715558400000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 28211,
    "detail": "28,211 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4o-FR",
    "landmarkId": "gpt4o",
    "landmarkMs": 1715558400000,
    "channel": "wiki",
    "iso2": "FR",
    "iso3": "",
    "name": "France",
    "lat": 46.227638,
    "lon": 2.213749,
    "weight": 350,
    "detail": "350 Wikipedia pageviews (fr)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4o-CN",
    "landmarkId": "gpt4o",
    "landmarkMs": 1715558400000,
    "channel": "wiki",
    "iso2": "CN",
    "iso3": "",
    "name": "China",
    "lat": 35.86166,
    "lon": 104.195397,
    "weight": 5181,
    "detail": "5,181 Wikipedia pageviews (zh)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4o-ES",
    "landmarkId": "gpt4o",
    "landmarkMs": 1715558400000,
    "channel": "wiki",
    "iso2": "ES",
    "iso3": "",
    "name": "Spain",
    "lat": 40.463667,
    "lon": -3.74922,
    "weight": 60,
    "detail": "60 Wikipedia pageviews (es)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-gpt4o-KR",
    "landmarkId": "gpt4o",
    "landmarkMs": 1715558400000,
    "channel": "wiki",
    "iso2": "KR",
    "iso3": "",
    "name": "South Korea",
    "lat": 35.907757,
    "lon": 127.766922,
    "weight": 1027,
    "detail": "1,027 Wikipedia pageviews (ko)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-claude-35-sonnet-US",
    "landmarkId": "claude-35-sonnet",
    "landmarkMs": 1718928000000,
    "channel": "wiki",
    "iso2": "US",
    "iso3": "",
    "name": "United States",
    "lat": 37.09024,
    "lon": -95.712891,
    "weight": 14272,
    "detail": "14,272 Wikipedia pageviews (en)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  },
  {
    "id": "convo-wiki-claude-35-sonnet-JP",
    "landmarkId": "claude-35-sonnet",
    "landmarkMs": 1718928000000,
    "channel": "wiki",
    "iso2": "JP",
    "iso3": "",
    "name": "Japan",
    "lat": 36.204824,
    "lon": 138.252924,
    "weight": 1409,
    "detail": "1,409 Wikipedia pageviews (ja)",
    "sourceUrl": "https://wikimedia.org/api/rest_v1/"
  }
];

export const AI_CONVO_LANDMARK_MS: readonly number[] = [1669766400000,1674432000000,1678752000000,1689638400000,1699228800000,1715558400000,1718928000000];

export function aiConvoHotspotPointsAt(focusMs: number | null): AiConvoHotspotPoint[] {
  if (AI_CONVO_HOTSPOT_POINTS.length === 0) return [];
  if (focusMs == null) {
    let latest: number | null = null;
    for (const t of AI_CONVO_LANDMARK_MS) {
      if (AI_CONVO_HOTSPOT_POINTS.some((p) => p.landmarkMs === t)) latest = t;
    }
    if (latest == null) return [];
    return AI_CONVO_HOTSPOT_POINTS.filter((p) => p.landmarkMs === latest);
  }
  if (!AI_CONVO_LANDMARK_MS.includes(focusMs)) return [];
  return AI_CONVO_HOTSPOT_POINTS.filter((p) => p.landmarkMs === focusMs);
}
