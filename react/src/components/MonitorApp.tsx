'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FORECAST_INPUTS,
  computeForecast,
  projectTrajectory,
  type ForecastInputs,
} from '@npc/core';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { SideNav } from '@astryxdesign/core/SideNav';
import { SideNavHeading } from '@astryxdesign/core/SideNav';
import { SideNavItem } from '@astryxdesign/core/SideNav';
import { SideNavSection } from '@astryxdesign/core/SideNav';
import { Slider } from '@astryxdesign/core/Slider';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TopNav } from '@astryxdesign/core/TopNav';
import { TopNavHeading } from '@astryxdesign/core/TopNav';
import { TopNavItem } from '@astryxdesign/core/TopNav';

import { useMapUrlState } from '../hooks/useMapUrlState';
import {
  getMission,
  loadStoredMission,
  missionFeedSlots,
  saveMission,
  type ReactMission,
} from '../lib/missions';
import { loadFeeds, type FeedItem } from '../lib/wm-mcp';
import { FeedSidebar } from './FeedSidebar';
import { MapChrome, type MapDimension } from './MapChrome';
import { MonitorMap, type MonitorMapHandle } from './MonitorMap';

type Rail = 'map' | 'forecast' | 'status';

/**
 * React + Astryx World Monitor rewrite.
 * Same DeckGLMap stack as :3030; React owns chrome, missions, and feed bento.
 */
