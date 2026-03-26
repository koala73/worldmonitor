/**
 * Additional cyber threat intelligence sources:
 * ThreatFox, OpenPhish, Spamhaus DROP, CISA KEV
 *
 * All fetch from local sidecar routes. Sources without lat/lon use 0,0
 * (omitted from map globe; shown in panel table).
 */
import { getApiBaseUrl } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import type { CyberThreat } from '@/types';

// ── ThreatFox ──────────────────────────────────────────────────────────────
export async function fetchThreatFoxIOCs(): Promise<CyberThreat[]> {
  if (!isFeatureAvailable('threatfoxThreatIntel')) return [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/threatfox-iocs`, { method: 'GET' });
    if (!res.ok) return [];
    return (await res.json()) as CyberThreat[];
  } catch {
    return [];
  }
}

// ── OpenPhish ──────────────────────────────────────────────────────────────
export async function fetchOpenPhishFeed(): Promise<CyberThreat[]> {
  if (!isFeatureAvailable('openPhishThreatIntel')) return [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/openphish-feed`);
    if (!res.ok) return [];
    return (await res.json()) as CyberThreat[];
  } catch {
    return [];
  }
}

// ── Spamhaus DROP/EDROP ────────────────────────────────────────────────────
export async function fetchSpamhausDrop(): Promise<CyberThreat[]> {
  if (!isFeatureAvailable('spamhausDrop')) return [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/spamhaus-drop`);
    if (!res.ok) return [];
    return (await res.json()) as CyberThreat[];
  } catch {
    return [];
  }
}

// ── CISA KEV ───────────────────────────────────────────────────────────────
export async function fetchCisaKev(): Promise<CyberThreat[]> {
  if (!isFeatureAvailable('cisaKev')) return [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/cisa-kev`);
    if (!res.ok) return [];
    return (await res.json()) as CyberThreat[];
  } catch {
    return [];
  }
}

// ── AlienVault OTX ─────────────────────────────────────────────────────────
export async function fetchOtxIOCs(): Promise<CyberThreat[]> {
  if (!isFeatureAvailable('alienvaultOtxThreatIntel')) return [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/otx-iocs`, { method: 'GET' });
    if (!res.ok) return [];
    return (await res.json()) as CyberThreat[];
  } catch {
    return [];
  }
}

// ── VirusTotal reputation lookup ────────────────────────────────────────────
export interface VtReputation {
  indicator: string;
  type: string;
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  reputation: number;
  lastAnalysisDate: number | null;
}

export async function lookupVtIndicator(
  indicator: string,
  type: 'ip' | 'domain' | 'url',
): Promise<VtReputation | null> {
  if (!isFeatureAvailable('virusTotalEnrichment')) return null;
  try {
    const params = new URLSearchParams({ indicator, type });
    const res = await fetch(`${getApiBaseUrl()}/api/virustotal-lookup?${params}`);
    if (!res.ok) return null;
    return (await res.json()) as VtReputation;
  } catch {
    return null;
  }
}
