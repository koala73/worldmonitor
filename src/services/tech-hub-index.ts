import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { STARTUP_HUBS } from '@/config/tech-geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';

export interface TechHubLocation {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  type: 'ecosystem' | 'company' | 'hub';
  tier: 'mega' | 'major' | 'emerging';
  keywords: string[];
}

interface TechHubIndex {
  hubs: Map<string, TechHubLocation>;
  byKeyword: Map<string, string[]>;
  places: Set<string>;
}

// Product categories listed beside a company's brand names. As headline words
// they are ordinary language ("Crews search for 6 aboard..."), so only the
// company's own name places such a story at its hub.
const GENERIC_PRODUCT_TERMS = new Set([
  'search', 'cloud', 'e-commerce', 'gaming', 'command', 'embed', 'rerank', 'inference', 'transformers',
  'apollo', 'erp', 'mlops', 'lakehouse', 'api platform', 'ai automation', 'ai search', 'ai recommendations',
  'chip manufacturing', 'data labeling', 'foundation model platforms', 'model hub', 'inference chips',
  'music streaming', '3nm process', '5nm process', 'european hq', 'european engineering hub', 'apac operations',
]);

// 'Google/Alphabet' -> 'Google': the joined form never appears in a headline, and
// the holding-company name is an ordinary word.
const brandName = (companyName: string) => companyName.replace(/\/.*$/, '');

let cachedIndex: TechHubIndex | null = null;

function normalizeTier(tier: string | undefined): 'mega' | 'major' | 'emerging' {
  if (!tier) return 'emerging';
  if (tier === 'tier1' || tier === 'mega') return 'mega';
  if (tier === 'tier2' || tier === 'major') return 'major';
  return 'emerging';
}

