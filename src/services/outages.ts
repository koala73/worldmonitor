import type { InternetOutage } from '@/types';
import { createCircuitBreaker, fetchWithCache } from '@/utils';
import { isFeatureAvailable } from './runtime-config';

const CLOUDFLARE_API_URL = '/api/cloudflare-outages';
const breaker = createCircuitBreaker<InternetOutage[]>({ name: 'Cloudflare Outages' });

const COUNTRY_COORDS: Record<string, { lat: number; lon: number }> = {
  'AF': { lat: 33.9391, lon: 67.7100 },
  'AL': { lat: 41.1533, lon: 20.1683 },
  'DZ': { lat: 28.0339, lon: 1.6596 },
  'AO': { lat: -11.2027, lon: 17.8739 },
  'AR': { lat: -38.4161, lon: -63.6167 },
  'AM': { lat: 40.0691, lon: 45.0382 },
  'AU': { lat: -25.2744, lon: 133.7751 },
  'AT': { lat: 47.5162, lon: 14.5501 },
  'AZ': { lat: 40.1431, lon: 47.5769 },
  'BH': { lat: 26.0667, lon: 50.5577 },
  'BD': { lat: 23.685, lon: 90.3563 },
  'BY': { lat: 53.7098, lon: 27.9534 },
  'BE': { lat: 50.5039, lon: 4.4699 },
  'BJ': { lat: 9.3077, lon: 2.3158 },
  'BO': { lat: -16.2902, lon: -63.5887 },
  'BA': { lat: 43.9159, lon: 17.6791 },
  'BW': { lat: -22.3285, lon: 24.6849 },
  'BR': { lat: -14.235, lon: -51.9253 },
  'BG': { lat: 42.7339, lon: 25.4858 },
  'BF': { lat: 12.2383, lon: -1.5616 },
  'BI': { lat: -3.3731, lon: 29.9189 },
  'KH': { lat: 12.5657, lon: 104.991 },
  'CM': { lat: 7.3697, lon: 12.3547 },
  'CA': { lat: 56.1304, lon: -106.3468 },
  'CF': { lat: 6.6111, lon: 20.9394 },
  'TD': { lat: 15.4542, lon: 18.7322 },
  'CL': { lat: -35.6751, lon: -71.543 },
  'CN': { lat: 35.8617, lon: 104.1954 },
  'CO': { lat: 4.5709, lon: -74.2973 },
  'CG': { lat: -0.228, lon: 15.8277 },
  'CD': { lat: -4.0383, lon: 21.7587 },
  'CR': { lat: 9.7489, lon: -83.7534 },
  'HR': { lat: 45.1, lon: 15.2 },
  'CU': { lat: 21.5218, lon: -77.7812 },
  'CY': { lat: 35.1264, lon: 33.4299 },
  'CZ': { lat: 49.8175, lon: 15.473 },
  'DK': { lat: 56.2639, lon: 9.5018 },
  'DJ': { lat: 11.8251, lon: 42.5903 },
  'EC': { lat: -1.8312, lon: -78.1834 },
  'EG': { lat: 26.8206, lon: 30.8025 },
  'SV': { lat: 13.7942, lon: -88.8965 },
  'ER': { lat: 15.1794, lon: 39.7823 },
  'EE': { lat: 58.5953, lon: 25.0136 },
  'ET': { lat: 9.145, lon: 40.4897 },
  'FI': { lat: 61.9241, lon: 25.7482 },
  'FR': { lat: 46.2276, lon: 2.2137 },
  'GA': { lat: -0.8037, lon: 11.6094 },
  'GM': { lat: 13.4432, lon: -15.3101 },
  'GE': { lat: 42.3154, lon: 43.3569 },
  'DE': { lat: 51.1657, lon: 10.4515 },
  'GH': { lat: 7.9465, lon: -1.0232 },
  'GR': { lat: 39.0742, lon: 21.8243 },
  'GT': { lat: 15.7835, lon: -90.2308 },
  'GN': { lat: 9.9456, lon: -9.6966 },
  'HT': { lat: 18.9712, lon: -72.2852 },
  'HN': { lat: 15.2, lon: -86.2419 },
  'HK': { lat: 22.3193, lon: 114.1694 },
  'HU': { lat: 47.1625, lon: 19.5033 },
  'IN': { lat: 20.5937, lon: 78.9629 },
  'ID': { lat: -0.7893, lon: 113.9213 },
  'IR': { lat: 32.4279, lon: 53.688 },
  'IQ': { lat: 33.2232, lon: 43.6793 },
  'IE': { lat: 53.1424, lon: -7.6921 },
  'IL': { lat: 31.0461, lon: 34.8516 },
  'IT': { lat: 41.8719, lon: 12.5674 },
  'CI': { lat: 7.54, lon: -5.5471 },
  'JP': { lat: 36.2048, lon: 138.2529 },
  'JO': { lat: 30.5852, lon: 36.2384 },
  'KZ': { lat: 48.0196, lon: 66.9237 },
  'KE': { lat: -0.0236, lon: 37.9062 },
  'KW': { lat: 29.3117, lon: 47.4818 },
  'KG': { lat: 41.2044, lon: 74.7661 },
  'LA': { lat: 19.8563, lon: 102.4955 },
  'LV': { lat: 56.8796, lon: 24.6032 },
  'LB': { lat: 33.8547, lon: 35.8623 },
  'LY': { lat: 26.3351, lon: 17.2283 },
  'LT': { lat: 55.1694, lon: 23.8813 },
  'LU': { lat: 49.8153, lon: 6.1296 },
  'MG': { lat: -18.7669, lon: 46.8691 },
  'MW': { lat: -13.2543, lon: 34.3015 },
  'MY': { lat: 4.2105, lon: 101.9758 },
  'ML': { lat: 17.5707, lon: -3.9962 },
  'MR': { lat: 21.0079, lon: -10.9408 },
  'MX': { lat: 23.6345, lon: -102.5528 },
  'MD': { lat: 47.4116, lon: 28.3699 },
  'MN': { lat: 46.8625, lon: 103.8467 },
  'MA': { lat: 31.7917, lon: -7.0926 },
  'MZ': { lat: -18.6657, lon: 35.5296 },
  'MM': { lat: 21.9162, lon: 95.956 },
  'NA': { lat: -22.9576, lon: 18.4904 },
  'NP': { lat: 28.3949, lon: 84.124 },
  'NL': { lat: 52.1326, lon: 5.2913 },
  'NZ': { lat: -40.9006, lon: 174.886 },
  'NI': { lat: 12.8654, lon: -85.2072 },
  'NE': { lat: 17.6078, lon: 8.0817 },
  'NG': { lat: 9.082, lon: 8.6753 },
  'KP': { lat: 40.3399, lon: 127.5101 },
  'NO': { lat: 60.472, lon: 8.4689 },
  'OM': { lat: 21.4735, lon: 55.9754 },
  'PK': { lat: 30.3753, lon: 69.3451 },
  'PS': { lat: 31.9522, lon: 35.2332 },
  'PA': { lat: 8.538, lon: -80.7821 },
  'PG': { lat: -6.315, lon: 143.9555 },
  'PY': { lat: -23.4425, lon: -58.4438 },
  'PE': { lat: -9.19, lon: -75.0152 },
  'PH': { lat: 12.8797, lon: 121.774 },
  'PL': { lat: 51.9194, lon: 19.1451 },
  'PT': { lat: 39.3999, lon: -8.2245 },
  'QA': { lat: 25.3548, lon: 51.1839 },
  'RO': { lat: 45.9432, lon: 24.9668 },
  'RU': { lat: 61.524, lon: 105.3188 },
  'RW': { lat: -1.9403, lon: 29.8739 },
  'SA': { lat: 23.8859, lon: 45.0792 },
  'SN': { lat: 14.4974, lon: -14.4524 },
  'RS': { lat: 44.0165, lon: 21.0059 },
  'SL': { lat: 8.4606, lon: -11.7799 },
  'SG': { lat: 1.3521, lon: 103.8198 },
  'SK': { lat: 48.669, lon: 19.699 },
  'SI': { lat: 46.1512, lon: 14.9955 },
  'SO': { lat: 5.1521, lon: 46.1996 },
  'ZA': { lat: -30.5595, lon: 22.9375 },
  'KR': { lat: 35.9078, lon: 127.7669 },
  'SS': { lat: 6.877, lon: 31.307 },
  'ES': { lat: 40.4637, lon: -3.7492 },
  'LK': { lat: 7.8731, lon: 80.7718 },
  'SD': { lat: 12.8628, lon: 30.2176 },
  'SE': { lat: 60.1282, lon: 18.6435 },
  'CH': { lat: 46.8182, lon: 8.2275 },
  'SY': { lat: 34.8021, lon: 38.9968 },
  'TW': { lat: 23.6978, lon: 120.9605 },
  'TJ': { lat: 38.861, lon: 71.2761 },
  'TZ': { lat: -6.369, lon: 34.8888 },
  'TH': { lat: 15.87, lon: 100.9925 },
  'TG': { lat: 8.6195, lon: 0.8248 },
  'TT': { lat: 10.6918, lon: -61.2225 },
  'TN': { lat: 33.8869, lon: 9.5375 },
  'TR': { lat: 38.9637, lon: 35.2433 },
  'TM': { lat: 38.9697, lon: 59.5563 },
  'UG': { lat: 1.3733, lon: 32.2903 },
  'UA': { lat: 48.3794, lon: 31.1656 },
  'AE': { lat: 23.4241, lon: 53.8478 },
  'GB': { lat: 55.3781, lon: -3.436 },
  'US': { lat: 37.0902, lon: -95.7129 },
  'UY': { lat: -32.5228, lon: -55.7658 },
  'UZ': { lat: 41.3775, lon: 64.5853 },
  'VE': { lat: 6.4238, lon: -66.5897 },
  'VN': { lat: 14.0583, lon: 108.2772 },
  'YE': { lat: 15.5527, lon: 48.5164 },
  'ZM': { lat: -13.1339, lon: 27.8493 },
  'ZW': { lat: -19.0154, lon: 29.1549 },
};

