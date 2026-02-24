/**
 * GATRA SOC Mock Data Connector
 *
 * Provides mock data simulating GATRA's 5-agent pipeline:
 *   ADA  - Anomaly Detection Agent
 *   TAA  - Triage & Analysis Agent
 *   CRA  - Containment & Response Agent
 *   CLA  - Continuous Learning Agent
 *   RVA  - Reporting & Visualization Agent
 *
 * Mock data uses realistic Indonesian locations and IOH infrastructure refs.
 * Data is stable within 5-minute time buckets and regenerated with slight
 * randomization per call. Will be replaced by real GATRA API feeds via Pub/Sub.
 */

import type {
  GatraAlert,
  GatraAgentStatus,
  GatraIncidentSummary,
  GatraCRAAction,
  GatraAlertSeverity,
  GatraAgentName,
  GatraAgentStatusType,
  GatraTAAAnalysis,
  GatraCorrelation,
  KillChainPhase,
} from '@/types';

// ── Deterministic seed from 5-min time buckets ────────────────────────
function timeBucketSeed(): number {
  return Math.floor(Date.now() / (5 * 60 * 1000));
}

/** Simple seeded PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Reference data ────────────────────────────────────────────────────

interface Location {
  name: string;
  lat: number;
  lon: number;
}

const LOCATIONS: Location[] = [
  { name: 'Jakarta', lat: -6.2088, lon: 106.8456 },
  { name: 'Surabaya', lat: -7.2575, lon: 112.7521 },
  { name: 'Bandung', lat: -6.9175, lon: 107.6191 },
  { name: 'Medan', lat: 3.5952, lon: 98.6722 },
  { name: 'Makassar', lat: -5.1477, lon: 119.4327 },
];

const MITRE_TECHNIQUES: Array<{ id: string; name: string }> = [
  { id: 'T1566', name: 'Phishing' },
  { id: 'T1190', name: 'Exploit Public-Facing Application' },
  { id: 'T1078', name: 'Valid Accounts' },
  { id: 'T1021', name: 'Remote Services' },
  { id: 'T1059', name: 'Command and Scripting Interpreter' },
  { id: 'T1486', name: 'Data Encrypted for Impact' },
];

const IOH_INFRA: string[] = [
  'IOH-CORE-JKT-01',
  'IOH-EDGE-SBY-03',
  'IOH-GW-BDG-02',
  'IOH-DNS-MDN-01',
  'IOH-CDN-MKS-04',
  'IOH-MPLS-JKT-02',
  'IOH-RADIUS-SBY-01',
  'IOH-FW-JKT-05',
  'IOH-LB-BDG-03',
  'IOH-VPN-MDN-02',
];

const ALERT_DESCRIPTIONS: string[] = [
  'Suspicious inbound connection from known C2 infrastructure',
  'Brute-force attempt on edge authentication gateway',
  'Anomalous lateral movement detected in core network segment',
  'Credential stuffing against customer portal',
  'Encrypted payload upload to staging server',
  'DNS tunneling activity on recursive resolver',
  'Unauthorized privilege escalation on RADIUS server',
  'Port scan targeting management VLAN',
  'Malicious PowerShell execution via remote service',
  'Data exfiltration attempt over HTTPS to external IP',
  'Spear-phishing campaign targeting NOC operators',
  'Abnormal API call volume on load balancer endpoint',
  'Ransomware pre-cursor activity on file server',
  'VPN session hijack attempt detected',
  'Rogue DHCP server detected on edge segment',
];

const CRA_ACTIONS: Array<{ text: string; type: GatraCRAAction['actionType'] }> = [
  { text: 'Blocked IP 45.33.xx.xx at perimeter firewall', type: 'ip_blocked' },
  { text: 'Isolated host IOH-WS-042 from network', type: 'endpoint_isolated' },
  { text: 'Revoked compromised service account creds', type: 'credential_rotated' },
  { text: 'Enabled enhanced logging on MPLS segment', type: 'playbook_triggered' },
  { text: 'Triggered SOAR playbook: credential-reset', type: 'playbook_triggered' },
  { text: 'Quarantined malicious attachment in sandbox', type: 'endpoint_isolated' },
  { text: 'Rate-limited API endpoint /auth/token', type: 'rate_limited' },
  { text: 'Pushed emergency WAF rule for CVE-2024-3094', type: 'rule_pushed' },
];

const THREAT_ACTORS: string[] = [
  'APT-41 (Winnti)',
  'Lazarus Group',
  'Mustang Panda',
  'OceanLotus (APT-32)',
  'Naikon APT',
  'SideWinder',
  'Turla Group',
  'Unknown / Unattributed',
];

const CAMPAIGNS: string[] = [
  'Operation ShadowNet',
  'Campaign CobaltStrike-SEA',
  'Project DarkTide',
  'Operation MalayBridge',
  'Campaign TelekomTarget',
  'Operation PacificRim',
  'Campaign IndonesiaHarvest',
  'Opportunistic Scanning',
];

const KILL_CHAIN_PHASES: KillChainPhase[] = [
  'reconnaissance', 'weaponization', 'delivery',
  'exploitation', 'installation', 'c2', 'actions',
];

const AGENTS: GatraAgentName[] = ['ADA', 'TAA', 'CRA', 'CLA', 'RVA'];

// ── Public API ────────────────────────────────────────────────────────

export async function fetchGatraAlerts(): Promise<GatraAlert[]> {
  const rng = mulberry32(timeBucketSeed());
  const count = 15 + Math.floor(rng() * 11); // 15-25
  const now = Date.now();
  const alerts: GatraAlert[] = [];

  for (let i = 0; i < count; i++) {
    const loc = LOCATIONS[Math.floor(rng() * LOCATIONS.length)]!;
    const technique = MITRE_TECHNIQUES[Math.floor(rng() * MITRE_TECHNIQUES.length)]!;
    const sevIdx = rng();
    const severity: GatraAlertSeverity =
      sevIdx < 0.15 ? 'critical' : sevIdx < 0.40 ? 'high' : sevIdx < 0.75 ? 'medium' : 'low';
    const confidence = Math.round((0.55 + rng() * 0.44) * 100); // 55-99%

    alerts.push({
      id: `gatra-${timeBucketSeed()}-${i}`,
      severity,
      mitreId: technique.id,
      mitreName: technique.name,
      description: ALERT_DESCRIPTIONS[Math.floor(rng() * ALERT_DESCRIPTIONS.length)] ?? 'Anomalous activity detected',
      confidence,
      lat: loc.lat + (rng() - 0.5) * 0.1,
      lon: loc.lon + (rng() - 0.5) * 0.1,
      locationName: loc.name,
      infrastructure: IOH_INFRA[Math.floor(rng() * IOH_INFRA.length)] ?? 'IOH-UNKNOWN',
      timestamp: new Date(now - Math.floor(rng() * 24 * 60 * 60 * 1000)),
      agent: AGENTS[Math.floor(rng() * AGENTS.length)] ?? 'ADA',
    });
  }

  // Sort by timestamp desc
  alerts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return alerts;
}

export async function fetchGatraAgentStatus(): Promise<GatraAgentStatus[]> {
  const rng = mulberry32(timeBucketSeed() + 1);
  const now = new Date();

  const fullNames: Record<GatraAgentName, string> = {
    ADA: 'Anomaly Detection Agent',
    TAA: 'Triage & Analysis Agent',
    CRA: 'Containment & Response Agent',
    CLA: 'Continuous Learning Agent',
    RVA: 'Reporting & Visualization Agent',
  };

  return AGENTS.map((name) => {
    const roll = rng();
    const status: GatraAgentStatusType =
      roll < 0.7 ? 'online' : roll < 0.9 ? 'processing' : 'degraded';
    return {
      name,
      fullName: fullNames[name],
      status,
      lastHeartbeat: new Date(now.getTime() - Math.floor(rng() * 120_000)),
    };
  });
}

export async function fetchGatraIncidentSummary(): Promise<GatraIncidentSummary> {
  const rng = mulberry32(timeBucketSeed() + 2);
  return {
    activeIncidents: 2 + Math.floor(rng() * 6),
    mttrMinutes: 8 + Math.floor(rng() * 25),
    alerts24h: 40 + Math.floor(rng() * 80),
    responses24h: 12 + Math.floor(rng() * 30),
  };
}

export async function fetchGatraCRAActions(): Promise<GatraCRAAction[]> {
  const rng = mulberry32(timeBucketSeed() + 3);
  const now = Date.now();
  const count = 4 + Math.floor(rng() * 5); // 4-8
  const actions: GatraCRAAction[] = [];

  for (let i = 0; i < count; i++) {
    const entry = CRA_ACTIONS[Math.floor(rng() * CRA_ACTIONS.length)]!;
    actions.push({
      id: `cra-${timeBucketSeed()}-${i}`,
      action: entry.text,
      actionType: entry.type,
      target: IOH_INFRA[Math.floor(rng() * IOH_INFRA.length)] ?? 'IOH-UNKNOWN',
      timestamp: new Date(now - Math.floor(rng() * 12 * 60 * 60 * 1000)),
      success: rng() > 0.1,
    });
  }

  actions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return actions;
}

export async function fetchGatraTAAAnalyses(alerts: GatraAlert[]): Promise<GatraTAAAnalysis[]> {
  const rng = mulberry32(timeBucketSeed() + 4);
  const analysable = alerts.filter(a => a.severity === 'critical' || a.severity === 'high');
  const count = Math.min(analysable.length, 5 + Math.floor(rng() * 4));

  return analysable.slice(0, count).map((alert, i) => ({
    id: `taa-${timeBucketSeed()}-${i}`,
    alertId: alert.id,
    actorAttribution: THREAT_ACTORS[Math.floor(rng() * THREAT_ACTORS.length)] ?? 'Unknown',
    campaign: CAMPAIGNS[Math.floor(rng() * CAMPAIGNS.length)] ?? 'Unknown Campaign',
    killChainPhase: KILL_CHAIN_PHASES[Math.floor(rng() * KILL_CHAIN_PHASES.length)] ?? 'reconnaissance',
    confidence: Math.round((0.4 + rng() * 0.55) * 100),
    iocs: [
      `${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`,
      `sha256:${Array.from({ length: 8 }, () => Math.floor(rng() * 16).toString(16)).join('')}...`,
    ],
    timestamp: new Date(alert.timestamp.getTime() + Math.floor(rng() * 300_000)),
  }));
}

export async function fetchGatraCorrelations(alerts: GatraAlert[]): Promise<GatraCorrelation[]> {
  const rng = mulberry32(timeBucketSeed() + 5);
  const locationAlertMap = new Map<string, GatraAlert[]>();
  for (const a of alerts) {
    const list = locationAlertMap.get(a.locationName) || [];
    list.push(a);
    locationAlertMap.set(a.locationName, list);
  }

  const correlations: GatraCorrelation[] = [];
  const templates: Array<{ type: GatraCorrelation['worldMonitorEventType']; template: (loc: string, count: number) => string }> = [
    { type: 'cii_spike', template: (loc, count) => `CII spike in ${loc} region correlates with ${count} new anomalies detected by ADA on IOH infrastructure` },
    { type: 'apt_activity', template: (loc, count) => `Elevated APT scanning activity near ${loc} NOC aligns with ${count} GATRA alerts — nation-state campaign suspected` },
    { type: 'geopolitical', template: (loc, count) => `Regional geopolitical tensions around ${loc} preceded ${count} brute-force attempts on edge gateways` },
    { type: 'cyber_threat', template: (loc, count) => `WorldMonitor threat intel layer shows C2 infrastructure overlap with ${count} GATRA detections in ${loc}` },
  ];

  let idx = 0;
  for (const [loc, locAlerts] of locationAlertMap) {
    if (rng() < 0.4 || idx >= 4 || locAlerts.length === 0) continue;
    const tmpl = templates[Math.floor(rng() * templates.length)]!;
    const alertIds = locAlerts.slice(0, 3).map(a => a.id);
    correlations.push({
      id: `corr-${timeBucketSeed()}-${idx}`,
      gatraAlertIds: alertIds,
      worldMonitorEventType: tmpl.type,
      region: loc,
      summary: tmpl.template(loc, locAlerts.length),
      severity: locAlerts[0]!.severity,
      timestamp: new Date(),
    });
    idx++;
  }

  return correlations;
}