function buildTechHubIndex(): TechHubIndex {
  if (cachedIndex) return cachedIndex;

  const hubs = new Map<string, TechHubLocation>();
  const byKeyword = new Map<string, string[]>();
  const places = new Set<string>();

  const addKeyword = (keyword: string, hubId: string) => {
    const lower = keyword.toLowerCase();
    const existing = byKeyword.get(lower) || [];
    if (!existing.includes(hubId)) {
      existing.push(hubId);
      byKeyword.set(lower, existing);
    }
  };

  const addPlace = (place: string, hubId: string) => {
    places.add(place.toLowerCase());
    addKeyword(place, hubId);
  };

  const addProducts = (hub: TechHubLocation, products: string[] | undefined) => {
    for (const product of products ?? []) {
      if (GENERIC_PRODUCT_TERMS.has(product.toLowerCase())) continue;
      hub.keywords.push(product.toLowerCase());
      addKeyword(product, hub.id);
    }
  };

  // Add startup ecosystems (richest data source)
  for (const eco of STARTUP_ECOSYSTEMS) {
    const hub: TechHubLocation = {
      id: eco.id,
      name: eco.name,
      city: eco.city,
      country: eco.country,
      lat: eco.lat,
      lon: eco.lon,
      type: 'ecosystem',
      tier: normalizeTier(eco.ecosystemTier),
      keywords: [],
    };

    // Add keywords
    hub.keywords.push(eco.city.toLowerCase());
    addPlace(eco.city, eco.id);

    // Add name variations
    if (eco.name !== eco.city) {
      hub.keywords.push(eco.name.toLowerCase());
      addPlace(eco.name, eco.id);
    }

    // Add notable startups as keywords
    if (eco.notableStartups) {
      for (const startup of eco.notableStartups) {
        hub.keywords.push(startup.toLowerCase());
        addKeyword(startup, eco.id);
      }
    }

    // Add major VCs as keywords
    if (eco.majorVCs) {
      for (const vc of eco.majorVCs) {
        hub.keywords.push(vc.toLowerCase());
        addKeyword(vc, eco.id);
      }
    }

    hubs.set(eco.id, hub);
  }

  // Add tech companies (map to existing hubs or create new entries)
  for (const company of TECH_COMPANIES) {
    // Skip companies without city data
    if (!company.city) continue;

    // Find existing hub by city
    let existingHub: TechHubLocation | undefined;
    for (const hub of hubs.values()) {
      if (hub.city.toLowerCase() === company.city.toLowerCase()) {
        existingHub = hub;
        break;
      }
    }

    if (existingHub) {
      // Add company name as keyword to existing hub
      existingHub.keywords.push(company.name.toLowerCase());
      addKeyword(brandName(company.name), existingHub.id);
      addProducts(existingHub, company.keyProducts);
    } else {
      // Create new hub for this company
      const hub: TechHubLocation = {
        id: company.id,
        name: company.name,
        city: company.city,
        country: company.country,
        lat: company.lat,
        lon: company.lon,
        type: 'company',
        tier: 'major',
        keywords: [company.name.toLowerCase(), company.city.toLowerCase()],
      };

      addKeyword(brandName(company.name), company.id);
      addPlace(company.city, company.id);
      addProducts(hub, company.keyProducts);

      hubs.set(company.id, hub);
    }
  }

  // Add simplified startup hubs (fill gaps)
  for (const sh of STARTUP_HUBS) {
    // Check if we already have this location
    let exists = false;
    for (const hub of hubs.values()) {
      if (hub.city.toLowerCase() === sh.city.toLowerCase()) {
        exists = true;
        // Hub nicknames and accelerators (Silicon Beach, Station F, Hub71) name the tech scene, not just the city
        if (sh.name !== sh.city) {
          hub.keywords.push(sh.name.toLowerCase());
          addKeyword(sh.name, hub.id);
        }
        break;
      }
    }

    if (!exists) {
      const hub: TechHubLocation = {
        id: sh.id,
        name: sh.name,
        city: sh.city,
        country: sh.country,
        lat: sh.lat,
        lon: sh.lon,
        type: 'hub',
        tier: sh.tier,
        keywords: [sh.city.toLowerCase()],
      };

      if (sh.name !== sh.city) {
        hub.keywords.push(sh.name.toLowerCase());
        addKeyword(sh.name, sh.id);
      }

      addPlace(sh.city, sh.id);
      hubs.set(sh.id, hub);
    }
  }

  // Add common region aliases
  const regionAliases: Record<string, string> = {
    'silicon valley': 'sf-bay-area',
    'bay area': 'sf-bay-area',
    'san francisco bay': 'sf-bay-area',
    'research triangle': 'raleigh-durham',
    'startup nation': 'telaviv',
    'silicon beach': 'la',
    'silicon savannah': 'nairobi',
    'station f': 'paris',
    'zhongguancun': 'beijing',
    'tech city': 'london',
  };

  for (const [alias, hubId] of Object.entries(regionAliases)) {
    addPlace(alias, hubId);
  }

  cachedIndex = { hubs, byKeyword, places };
  return cachedIndex;
}

export interface HubMatch {
  hubId: string;
  hub: TechHubLocation;
  confidence: number;
  matchedKeyword: string;
  /** 'place' when the hub matched only by its city or region name, which any story can mention. */
  evidence: 'place' | 'name';
}

export function inferHubsFromTitle(title: string): HubMatch[] {
  const index = buildTechHubIndex();
  const matchesByHub = new Map<string, HubMatch>();
  const tokens = tokenizeForMatch(title);

  for (const [keyword, hubIds] of index.byKeyword) {
    if (keyword.length < 3) continue;

    if (matchKeyword(tokens, keyword)) {
      const evidence = index.places.has(keyword) ? 'place' : 'name';
      for (const hubId of hubIds) {
        const seen = matchesByHub.get(hubId);
        if (seen && (seen.evidence === 'name' || evidence === 'place')) continue;

        const hub = index.hubs.get(hubId);
        if (!hub) continue;

        // Calculate confidence based on keyword length and specificity
        let confidence = 0.5;
        if (keyword.length >= 10) confidence = 0.9; // Long keywords are specific
        else if (keyword.length >= 6) confidence = 0.7;

        // Boost for company names (more specific)
        if (hub.type === 'company' || keyword === hub.name.toLowerCase()) {
          confidence = Math.min(1, confidence + 0.2);
        }

        matchesByHub.set(hubId, { hubId, hub, confidence, matchedKeyword: keyword, evidence });
      }
    }
  }

  // Sort by confidence descending
  const matches = [...matchesByHub.values()];
  matches.sort((a, b) => b.confidence - a.confidence);

  return matches;
}