interface CloudflareOutage {
  id: string;
  dataSource: string;
  description: string;
  scope: string | null;
  startDate: string;
  endDate: string | null;
  locations: string[];
  asns: number[];
  eventType: string;
  linkedUrl: string;
  locationsDetails: Array<{ name: string; code: string }>;
  asnsDetails: Array<{ asn: string; name: string; location: { code: string; name: string } }>;
  outage: {
    outageCause: string;
    outageType: string;
  };
}

interface CloudflareResponse {
  configured?: boolean;
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    annotations: CloudflareOutage[];
  };
}

let outagesConfigured: boolean | null = null;

export function isOutagesConfigured(): boolean | null {
  return outagesConfigured;
}

export async function fetchInternetOutages(): Promise<InternetOutage[]> {
  if (!isFeatureAvailable('internetOutages')) {
    outagesConfigured = false;
    return [];
  }

  return breaker.execute(async () => {
    const data = await fetchWithCache<CloudflareResponse>(`${CLOUDFLARE_API_URL}?dateRange=7d&limit=50`, { ttl: 120_000 });

    if (data.configured === false) {
      outagesConfigured = false;
      throw new Error('Outages API not configured');
    }

    outagesConfigured = true;

    if (!data.success || data.errors?.length) {
      throw new Error(data.errors?.[0]?.message || 'API error');
    }

    const outages: InternetOutage[] = [];

    for (const outage of data.result?.annotations || []) {
      if (!outage.locations?.length) continue;

      const countryCode = outage.locations[0];
      if (!countryCode) continue;

      const coords = COUNTRY_COORDS[countryCode];
      if (!coords) continue;

      const countryName = outage.locationsDetails?.[0]?.name ?? countryCode;

      let severity: 'partial' | 'major' | 'total' = 'partial';
      if (outage.outage?.outageType === 'NATIONWIDE') severity = 'total';
      else if (outage.outage?.outageType === 'REGIONAL') severity = 'major';

      const categories: string[] = ['Cloudflare Radar'];
      if (outage.outage?.outageCause) categories.push(outage.outage.outageCause.replace(/_/g, ' '));
      if (outage.outage?.outageType) categories.push(outage.outage.outageType);

      for (const asn of outage.asnsDetails?.slice(0, 2) || []) {
        if (asn.name) categories.push(asn.name);
      }

      outages.push({
        id: `cf-${outage.id}`,
        title: outage.scope ? `${outage.scope} outage in ${countryName}` : `Internet disruption in ${countryName}`,
        link: outage.linkedUrl || `https://radar.cloudflare.com/outage-center`,
        description: outage.description,
        pubDate: new Date(outage.startDate),
        country: countryName,
        lat: coords.lat,
        lon: coords.lon,
        severity,
        categories,
        cause: outage.outage?.outageCause,
        outageType: outage.outage?.outageType,
        endDate: outage.endDate ? new Date(outage.endDate) : undefined,
      });
    }

    return outages;
  }, []);
}

export function getOutagesStatus(): string {
  return breaker.getStatus();
}
