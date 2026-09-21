'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@astryxdesign/core/Button';
import { Layout } from '@astryxdesign/core/Layout';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { LayoutPanel } from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';

import type { MissionPresetId, ReactMission } from '../lib/missions';
import type { FeedItem } from '../lib/wm-mcp';
import type { LayerKey, LayerMap, MapView, TimeRange } from '../lib/url-state';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './ui/drawer';
import { FeedBento } from './FeedBento';
import { MapChromeActions, type MapDimension } from './MapChrome';
import { MapFilterBar } from './MapFilterBar';
import { MapNavControls } from './MapNavControls';
import { MapTimeScrubber } from './MapTimeScrubber';
import { OverlayPanel } from './OverlayPanel';

/**
 * Map chrome: AI Footprint drawer + filter dropdowns float on the map canvas;
 * Feeds stays a collapsible/resizable right rail.
 */
export function FeedSidebar({
  map,
  slots,
  feeds,
  missionLabel,
  layers,
  onLayersChange,
  missionId,
  onMission,
  view,
  onView,
  timeRange,
  onTimeRange,
  onToggleLayer,
  timeFocus,
  onTimeFocus,
  onMapZoomIn,
  onMapZoomOut,
  onMapRecenter,
  dimension,
  onDimensionChange,
  fullscreen,
  onFullscreenChange,
  hidden = false,
}: {
  map: ReactNode;
  slots: string[];
  feeds: FeedItem[];
  missionLabel?: string | null;
  layers: LayerMap;
  onLayersChange: (layers: LayerMap) => void;
  missionId: MissionPresetId | null;
  onMission: (mission: ReactMission) => void;
  view: MapView;
  onView: (view: MapView) => void;
  timeRange: TimeRange;
  onTimeRange: (range: TimeRange) => void;
  onToggleLayer: (key: LayerKey, on: boolean) => void;
  timeFocus: number | null;
  onTimeFocus: (ms: number | null) => void;
  onMapZoomIn?: () => void;
  onMapZoomOut?: () => void;
  onMapRecenter?: () => void;
  dimension: MapDimension;
  onDimensionChange: (next: MapDimension) => void;
  fullscreen: boolean;
  onFullscreenChange: (next: boolean) => void;
  hidden?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapCanvas, setMapCanvas] = useState<HTMLDivElement | null>(null);
  const [aiOpen, setAiOpen] = useState(true);
  const feedsPanel = useResizable({
    defaultSize: 360,
    minSize: 260,
    maxSize: 560,
    collapsible: true,
    autoSaveId: 'wm-react-feeds-sidebar',
    containerRef,
  });

  useLayoutEffect(() => {
    setMapCanvas(
      containerRef.current?.querySelector<HTMLDivElement>('.wm-react-map-canvas') ??
        null,
    );
  }, [hidden, map]);

  const mapNav =
    mapCanvas != null && onMapZoomIn && onMapZoomOut && onMapRecenter
      ? createPortal(
          <MapNavControls
            onZoomIn={onMapZoomIn}
            onZoomOut={onMapZoomOut}
            onRecenter={onMapRecenter}
          />,
          mapCanvas,
        )
      : null;

  const chromeEnd = (
    <div className="wm-map-end-controls">
      <MapChromeActions
        dimension={dimension}
        onDimensionChange={onDimensionChange}
        fullscreen={fullscreen}
        onFullscreenChange={onFullscreenChange}
      />
      {!hidden && feedsPanel.isCollapsed ? (
        <div className="wm-feed-sidebar-tab">
          <Button
            size="sm"
            variant="primary"
            label="Feeds"
            onClick={() => feedsPanel.expand()}
          />
        </div>
      ) : null}
    </div>
  );

  if (hidden) {
    return (
      <div className="wm-react-map-body" ref={containerRef}>
        {map}
        {chromeEnd}
        {mapNav}
      </div>
    );
  }

  const mapToolbar =
    mapCanvas != null
      ? createPortal(
          <div className="wm-map-toolbar" role="toolbar" aria-label="Map tools">
            <DrawerTrigger
              render={
                <Button size="sm" variant="secondary" label="AI Footprint" />
              }
            />
            <MapFilterBar
              missionId={missionId}
              onMission={onMission}
              view={view}
              onView={onView}
              timeRange={timeRange}
              onTimeRange={onTimeRange}
              layers={layers}
              onToggleLayer={onToggleLayer}
              onMenuOpen={() => setAiOpen(false)}
            />
          </div>,
          mapCanvas,
        )
      : null;

  const mapScrubber =
    mapCanvas != null
      ? createPortal(
          <MapTimeScrubber
            timeRange={timeRange}
            timeFocus={timeFocus}
            onTimeFocus={onTimeFocus}
            layers={layers}
          />,
          mapCanvas,
        )
      : null;

  return (
    <div className="wm-react-map-body" ref={containerRef}>
      <Layout
        height="fill"
        padding={0}
        content={
          <LayoutContent padding={0} isScrollable={false} className="wm-react-map-main">
            {map}
            {chromeEnd}
          </LayoutContent>
        }
        end={
          feedsPanel.isCollapsed ? undefined : (
            <>
              <ResizeHandle
                direction="horizontal"
                isReversed
                hasDivider
                isAlwaysVisible
                label="Resize feeds"
                resizable={feedsPanel.props}
              />
              <LayoutPanel
                resizable={feedsPanel.props}
                label="Feeds"
                role="complementary"
                padding={0}
                isScrollable
                className="wm-feed-sidebar"
              >
                <FeedBento
                  variant="sidebar"
                  slots={slots}
                  feeds={feeds}
                  missionLabel={missionLabel}
                  onCollapse={() => feedsPanel.collapse()}
                />
              </LayoutPanel>
            </>
          )
        }
      />

      <Drawer
        open={aiOpen}
        onOpenChange={setAiOpen}
        swipeDirection="left"
        modal
        showSwipeHandle
      >
        {mapToolbar}
        {mapScrubber}
        {mapNav}
        {mapCanvas ? (
          <DrawerContent className="wm-ai-drawer" container={mapCanvas}>
            <DrawerHeader className="wm-ai-drawer-header">
              <DrawerTitle>AI Footprint</DrawerTitle>
              <DrawerDescription>
                <Text type="supporting" color="secondary" textWrap="pretty">
                  Map AI industry geography from cited World Monitor layers.
                </Text>
              </DrawerDescription>
            </DrawerHeader>
            <ScrollableArea
              label="AI Footprint layers"
              className="wm-ai-drawer-body"
              data-base-ui-swipe-ignore=""
            >
              <OverlayPanel
                layers={layers}
                onLayersChange={onLayersChange}
              />
            </ScrollableArea>
          </DrawerContent>
        ) : null}
      </Drawer>
    </div>
  );
}
