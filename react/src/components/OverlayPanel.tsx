'use client';

import { CheckboxList } from '@astryxdesign/core/CheckboxList';
import { CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import {
  Collapsible,
  CollapsibleGroup,
} from '@astryxdesign/core/Collapsible';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import {
  AI_FOOTPRINT_ALIASES,
  AI_FOOTPRINT_LAYER_KEYS,
  activeAiFootprintLayerValues,
  isAliasActive,
  layersForAliasToggle,
} from '../lib/ai-stack-aliases';
import { getOverlayDef } from '../lib/layers';
import type { LayerKey, LayerMap } from '../lib/url-state';

const OFF = 'off';

/**
 * AI Footprint body — A–D pillars + E map layers.
 * Timeline scrub points live on TimeNav only (filtered by checked layers).
 */
export function OverlayPanel({
  layers,
  onLayersChange,
}: {
  layers: LayerMap;
  onLayersChange: (layers: LayerMap) => void;
}) {
  const aliasActive = AI_FOOTPRINT_ALIASES.filter((a) => isAliasActive(a, layers)).map(
    (a) => a.id,
  );
  const aliasValues = aliasActive.length === 0 ? [OFF] : aliasActive;

  const layerActive = activeAiFootprintLayerValues(layers);
  const layerValues = layerActive.length === 0 ? [OFF] : layerActive;

  const onAliasChecked = (values: string[]) => {
    const pickedOff = values.includes(OFF) && !aliasValues.includes(OFF);
    const clearedOff = values.filter((v) => v !== OFF);
    let next = { ...layers };
    if (pickedOff || clearedOff.length === 0) {
      for (const alias of AI_FOOTPRINT_ALIASES) {
        next = layersForAliasToggle(alias, next, false);
      }
    } else {
      const selected = new Set(clearedOff);
      for (const alias of AI_FOOTPRINT_ALIASES) {
        next = layersForAliasToggle(alias, next, selected.has(alias.id));
      }
    }
    onLayersChange(next);
  };

  const onLayersChecked = (values: string[]) => {
    const pickedOff = values.includes(OFF) && !layerValues.includes(OFF);
    const clearedOff = values.filter((v) => v !== OFF);
    const next = { ...layers };
    if (pickedOff || clearedOff.length === 0) {
      for (const key of AI_FOOTPRINT_LAYER_KEYS) {
        next[key] = false;
      }
    } else {
      const selected = new Set(clearedOff);
      for (const key of AI_FOOTPRINT_LAYER_KEYS) {
        next[key] = selected.has(key);
      }
    }
    onLayersChange(next);
  };

  return (
    <Stack
      className="wm-overlay-panel"
      gap={0}
      paddingInline={3}
      paddingBlockStart={3}
      paddingBlockEnd={4}
      align="stretch"
    >
      <CollapsibleGroup
        type="multiple"
        density="compact"
        className="wm-ai-drawer-accordions"
        defaultValue={['pillars', 'layers']}
      >
        <Stack gap={3} align="stretch">
          <Collapsible
            value="pillars"
            trigger={
              <Text type="label" color="secondary">
                Pillars
              </Text>
            }
          >
            <CheckboxList
              label="Pillars"
              isLabelHidden
              description="A–D aliases onto existing geo layers"
              density="compact"
              value={aliasValues}
              onChange={onAliasChecked}
            >
              <CheckboxListItem value={OFF} label="Off" />
              {AI_FOOTPRINT_ALIASES.map((alias) => (
                <CheckboxListItem
                  key={alias.id}
                  value={alias.id}
                  label={`${alias.section} · ${alias.label}`}
                  description={alias.description}
                />
              ))}
            </CheckboxList>
          </Collapsible>

          <Collapsible
            value="layers"
            trigger={
              <Text type="label" color="secondary">
                AI map layers
              </Text>
            }
          >
            <CheckboxList
              label="AI map layers"
              isLabelHidden
              description="E — timeline scrub points follow checked layers"
              density="compact"
              value={layerValues}
              onChange={onLayersChecked}
            >
              <CheckboxListItem value={OFF} label="Off" />
              {AI_FOOTPRINT_LAYER_KEYS.map((key) => {
                const def = getOverlayDef(key as LayerKey);
                return (
                  <CheckboxListItem key={key} value={key} label={def.label} />
                );
              })}
            </CheckboxList>
          </Collapsible>
        </Stack>
      </CollapsibleGroup>
    </Stack>
  );
}
