import type { AisDisruptionEvent, AisDensityZone } from '@/types';

// WebSocket relay for live vessel tracking
// Dev: local relay (node scripts/ais-relay.cjs)
// Prod: Railway-hosted relay
const AISSTREAM_URL = import.meta.env.DEV
  ? 'ws://localhost:3004'
  : 'wss://worldmonitor-production.up.railway.app';

// Grid cell size for density aggregation (degrees)
const GRID_SIZE = 2;
// Time window for density calculation (ms)
const DENSITY_WINDOW = 30 * 60 * 1000; // 30 minutes
// Gap threshold for disruption detection (ms)
const GAP_THRESHOLD = 60 * 60 * 1000; // 1 hour without signal = potential dark ship

interface VesselPosition {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  timestamp: number;
  shipType?: number;
}

interface GridCell {
  lat: number;
  lon: number;
  vessels: Set<string>;
  lastUpdate: number;
  previousCount: number;
}

// In-memory vessel tracking
const vessels = new Map<string, VesselPosition>();
const densityGrid = new Map<string, GridCell>();
const vesselHistory = new Map<string, number[]>(); // MMSI -> last seen timestamps

let socket: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let apiKey: string | null = null;
let isConnected = false;
let messageCount = 0;

// Regions of interest for monitoring
const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 2 },
  { name: 'Suez Canal', lat: 30.0, lon: 32.5, radius: 1 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radius: 2 },
  { name: 'Bab el-Mandeb', lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: 'Panama Canal', lat: 9.0, lon: -79.5, radius: 1 },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 2 },
  { name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 5 },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, radius: 3 },
];

function getGridKey(lat: number, lon: number): string {
  const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
  const gridLon = Math.floor(lon / GRID_SIZE) * GRID_SIZE;
  return `${gridLat},${gridLon}`;
}

