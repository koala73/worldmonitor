import type { RuntimeSecretKey, RuntimeFeatureId } from './runtime-config';

export const SIGNUP_URLS: Partial<Record<RuntimeSecretKey, string>> = {
  GROQ_API_KEY: 'https://console.groq.com/keys',
  OPENROUTER_API_KEY: 'https://openrouter.ai/settings/keys',
  FRED_API_KEY: 'https://fred.stlouisfed.org/docs/api/api_key.html',
  EIA_API_KEY: 'https://www.eia.gov/opendata/register.php',
  CLOUDFLARE_API_TOKEN: 'https://dash.cloudflare.com/profile/api-tokens',
  ACLED_ACCESS_TOKEN: 'https://developer.acleddata.com/',
  URLHAUS_AUTH_KEY: 'https://auth.abuse.ch/',
  OTX_API_KEY: 'https://otx.alienvault.com/',
  ABUSEIPDB_API_KEY: 'https://www.abuseipdb.com/login',
  WINGBITS_API_KEY: 'https://wingbits.com/register',
  AISSTREAM_API_KEY: 'https://aisstream.io/authenticate',
  OPENSKY_CLIENT_ID: 'https://opensky-network.org/login?view=registration',
  OPENSKY_CLIENT_SECRET: 'https://opensky-network.org/login?view=registration',
  FINNHUB_API_KEY: 'https://finnhub.io/register',
  NASA_FIRMS_API_KEY: 'https://firms.modaps.eosdis.nasa.gov/api/area/',
  UC_DP_KEY: 'https://ucdp.uu.se/downloads/',
  OLLAMA_API_URL: 'https://ollama.com/download',
  OLLAMA_MODEL: 'https://ollama.com/library',
  WTO_API_KEY: 'https://apiportal.wto.org/',
  AVIATIONSTACK_API: 'https://aviationstack.com/signup/free',
};

export const PLAINTEXT_KEYS = new Set<RuntimeSecretKey>([
  'OLLAMA_API_URL',
  'OLLAMA_MODEL',
  'WS_RELAY_URL',
  'VITE_OPENSKY_RELAY_URL',
]);

export const MASKED_SENTINEL = '__WM_MASKED__';

export const HUMAN_LABELS: Record<RuntimeSecretKey, string> = {
  GROQ_API_KEY: 'Groq API Key',
  OPENROUTER_API_KEY: 'OpenRouter API Key',
  FRED_API_KEY: 'FRED API Key',
  EIA_API_KEY: 'EIA API Key',
  CLOUDFLARE_API_TOKEN: 'Cloudflare API Token',
  ACLED_ACCESS_TOKEN: 'ACLED Access Token',
  URLHAUS_AUTH_KEY: 'URLhaus Auth Key',
  OTX_API_KEY: 'AlienVault OTX Key',
  ABUSEIPDB_API_KEY: 'AbuseIPDB API Key',
  WINGBITS_API_KEY: 'Wingbits API Key',
  WS_RELAY_URL: 'WebSocket Relay URL',
  VITE_OPENSKY_RELAY_URL: 'OpenSky Relay URL',
  OPENSKY_CLIENT_ID: 'OpenSky Client ID',
  OPENSKY_CLIENT_SECRET: 'OpenSky Client Secret',
  AISSTREAM_API_KEY: 'AISStream API Key',
  FINNHUB_API_KEY: 'Finnhub API Key',
  NASA_FIRMS_API_KEY: 'NASA FIRMS API Key',
  UC_DP_KEY: 'UCDP API Key',
  OLLAMA_API_URL: 'Ollama Server URL',
  OLLAMA_MODEL: 'Ollama Model',
  WORLDMONITOR_API_KEY: 'World Monitor License Key',
  WTO_API_KEY: 'WTO API Key',
  AVIATIONSTACK_API: 'AviationStack API Key',
};

export interface SettingsCategory {
  id: string;
  label: string;
  features: RuntimeFeatureId[];
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'ai',
    label: 'AI & Summarization',
    features: ['aiOllama', 'aiGroq', 'aiOpenRouter'],
  },
  {
    id: 'economy',
    label: 'Economic & Energy',
    features: ['economicFred', 'energyEia', 'supplyChain'],
  },
  {
    id: 'markets',
    label: 'Markets & Trade',
    features: ['finnhubMarkets', 'wtoTrade'],
  },
  {
    id: 'security',
    label: 'Security & Threats',
    features: ['internetOutages', 'acledConflicts', 'abuseChThreatIntel', 'alienvaultOtxThreatIntel', 'abuseIpdbThreatIntel'],
  },
  {
    id: 'tracking',
    label: 'Tracking & Sensing',
    features: ['aisRelay', 'openskyRelay', 'wingbitsEnrichment', 'nasaFirms', 'aviationStack'],
  },
];
