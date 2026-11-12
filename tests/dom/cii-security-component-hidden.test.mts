// CII v15 scores no Security input, so the component is always 0. A 0 on screen
// reads as "no military activity" for a country at war, so no surface may show it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CIIPanel } from '@/components/CIIPanel';
import { CountryBriefPage } from '@/components/CountryBriefPage';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CachedRiskScores } from '@/services/cached-risk-scores';
import { t } from '@/services/i18n';
import { displayedCiiComponents } from '@/utils/cii-components';
import { buildCountryEvidenceBundle, renderCountryEvidenceMarkdown } from '@/utils/export';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });
afterEach(() => { document.body.innerHTML = ''; });

const ROOT = resolve(import.meta.dirname, '../..');
const components = (security: number) => ({ unrest: 41, conflict: 96, security, information: 62 });

function cached(security: number): CachedRiskScores {
  return {
    cii: [{ code: 'UA', name: 'Ukraine', score: 70, level: 'high', trend: 'stable', change24h: 0, components: components(security), lastUpdated: '2026-10-23T09:46:00.000Z' }],
    strategicRisk: { score: 50, level: 'elevated', topRisks: [], lastUpdated: null },
    protestCount: 0, computedAt: '2026-10-23T09:46:00.000Z', cached: true, degraded: false, stale: false,
  } as unknown as CachedRiskScores;
}

describe('displayedCiiComponents', () => {
  it('drops a zero or invalid Security component and keeps the display order', () => {
    expect(displayedCiiComponents(components(0)).map(({ key }) => key)).toEqual(['unrest', 'conflict', 'information']);
    expect(displayedCiiComponents(components(Number.NaN)).map(({ key }) => key)).toEqual(['unrest', 'conflict', 'information']);
  });

  it('keeps a scored Security component and zero values of the other components', () => {
    expect(displayedCiiComponents({ unrest: 0, conflict: 0, security: 35, information: 0 })).toEqual([
      { key: 'unrest', value: 0 }, { key: 'conflict', value: 0 }, { key: 'security', value: 35 }, { key: 'information', value: 0 },
    ]);
  });
});

describe('CII surfaces hide an unscored Security component', () => {
  function ciiPanelText(security: number): string {
    const panel = new CIIPanel();
    document.body.append(panel.getElement());
    panel.renderFromCached(cached(security));
    const text = panel.getElement().querySelector('.cii-components')?.textContent ?? '';
    panel.destroy();
    return text;
  }

  it('CIIPanel shows no S:0', () => {
    expect(ciiPanelText(0)).toBe('U:41C:96I:62');
    expect(ciiPanelText(35)).toBe('U:41C:96S:35I:62');
  });

  function barLabels(host: Element, selector: string): Array<string | null> {
    return [...host.querySelectorAll(selector)].map((label) => label.textContent);
  }

  it('the country deep-dive panel draws no Security bar', () => {
    const panel = new CountryDeepDivePanel();
    const render = (security: number) => Reflect.apply(Reflect.get(panel, 'renderComponentBars'), panel, [components(security)]) as HTMLElement;
    const label = t('countryBrief.components.security');
    expect(barLabels(render(0), '.cdp-comp-label')).not.toContain(label);
    expect(barLabels(render(0), '.cdp-comp-label')).toHaveLength(3);
    expect(barLabels(render(35), '.cdp-comp-label')).toContain(label);
    panel.hide();
  });

  it('the country brief page draws no Security bar', () => {
    const page = new CountryBriefPage();
    const render = (security: number) => {
      const host = document.createElement('div');
      host.innerHTML = Reflect.apply(Reflect.get(page, 'componentBars'), page, [components(security)]) as string;
      return host;
    };
    const label = t('modals.countryBrief.components.security');
    expect(barLabels(render(0), '.cb-comp-label')).not.toContain(label);
    expect(barLabels(render(35), '.cb-comp-label')).toContain(label);
  });

  it('the country evidence export lists no zero Security component', () => {
    const render = (security: number) => renderCountryEvidenceMarkdown(buildCountryEvidenceBundle({
      country: 'Ukraine', code: 'UA', score: 70, components: components(security), exportedAt: '2026-10-23T09:46:00.000Z',
    } as Parameters<typeof buildCountryEvidenceBundle>[0]));
    expect(render(0)).toContain('- Components: unrest 41, conflict 96, information 62');
    expect(render(35)).toContain('- Components: unrest 41, conflict 96, security 35, information 62');
  });

  it('the CII panel methodology no longer describes a Security component', () => {
    const tooltip = t('components.cii.infoTooltip');
    expect(tooltip).not.toMatch(/ecurity/);
    expect(tooltip).toContain('U:C:I');
  });

  it('every source file reads the Security component through displayedCiiComponents', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'generated' || entry.name === 'e2e' ? [] : walk(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
    const offenders = walk(join(ROOT, 'src'))
      .filter((file) => !file.endsWith('src/utils/cii-components.ts'))
      .filter((file) => /components\??\.security\b/.test(readFileSync(file, 'utf8').replace(/t\((['"`])[^'"`]+\1/g, '')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
