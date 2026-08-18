import type {
  CapabilityObservation,
  DemographicsAgeStructure,
  DemographicsEducation,
  DemographicsIndustrialWorkforce,
  GetDemographicsCapabilityResponse,
} from '@/generated/client/worldmonitor/resilience/v1/service_client';
import { h } from '@/utils/dom-utils';
import {
  formatDemographicsObservation,
  summarizeDemographicsSources,
} from './demographics-capability-view-model';

type MetricFactory = (label: string, value: string, chipClass: string) => HTMLElement;
type Translator = (key: string, params?: Record<string, string>) => string;
type StageName = 'wpp' | 'education' | 'ilostat';
type DemographicsGroup = DemographicsAgeStructure | DemographicsEducation | DemographicsIndustrialWorkforce;
type ObservationField<Group> = {
  [Field in keyof Group]-?: NonNullable<Group[Field]> extends CapabilityObservation ? Field : never;
}[keyof Group];
type MetricDefinition<Group> = { field: ObservationField<Group>; labelKey: string };
type RenderContext = {
  stages: GetDemographicsCapabilityResponse['stages'];
  makeMetric: MetricFactory;
  translate: Translator;
};
type RenderGroupOptions<Group extends DemographicsGroup> = {
  titleKey: string;
  stageName: StageName;
  group: Group | undefined;
  metrics: readonly MetricDefinition<Group>[];
};

const AGE_METRICS = [
  { field: 'medianAgeYears', labelKey: 'countryBrief.demographicsCapability.medianAge' },
  { field: 'oldAgeDependencyRatioPercent', labelKey: 'countryBrief.demographicsCapability.oldAgeDependency' },
  { field: 'totalDependencyRatioPercent', labelKey: 'countryBrief.demographicsCapability.totalDependency' },
  { field: 'workingAgePopulationPeople', labelKey: 'countryBrief.demographicsCapability.workingAgePopulation' },
  { field: 'workingAgePopulationProjected10yPeople', labelKey: 'countryBrief.demographicsCapability.workingAgeProjection' },
] as const satisfies readonly MetricDefinition<DemographicsAgeStructure>[];

const EDUCATION_METRICS = [
  { field: 'tertiaryEnrollmentGrossPercent', labelKey: 'countryBrief.demographicsCapability.tertiaryEnrollment' },
  { field: 'stemGraduatesSharePercent', labelKey: 'countryBrief.demographicsCapability.stemGraduates' },
  { field: 'researchersPerMillion', labelKey: 'countryBrief.demographicsCapability.researchers' },
] as const satisfies readonly MetricDefinition<DemographicsEducation>[];

const WORKFORCE_METRICS = [
  { field: 'craftTradesEmploymentPeople', labelKey: 'countryBrief.demographicsCapability.craftTrades' },
  { field: 'plantMachineOperatorsEmploymentPeople', labelKey: 'countryBrief.demographicsCapability.plantOperators' },
  { field: 'trainedIndustrialWorkforcePeople', labelKey: 'countryBrief.demographicsCapability.trainedIndustrialWorkforce' },
  { field: 'manufacturingEmploymentSharePercent', labelKey: 'countryBrief.demographicsCapability.manufacturingShare' },
] as const satisfies readonly MetricDefinition<DemographicsIndustrialWorkforce>[];

function groupObservation<Group extends DemographicsGroup>(
  group: Group | undefined,
  field: ObservationField<Group>,
): CapabilityObservation | undefined {
  return group?.[field] as CapabilityObservation | undefined;
}

function renderGroup<Group extends DemographicsGroup>(
  { titleKey, stageName, group, metrics }: RenderGroupOptions<Group>,
  { stages, makeMetric, translate }: RenderContext,
): HTMLElement {
  const section = h('section', { className: 'cdp-demographics-group' });
  section.append(h('div', { className: 'cdp-subtitle' }, translate(titleKey)));

  const observations = metrics.map(({ field }) => groupObservation(group, field));
  const unavailable = translate('countryBrief.demographicsCapability.notAvailable');
  const grid = h('div', { className: 'cdp-military-grid' });
  for (const { field, labelKey } of metrics) {
    grid.append(makeMetric(
      translate(labelKey),
      formatDemographicsObservation(groupObservation(group, field), unavailable),
      'cdp-chip-neutral',
    ));
  }
  section.append(grid);

  const sources = summarizeDemographicsSources(observations);
  if (sources) {
    section.append(h('div', { className: 'cdp-economic-source' }, translate('countryBrief.demographicsCapability.source', { sources })));
  }
  const stage = stages.find((entry) => entry.name === stageName);
  if (stage?.status === 'retained') {
    section.append(h('div', { className: 'cdp-economic-source' }, translate('countryBrief.demographicsCapability.retained', {
      stage: translate(titleKey),
    })));
  }
  return section;
}

export function renderDemographicsCapabilitySection(
  data: GetDemographicsCapabilityResponse,
  makeMetric: MetricFactory,
  translate: Translator,
): HTMLElement {
  const section = h('div', { className: 'cdp-demographics-capability' });
  const context = { stages: data.stages, makeMetric, translate };
  section.append(
    renderGroup({
      titleKey: 'countryBrief.demographicsCapability.ageStructure',
      stageName: 'wpp',
      group: data.ageStructure,
      metrics: AGE_METRICS,
    }, context),
    renderGroup({
      titleKey: 'countryBrief.demographicsCapability.education',
      stageName: 'education',
      group: data.education,
      metrics: EDUCATION_METRICS,
    }, context),
    renderGroup({
      titleKey: 'countryBrief.demographicsCapability.industrialWorkforce',
      stageName: 'ilostat',
      group: data.industrialWorkforce,
      metrics: WORKFORCE_METRICS,
    }, context),
  );
  return section;
}