export function MonitorApp() {
  const [rail, setRail] = useState<Rail>('map');
  const [inputs, setInputs] = useState<ForecastInputs>(DEFAULT_FORECAST_INPUTS);
  const [feeds, setFeeds] = useState<FeedItem[]>([]);
  const mapApiRef = useRef<MonitorMapHandle>(null);
  const [feedMeta, setFeedMeta] = useState<{ configured: boolean; error: string | null }>({
    configured: false,
    error: null,
  });
  const [mission, setMission] = useState<ReactMission | null>(() => loadStoredMission());
  const [mapDimension, setMapDimension] = useState<MapDimension>('2d');
  const [mapFullscreen, setMapFullscreen] = useState(false);

  const map = useMapUrlState();
  const feedSlots = useMemo(() => missionFeedSlots(mission), [mission]);

  const result = useMemo(() => computeForecast(inputs), [inputs]);
  const trajectory = useMemo(() => projectTrajectory(inputs), [inputs]);
  const maxCap = Math.max(...trajectory.map((t) => t.usefulSocietalCapability), 1);

  useEffect(() => {
    void loadFeeds().then((r) => {
      setFeeds(r.items);
      setFeedMeta({ configured: r.configured, error: r.error });
    });
  }, []);

  const onMission = (next: ReactMission) => {
    setMission(next);
    saveMission(next.id);
    map.applyMission({
      view: next.view,
      zoom: next.zoom,
      timeRange: next.timeRange,
      layerKeys: next.layers,
    });
    setRail('map');
  };

  const activeLayers = Object.entries(map.state.layers)
    .filter(([, on]) => on)
    .map(([k]) => k);

  return (
    <AppShell
      variant="section"
      height="fill"
      contentPadding={0}
      topNav={
        <TopNav label="Primary" heading={<TopNavHeading heading="WORLD MONITOR" />}>
          <TopNavItem label="Map" isSelected={rail === 'map'} onClick={() => setRail('map')} />
          <TopNavItem
            label="Forecast"
            isSelected={rail === 'forecast'}
            onClick={() => setRail('forecast')}
          />
          <TopNavItem
            label="Status"
            isSelected={rail === 'status'}
            onClick={() => setRail('status')}
          />
        </TopNav>
      }
      sideNav={
        rail === 'map' ? undefined : (
          <SideNav
            aria-label="Workspace"
            collapsible
            header={
              <SideNavHeading
                heading="Workspace"
                subheading={mission?.label ?? 'No mission'}
              />
            }
          >
            <SideNavSection title="Surface">
              <SideNavItem label="Map" isSelected={false} onClick={() => setRail('map')} />
              <SideNavItem
                label="Forecast"
                isSelected={rail === 'forecast'}
                onClick={() => setRail('forecast')}
              />
              <SideNavItem
                label="Status"
                isSelected={rail === 'status'}
                onClick={() => setRail('status')}
              />
            </SideNavSection>
          </SideNav>
        )
      }
      mobileNav={{ breakpoint: 'md' }}
    >
      {rail === 'map' ? (
        <div
          className={`wm-react-map-layout${mapFullscreen ? ' wm-react-map-layout--fullscreen' : ''}`}
        >
          <FeedSidebar
            hidden={mapFullscreen}
            slots={feedSlots}
            feeds={feeds}
            missionLabel={mission?.label ?? null}
            layers={map.state.layers}
            onLayersChange={map.setLayers}
            missionId={mission?.id ?? null}
            onMission={onMission}
            view={map.state.view}
            onView={(v) => map.setView(v)}
            timeRange={map.state.timeRange}
            onTimeRange={map.setTimeRange}
            onToggleLayer={map.setLayer}
            timeFocus={map.state.timeFocus}
            onTimeFocus={map.seekTimelineFocus}
            onMapZoomIn={() => mapApiRef.current?.zoomIn()}
            onMapZoomOut={() => mapApiRef.current?.zoomOut()}
            onMapRecenter={() => mapApiRef.current?.resetView()}
            dimension={mapDimension}
            onDimensionChange={setMapDimension}
            fullscreen={mapFullscreen}
            onFullscreenChange={setMapFullscreen}
            map={
              <>
                <MapChrome />
                <div className="wm-react-map-canvas">
                  <MonitorMap
                    ref={mapApiRef}
                    lat={map.state.lat}
                    lon={map.state.lon}
                    zoom={map.state.zoom}
                    view={map.state.view}
                    timeRange={map.state.timeRange}
                    timeFocus={map.state.timeFocus}
                    layers={map.state.layers}
                    dimension={mapDimension}
                    onCameraIdle={({ lat, lon, zoom }) => map.setCamera(lat, lon, zoom)}
                  />
                </div>
                <div className="wm-react-map-meta">
                  <Text size="sm" color="secondary">
                    {activeLayers.length > 0
                      ? `${activeLayers.length} overlays · ${mapDimension === '3d' ? 'GlobeMap' : 'DeckGLMap'} (:3030 stack)`
                      : 'No overlays · pick a mission or toggle layers'}
                  </Text>
                  <Badge
                    label={feedMeta.configured ? 'MCP live' : 'MCP catalog'}
                    variant={feedMeta.configured ? 'success' : 'neutral'}
                  />
                </div>
              </>
            }
          />
        </div>
      ) : (
        <ScrollableArea label="Main workspace" className="wm-react-main">
          <Stack padding={4} gap={4} align="stretch">
            {rail === 'forecast' && (
              <>
                <Stack gap={1} align="start">
                  <Heading level={1}>Production-cycle forecast</Heading>
                  <Text color="secondary">NPC scenario controls inside the WM React shell.</Text>
                  <Badge label={result.phaseLabel} variant="info" />
                </Stack>

                <div className="wm-react-metrics">
                  <Card elevation="low" padding={3}>
                    <Text size="sm" color="secondary">
                      Horizon
                    </Text>
                    <Heading level={3}>{Math.round(result.horizonIndex * 100)}%</Heading>
                  </Card>
                  <Card elevation="low" padding={3}>
                    <Text size="sm" color="secondary">
                      Useful capability
                    </Text>
                    <Heading level={3}>{result.usefulSocietalCapability.toFixed(1)}</Heading>
                  </Card>
                  <Card elevation="low" padding={3}>
                    <Text size="sm" color="secondary">
                      Floor headroom
                    </Text>
                    <Heading level={3}>{result.floorHeadroom.toFixed(2)}</Heading>
                  </Card>
                </div>

                <Card elevation="low" padding={4}>
                  <Stack gap={3} align="stretch">
                    <Heading level={2}>Controls</Heading>
                    <Slider
                      label="Scenario year"
                      min={2026}
                      max={2040}
                      step={1}
                      value={inputs.year}
                      onChange={(v: number) => setInputs((p) => ({ ...p, year: v }))}
                      valueDisplay="text"
                      width="100%"
                    />
                    <Slider
                      label="Ownership"
                      min={0}
                      max={100}
                      value={Math.round(inputs.horizon.ownership * 100)}
                      onChange={(v: number) =>
                        setInputs((p) => ({
                          ...p,
                          horizon: { ...p.horizon, ownership: v / 100 },
                        }))
                      }
                      valueDisplay="text"
                      formatValue={(v: number) => `${v}%`}
                      width="100%"
                    />
                    <Slider
                      label="Reduced labour"
                      min={0}
                      max={100}
                      value={Math.round(inputs.horizon.reducedLabour * 100)}
                      onChange={(v: number) =>
                        setInputs((p) => ({
                          ...p,
                          horizon: { ...p.horizon, reducedLabour: v / 100 },
                        }))
                      }
                      valueDisplay="text"
                      formatValue={(v: number) => `${v}%`}
                      width="100%"
                    />
                    <Slider
                      label="Human agency"
                      min={0}
                      max={100}
                      value={Math.round(inputs.horizon.humanAgency * 100)}
                      onChange={(v: number) =>
                        setInputs((p) => ({
                          ...p,
                          horizon: { ...p.horizon, humanAgency: v / 100 },
                        }))
                      }
                      valueDisplay="text"
                      formatValue={(v: number) => `${v}%`}
                      width="100%"
                    />
                  </Stack>
                </Card>

                <Card elevation="low" padding={4}>
                  <Stack gap={2} align="stretch">
                    <Heading level={2}>Relationships</Heading>
                    {result.relationships.map((rel) => (
                      <ProgressBar
                        key={`${rel.from}-${rel.to}`}
                        label={`${rel.from} → ${rel.to}`}
                        value={rel.strength}
                        max={1}
                        hasValueLabel
                      />
                    ))}
                    <Text size="sm" color="secondary">
                      Trajectory peak useful capability {maxCap.toFixed(1)}.
                    </Text>
                  </Stack>
                </Card>
              </>
            )}

            {rail === 'status' && (
              <Card elevation="low" padding={4}>
                <Stack gap={2} align="start">
                  <Heading level={1}>Rewrite status</Heading>
                  <Text>
                    DeckGLMap + MapLibre basemap (same stack as :3030), overlay toggles, location
                    views, mission profiles, and a 3×2 feed bento are live on :3020.
                  </Text>
                  <Text color="secondary" size="sm">
                    Deep link the same query string as vanilla — lat, lon, zoom, view, timeRange,
                    layers.
                  </Text>
                  {feedMeta.error ? <Text color="secondary">{feedMeta.error}</Text> : null}
                  <Button
                    label="Refresh feeds"
                    variant="secondary"
                    onClick={() => {
                      void loadFeeds().then((r) => {
                        setFeeds(r.items);
                        setFeedMeta({ configured: r.configured, error: r.error });
                      });
                    }}
                  />
                  {getMission(mission?.id) ? (
                    <Badge label={`Mission: ${mission!.label}`} variant="info" />
                  ) : null}
                </Stack>
              </Card>
            )}
          </Stack>
        </ScrollableArea>
      )}
    </AppShell>
  );
}