function processPositionReport(data: {
  MetaData: { MMSI: number; ShipName: string; latitude: number; longitude: number; time_utc: string };
  Message: { PositionReport?: { Latitude: number; Longitude: number } };
}): void {
  const meta = data.MetaData;
  const pos = data.Message.PositionReport;

  if (!meta || !pos) return;

  const mmsi = String(meta.MMSI);
  const lat = pos.Latitude ?? meta.latitude;
  const lon = pos.Longitude ?? meta.longitude;
  const now = Date.now();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  // Update vessel position
  vessels.set(mmsi, {
    mmsi,
    name: meta.ShipName || `Vessel ${mmsi}`,
    lat,
    lon,
    timestamp: now,
  });

  // Track vessel history for gap detection
  const history = vesselHistory.get(mmsi) || [];
  history.push(now);
  if (history.length > 10) history.shift();
  vesselHistory.set(mmsi, history);

  // Update density grid
  const gridKey = getGridKey(lat, lon);
  let cell = densityGrid.get(gridKey);
  if (!cell) {
    cell = {
      lat: Math.floor(lat / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      lon: Math.floor(lon / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      vessels: new Set(),
      lastUpdate: now,
      previousCount: 0,
    };
    densityGrid.set(gridKey, cell);
  }
  cell.vessels.add(mmsi);
  cell.lastUpdate = now;

  messageCount++;
}

function handleMessage(event: MessageEvent): void {
  try {
    const data = JSON.parse(event.data);

    if (data.MessageType === 'PositionReport') {
      processPositionReport(data);
      if (messageCount % 100 === 0) {
        console.log(`[Shipping] Received ${messageCount} position reports, tracking ${vessels.size} vessels`);
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
}

function connect(): void {
  if (!apiKey) {
    console.warn('[Shipping] No API key configured. Set VITE_AISSTREAM_API_KEY to enable live AIS data.');
    return;
  }

  if (socket?.readyState === WebSocket.OPEN) return;

  console.log('[Shipping] Opening WebSocket to:', AISSTREAM_URL);
  try {
    socket = new WebSocket(AISSTREAM_URL);
    console.log('[Shipping] WebSocket created, readyState:', socket.readyState);

    socket.onopen = () => {
      console.log('[Shipping] Connected to aisstream.io');
      isConnected = true;

      const subscription = {
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport'],
      };
      socket?.send(JSON.stringify(subscription));
      console.log('[Shipping] Subscribed to global vessel positions');
    };

    socket.onmessage = handleMessage;

    socket.onclose = (event) => {
      console.log('[Shipping] Disconnected:', event.code, event.reason || 'No reason');
      isConnected = false;
      scheduleReconnect();
    };

    socket.onerror = (error) => {
      console.error('[Shipping] WebSocket error:', error);
      isConnected = false;
    };

    // Check readyState after a short delay
    setTimeout(() => {
      if (socket) {
        const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
        console.log('[Shipping] WebSocket state after 3s:', states[socket.readyState]);
      }
    }, 3000);
  } catch (e) {
    console.error('[Shipping] Failed to connect:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeout) return;
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connect();
  }, 30000); // Reconnect after 30s
}

function cleanupOldData(): void {
  const now = Date.now();
  const cutoff = now - DENSITY_WINDOW;

  // Remove old vessel positions
  for (const [mmsi, vessel] of vessels) {
    if (vessel.timestamp < cutoff) {
      vessels.delete(mmsi);
    }
  }

  // Update grid cells
  for (const [key, cell] of densityGrid) {
    cell.previousCount = cell.vessels.size;

    // Remove vessels not seen recently from this cell
    for (const mmsi of cell.vessels) {
      const vessel = vessels.get(mmsi);
      if (!vessel || vessel.timestamp < cutoff) {
        cell.vessels.delete(mmsi);
      }
    }

    // Remove empty cells
    if (cell.vessels.size === 0 && now - cell.lastUpdate > DENSITY_WINDOW * 2) {
      densityGrid.delete(key);
    }
  }
}

function detectDisruptions(): AisDisruptionEvent[] {
  const disruptions: AisDisruptionEvent[] = [];
  const now = Date.now();

  // Check chokepoints for congestion
  for (const chokepoint of CHOKEPOINTS) {
    let vesselCount = 0;
    const nearbyVessels: string[] = [];

    for (const vessel of vessels.values()) {
      const distance = Math.sqrt(
        Math.pow(vessel.lat - chokepoint.lat, 2) +
        Math.pow(vessel.lon - chokepoint.lon, 2)
      );
      if (distance <= chokepoint.radius) {
        vesselCount++;
        nearbyVessels.push(vessel.mmsi);
      }
    }

    // Detect congestion (threshold varies by chokepoint)
    const baseThreshold = chokepoint.radius * 20;
    if (vesselCount > baseThreshold) {
      const severity = vesselCount > baseThreshold * 2 ? 'high' :
                       vesselCount > baseThreshold * 1.5 ? 'elevated' : 'low';

      disruptions.push({
        id: `chokepoint-${chokepoint.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: chokepoint.name,
        type: 'chokepoint_congestion',
        lat: chokepoint.lat,
        lon: chokepoint.lon,
        severity,
        changePct: Math.round((vesselCount / baseThreshold - 1) * 100),
        windowHours: 1,
        vesselCount,
        region: chokepoint.name,
        description: `${vesselCount} vessels detected in ${chokepoint.name} region`,
      });
    }
  }

  // Check for AIS gap spikes (dark ships)
  let darkShipCount = 0;
  for (const [, history] of vesselHistory) {
    if (history.length >= 2) {
      const lastSeen = history[history.length - 1]!;
      const secondLast = history[history.length - 2]!;

      // If there was a long gap and vessel just reappeared
      if (lastSeen - secondLast > GAP_THRESHOLD && now - lastSeen < 10 * 60 * 1000) {
        darkShipCount++;
      }
    }
  }

  if (darkShipCount > 5) {
    disruptions.push({
      id: 'global-gap-spike',
      name: 'AIS Gap Spike Detected',
      type: 'gap_spike',
      lat: 0,
      lon: 0,
      severity: darkShipCount > 20 ? 'high' : darkShipCount > 10 ? 'elevated' : 'low',
      changePct: darkShipCount * 10,
      windowHours: 1,
      darkShips: darkShipCount,
      description: `${darkShipCount} vessels returned after extended AIS silence`,
    });
  }

  return disruptions;
}

function calculateDensityZones(): AisDensityZone[] {
  const zones: AisDensityZone[] = [];
  const maxVessels = Math.max(1, ...Array.from(densityGrid.values()).map(c => c.vessels.size));

  for (const [key, cell] of densityGrid) {
    if (cell.vessels.size < 3) continue; // Skip sparse cells

    const intensity = cell.vessels.size / maxVessels;
    const deltaPct = cell.previousCount > 0
      ? Math.round(((cell.vessels.size - cell.previousCount) / cell.previousCount) * 100)
      : 0;

    zones.push({
      id: `density-${key}`,
      name: `Zone ${key}`,
      lat: cell.lat,
      lon: cell.lon,
      intensity,
      deltaPct,
      shipsPerDay: cell.vessels.size * 48, // Extrapolate from 30min window
      note: cell.vessels.size >= 10 ? 'High traffic area' : undefined,
    });
  }

  // Sort by intensity and return top zones
  return zones.sort((a, b) => b.intensity - a.intensity).slice(0, 50);
}

export function initAisStream(key?: string): void {
  console.log('[Shipping] Initializing AIS stream...');
  apiKey = key || import.meta.env.VITE_AISSTREAM_API_KEY || null;

  if (!apiKey) {
    console.warn('[Shipping] No API key provided. Get a free key at https://aisstream.io');
    return;
  }

  console.log('[Shipping] API key configured, connecting...');
  connect();

  // Cleanup old data periodically
  setInterval(cleanupOldData, 60 * 1000);
}

export function disconnectAisStream(): void {
  if (socket) {
    socket.close();
    socket = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  isConnected = false;
}

export function getAisStatus(): { connected: boolean; vessels: number; messages: number } {
  return {
    connected: isConnected,
    vessels: vessels.size,
    messages: messageCount,
  };
}

export async function fetchAisSignals(): Promise<{ disruptions: AisDisruptionEvent[]; density: AisDensityZone[] }> {
  // Initialize stream if not already running
  if (!socket && apiKey) {
    connect();
  }

  // Return aggregated data from in-memory tracking
  cleanupOldData();

  return {
    disruptions: detectDisruptions(),
    density: calculateDensityZones(),
  };
}
