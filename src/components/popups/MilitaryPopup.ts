import type { MilitaryBase, StrategicWaterway, MilitaryFlight, MilitaryVessel, MilitaryFlightCluster, MilitaryVesselCluster } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export function renderBasePopup(base: MilitaryBase): string {
  const typeLabels: Record<string, string> = {
    'us-nato': t('popups.base.types.us-nato'),
    'china': t('popups.base.types.china'),
    'russia': t('popups.base.types.russia'),
  };
  const typeColors: Record<string, string> = {
    'us-nato': 'elevated',
    'china': 'high',
    'russia': 'high',
  };

  return `
    <div class="popup-header base">
      <span class="popup-title">${base.name.toUpperCase()}</span>
      <span class="popup-badge ${typeColors[base.type] || 'low'}">${typeLabels[base.type] || base.type.toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      ${base.description ? `<p class="popup-description">${base.description}</p>` : ''}
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${typeLabels[base.type] || base.type}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${base.lat.toFixed(2)}°, ${base.lon.toFixed(2)}°</span>
        </div>
      </div>
    </div>
  `;
}

export function renderWaterwayPopup(waterway: StrategicWaterway): string {
  return `
    <div class="popup-header waterway">
      <span class="popup-title">${waterway.name}</span>
      <span class="popup-badge elevated">${t('popups.strategic')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      ${waterway.description ? `<p class="popup-description">${waterway.description}</p>` : ''}
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${waterway.lat.toFixed(2)}°, ${waterway.lon.toFixed(2)}°</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMilitaryFlightPopup(flight: MilitaryFlight): string {
  const operatorLabels: Record<string, string> = {
    usaf: 'US Air Force',
    usn: 'US Navy',
    usmc: 'US Marines',
    usa: 'US Army',
    raf: 'Royal Air Force',
    rn: 'Royal Navy',
    faf: 'French Air Force',
    gaf: 'German Air Force',
    plaaf: 'PLA Air Force',
    plan: 'PLA Navy',
    vks: 'Russian Aerospace',
    iaf: 'Israeli Air Force',
    nato: 'NATO',
    other: t('popups.unknown'),
  };
  const typeLabels: Record<string, string> = {
    fighter: t('popups.militaryFlight.types.fighter'),
    bomber: t('popups.militaryFlight.types.bomber'),
    transport: t('popups.militaryFlight.types.transport'),
    tanker: t('popups.militaryFlight.types.tanker'),
    awacs: t('popups.militaryFlight.types.awacs'),
    reconnaissance: t('popups.militaryFlight.types.reconnaissance'),
    helicopter: t('popups.militaryFlight.types.helicopter'),
    drone: t('popups.militaryFlight.types.drone'),
    patrol: t('popups.militaryFlight.types.patrol'),
    special_ops: t('popups.militaryFlight.types.specialOps'),
    vip: t('popups.militaryFlight.types.vip'),
    unknown: t('popups.unknown'),
  };
  const confidenceColors: Record<string, string> = {
    high: 'elevated',
    medium: 'low',
    low: 'low',
  };
  const callsign = escapeHtml(flight.callsign || t('popups.unknown'));
  const aircraftTypeBadge = escapeHtml(flight.aircraftType.toUpperCase());
  const operatorLabel = escapeHtml(operatorLabels[flight.operator] || flight.operatorCountry || t('popups.unknown'));
  const hexCode = escapeHtml(flight.hexCode || '');
  const aircraftType = escapeHtml(typeLabels[flight.aircraftType] || flight.aircraftType);
  const squawk = flight.squawk ? escapeHtml(flight.squawk) : '';
  const note = flight.note ? escapeHtml(flight.note) : '';

  return `
    <div class="popup-header military-flight ${flight.operator}">
      <span class="popup-title">${callsign}</span>
      <span class="popup-badge ${confidenceColors[flight.confidence] || 'low'}">${aircraftTypeBadge}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${operatorLabel}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryFlight.altitude')}</span>
          <span class="stat-value">${flight.altitude > 0 ? `FL${Math.round(flight.altitude / 100)}` : t('popups.militaryFlight.ground')}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryFlight.speed')}</span>
          <span class="stat-value">${flight.speed} kts</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryFlight.heading')}</span>
          <span class="stat-value">${Math.round(flight.heading)}°</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryFlight.hexCode')}</span>
          <span class="stat-value">${hexCode}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${aircraftType}</span>
        </div>
        ${flight.squawk ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryFlight.squawk')}</span>
          <span class="stat-value">${squawk}</span>
        </div>
        ` : ''}
      </div>
      ${flight.note ? `<p class="popup-description">${note}</p>` : ''}
      <div class="popup-attribution">${t('popups.militaryFlight.attribution')}</div>
    </div>
  `;
}

export function renderMilitaryVesselPopup(vessel: MilitaryVessel): string {
  const operatorLabels: Record<string, string> = {
    usn: 'US Navy',
    uscg: 'US Coast Guard',
    rn: 'Royal Navy',
    fn: 'French Navy',
    plan: 'PLA Navy',
    ruf: 'Russian Navy',
    jmsdf: 'Japan Maritime SDF',
    rokn: 'ROK Navy',
    other: t('popups.unknown'),
  };
  const typeLabels: Record<string, string> = {
    carrier: 'Aircraft Carrier',
    destroyer: 'Destroyer',
    frigate: 'Frigate',
    submarine: 'Submarine',
    amphibious: 'Amphibious',
    patrol: 'Patrol',
    auxiliary: 'Auxiliary',
    research: 'Research',
    icebreaker: 'Icebreaker',
    special: 'Special',
    unknown: t('popups.unknown'),
  };

  const darkWarning = vessel.isDark
    ? `<span class="popup-badge high">${t('popups.militaryVessel.aisDark')}</span>`
    : '';

  // Show AIS ship type when military type is unknown
  const displayType = vessel.vesselType === 'unknown' && vessel.aisShipType
    ? vessel.aisShipType
    : (typeLabels[vessel.vesselType] || vessel.vesselType);
  const badgeType = vessel.vesselType === 'unknown' && vessel.aisShipType
    ? vessel.aisShipType.toUpperCase()
    : vessel.vesselType.toUpperCase();
  const vesselName = escapeHtml(vessel.name || `${t('popups.militaryVessel.vessel')} ${vessel.mmsi}`);
  const vesselOperator = escapeHtml(operatorLabels[vessel.operator] || vessel.operatorCountry || t('popups.unknown'));
  const vesselTypeLabel = escapeHtml(displayType);
  const vesselBadgeType = escapeHtml(badgeType);
  const vesselMmsi = escapeHtml(vessel.mmsi);
  const vesselHull = vessel.hullNumber ? escapeHtml(vessel.hullNumber) : '';
  const vesselNote = vessel.note ? escapeHtml(vessel.note) : '';

  return `
    <div class="popup-header military-vessel ${vessel.operator}">
      <span class="popup-title">${vesselName}</span>
      ${darkWarning}
      <span class="popup-badge elevated">${vesselBadgeType}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${vesselOperator}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${vesselTypeLabel}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryVessel.speed')}</span>
          <span class="stat-value">${vessel.speed} kts</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryVessel.heading')}</span>
          <span class="stat-value">${Math.round(vessel.heading)}°</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryVessel.mmsi')}</span>
          <span class="stat-value">${vesselMmsi}</span>
        </div>
        ${vessel.hullNumber ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryVessel.hull')}</span>
          <span class="stat-value">${vesselHull}</span>
        </div>
        ` : ''}
      </div>
      ${vessel.note ? `<p class="popup-description">${vesselNote}</p>` : ''}
      ${vessel.isDark ? `<p class="popup-description alert">${t('popups.militaryVessel.darkDescription')}</p>` : ''}
    </div>
  `;
}

export function renderMilitaryFlightClusterPopup(cluster: MilitaryFlightCluster): string {
  const activityLabels: Record<string, string> = {
    exercise: t('popups.militaryCluster.flightActivity.exercise'),
    patrol: t('popups.militaryCluster.flightActivity.patrol'),
    transport: t('popups.militaryCluster.flightActivity.transport'),
    unknown: t('popups.militaryCluster.flightActivity.unknown'),
  };
  const activityColors: Record<string, string> = {
    exercise: 'high',
    patrol: 'elevated',
    transport: 'low',
    unknown: 'low',
  };

  const activityType = cluster.activityType || 'unknown';
  const clusterName = escapeHtml(cluster.name);
  const activityTypeLabel = escapeHtml(activityType.toUpperCase());
  const dominantOperator = cluster.dominantOperator ? escapeHtml(cluster.dominantOperator.toUpperCase()) : '';
  const flightSummary = cluster.flights
    .slice(0, 5)
    .map(f => `<div class="cluster-flight-item">${escapeHtml(f.callsign)} - ${escapeHtml(f.aircraftType)}</div>`)
    .join('');
  const moreFlights = cluster.flightCount > 5
    ? `<div class="cluster-more">${t('popups.militaryCluster.moreAircraft', { count: String(cluster.flightCount - 5) })}</div>`
    : '';

  return `
    <div class="popup-header military-cluster">
      <span class="popup-title">${clusterName}</span>
      <span class="popup-badge ${activityColors[activityType] || 'low'}">${t('popups.militaryCluster.aircraftCount', { count: String(cluster.flightCount) })}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${activityLabels[activityType] || t('popups.militaryCluster.flightActivity.unknown')}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryCluster.aircraft')}</span>
          <span class="stat-value">${cluster.flightCount}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryCluster.activity')}</span>
          <span class="stat-value">${activityTypeLabel}</span>
        </div>
        ${cluster.dominantOperator ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryCluster.primary')}</span>
          <span class="stat-value">${dominantOperator}</span>
        </div>
        ` : ''}
      </div>
      <div class="popup-section">
        <span class="section-label">${t('popups.militaryCluster.trackedAircraft')}</span>
        <div class="cluster-flights">
          ${flightSummary}
          ${moreFlights}
        </div>
      </div>
    </div>
  `;
}

export function renderMilitaryVesselClusterPopup(cluster: MilitaryVesselCluster): string {
  const activityLabels: Record<string, string> = {
    exercise: t('popups.militaryCluster.vesselActivity.exercise'),
    deployment: t('popups.militaryCluster.vesselActivity.deployment'),
    patrol: t('popups.militaryCluster.vesselActivity.patrol'),
    transit: t('popups.militaryCluster.vesselActivity.transit'),
    unknown: t('popups.militaryCluster.vesselActivity.unknown'),
  };
  const activityColors: Record<string, string> = {
    exercise: 'high',
    deployment: 'high',
    patrol: 'elevated',
    transit: 'low',
    unknown: 'low',
  };

  const activityType = cluster.activityType || 'unknown';
  const clusterName = escapeHtml(cluster.name);
  const activityTypeLabel = escapeHtml(activityType.toUpperCase());
  const region = cluster.region ? escapeHtml(cluster.region) : '';
  const vesselSummary = cluster.vessels
    .slice(0, 5)
    .map(v => `<div class="cluster-vessel-item">${escapeHtml(v.name)} - ${escapeHtml(v.vesselType)}</div>`)
    .join('');
  const moreVessels = cluster.vesselCount > 5
    ? `<div class="cluster-more">${t('popups.militaryCluster.moreVessels', { count: String(cluster.vesselCount - 5) })}</div>`
    : '';

  return `
    <div class="popup-header military-cluster">
      <span class="popup-title">${clusterName}</span>
      <span class="popup-badge ${activityColors[activityType] || 'low'}">${t('popups.militaryCluster.vesselsCount', { count: String(cluster.vesselCount) })}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${activityLabels[activityType] || t('popups.militaryCluster.vesselActivity.unknown')}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryCluster.vessels')}</span>
          <span class="stat-value">${cluster.vesselCount}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.militaryCluster.activity')}</span>
          <span class="stat-value">${activityTypeLabel}</span>
        </div>
        ${cluster.region ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.region')}</span>
          <span class="stat-value">${region}</span>
        </div>
        ` : ''}
      </div>
      <div class="popup-section">
        <span class="section-label">${t('popups.militaryCluster.trackedVessels')}</span>
        <div class="cluster-vessels">
          ${vesselSummary}
          ${moreVessels}
        </div>
      </div>
    </div>
  `;
}
