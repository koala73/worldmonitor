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
}

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

  const addKeyword = (keyword: string, hubId: string) => {
    const lower = keyword.toLowerCase();
    const existing = byKeyword.get(lower) || [];
    if (!existing.includes(hubId)) {
      existing.push(hubId);
      byKeyword.set(lower, existing);
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
    addKeyword(eco.city, eco.id);

    // Add name variations
    if (eco.name !== eco.city) {
      hub.keywords.push(eco.name.toLowerCase());
      addKeyword(eco.name, eco.id);
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
      addKeyword(company.name, existingHub.id);

      // Add key products as keywords
      if (company.keyProducts) {
        for (const product of company.keyProducts) {
          existingHub.keywords.push(product.toLowerCase());
          addKeyword(product, existingHub.id);
        }
      }
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

      addKeyword(company.name, company.id);
      addKeyword(company.city, company.id);

      if (company.keyProducts) {
        for (const product of company.keyProducts) {
          hub.keywords.push(product.toLowerCase());
          addKeyword(product, company.id);
        }
      }

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
        // Add the hub's nickname as keyword
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

      addKeyword(sh.city, sh.id);
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
    addKeyword(alias, hubId);
  }

  cachedIndex = { hubs, byKeyword };
  return cachedIndex;
}

export interface HubMatch {
  hubId: string;
  hub: TechHubLocation;
  confidence: number;
  matchedKeyword: string;
}

export function inferHubsFromTitle(title: string): HubMatch[] {
  const index = buildTechHubIndex();
  const matches: HubMatch[] = [];
  const titleTokens = tokenizeForMatch(title);
  const seenHubs = new Set<string>();

  // Check each keyword
  for (const [keyword, hubIds] of index.byKeyword) {
    if (keyword.length < 3) continue; // Skip very short keywords

    if (matchKeyword(titleTokens, keyword)) {
      for (const hubId of hubIds) {
        if (seenHubs.has(hubId)) continue;
        seenHubs.add(hubId);

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

        matches.push({
          hubId,
          hub,
          confidence,
          matchedKeyword: keyword,
        });
      }
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);

  return matches;
}

export function getHubById(hubId: string): TechHubLocation | undefined {
  const index = buildTechHubIndex();
  return index.hubs.get(hubId);
}

export function getAllHubs(): TechHubLocation[] {
  const index = buildTechHubIndex();
  return Array.from(index.hubs.values());
}

export function getHubsByTier(tier: 'mega' | 'major' | 'emerging'): TechHubLocation[] {
  const index = buildTechHubIndex();
  return Array.from(index.hubs.values()).filter(h => h.tier === tier);
}
