const MICROSTATE_COVERAGE_STORIES = Object.freeze({
  TV: {
    requiredGapDimensionIds: [
      'externalDebtCoverage',
      'liquidReserveAdequacy',
      'importConcentration',
      'informationCognitive',
    ],
    build: (facts) => ({
      introduction: `Tuvalu enters the rankable universe as a UN member, but this edition starts from its available Pacific evidence instead of estimating a national result. The observed record reaches ${facts.coverage} coverage and remains below the publication gate.`,
      gap: `Tuvalu's very small reporting population falls below the standalone reporting thresholds used by several international series. In this snapshot, the World Bank external-debt and liquid-reserve slots have no standalone Tuvalu observation. UN Comtrade also leaves import concentration unmonitored, while Reporters Without Borders supplies no information-environment reading. These omissions leave coverage at ${facts.coverage}, ${facts.shortfall} below the ${facts.coverageFloor}% publication floor.`,
      evidence: `Available Tuvalu inputs produce ${facts.readingCount} supported dimension readings: ${facts.readings}. The observed source mix includes ${facts.sourceExamples}. Each value describes one dimension; none is an overall score or country rank.`,
      comparatorLead: 'Pacific context comes from ranked regional reference pages.',
      useRegionalComparators: true,
      comparatorTail: 'They provide transparent reference points without filling Tuvalu gaps from another country.',
      crisis: `No fixed crawlable crisis tracker has Tuvalu in scope. This means that the current registry of ${facts.crisisRegistrySize} tracker desks does not include the country; it does not describe present risk.`,
      limits: `Read the ${facts.capturedDate} Tuvalu record as a partial source inventory under ${facts.methodologyFormula}. Coverage of ${facts.coverage} and imputation of ${facts.imputationShare} are input-quality facts, not a concealed national score.`,
      readingGuide: `Use Tuvalu's dated dimensions with the live map when Pacific conditions change. The linked method and corrections pages hold the shared publication rules and revision history.`,
      faqs: [
        {
          question: 'Why is no Tuvalu resilience rank shown?',
          answer: `Tuvalu is below the ${facts.coverageFloor}% coverage floor because its very small reporting population leaves World Bank debt and reserve observations, UN Comtrade import concentration, and the Reporters Without Borders information reading unavailable as standalone inputs in this snapshot.`,
        },
        {
          question: 'What evidence is available for Tuvalu?',
          answer: `The page contains ${facts.readingCount} observed dimension readings, including ${facts.highlightedDimensions}. Use them separately with their coverage values; do not combine them into an unpublished score.`,
        },
        {
          question: 'What is the right comparison for Tuvalu?',
          answer: 'Use the named Pacific ranked references to understand scale and regional context. Their published scores do not replace Tuvalu source gaps.',
        },
      ],
    }),
  },
  MO: {
    requiredGapDimensionIds: [
      'healthPublicService',
      'informationCognitive',
      'externalDebtCoverage',
    ],
    build: (facts) => ({
      introduction: `World Monitor records Macau separately in the rankable universe. Its trade, digital, fiscal, and continuity inputs form a distinct partial profile, while several providers do not expose the SAR as the same standalone unit.`,
      gap: `WHO and Reporters Without Borders do not contribute separate Macau observations to this snapshot. The World Bank external-debt slot is also unmonitored for Macau. As a special administrative region, Macau is a standalone reporting unit in some provider systems but is included in China series in others. The remaining inputs cover ${facts.coverage}, short of the ${facts.coverageFloor}% rank threshold.`,
      evidence: `For Macau, ${facts.readingCount} dimensions carry usable observed inputs. Their readings are ${facts.readings}. Covered provider families include ${facts.sourceExamples}. This list supports a partial SAR profile rather than a hidden composite result.`,
      comparatorLead: 'Macau uses a ranked East Asia and Pacific reference set.',
      useRegionalComparators: false,
      comparatorTail: 'The links show the published neighborhood while keeping Macau outside the scored list.',
      crisis: `The maintained crisis registry has no Macau tracker page. That boundary reflects the ${facts.crisisRegistrySize} selected tracker scopes and says nothing about whether a live event exists in the SAR.`,
      limits: `The Macau evidence was captured on ${facts.capturedDate} with method ${facts.methodologyFormula}. Its ${facts.coverage} input coverage is usable for dimension review, while the ${facts.imputationShare} imputation share must stay separate from a headline value.`,
      readingGuide: `Treat Macau's source list as a separate SAR evidence record, while the live monitor supplies current signals. The methodology and correction links carry common scoring details outside this country narrative.`,
      faqs: [
        {
          question: 'Why does Macau have no published resilience score?',
          answer: `Macau reaches ${facts.coverage} coverage. WHO, Reporters Without Borders, and the World Bank debt feed do not supply all standalone SAR observations needed to reach the ${facts.coverageFloor}% floor because provider systems classify the SAR inconsistently.`,
        },
        {
          question: 'What evidence is available for Macau?',
          answer: `It contains ${facts.readingCount} observed dimension readings, including ${facts.highlightedDimensions}. The values remain evidence components and are not a published Macau rank.`,
        },
        {
          question: 'How should Macau be compared?',
          answer: 'Read the ranked regional links as context for a city economy and SAR. Do not infer a Macau score from the nearest published country.',
        },
      ],
    }),
  },
  SM: {
    requiredGapDimensionIds: [
      'importConcentration',
      'socialCohesion',
      'informationCognitive',
      'externalDebtCoverage',
    ],
    build: (facts) => ({
      introduction: `San Marino has many observed European inputs, yet four dimension gaps leave a narrow but material break in this edition. The page therefore shows the measurements that exist and withholds the aggregate.`,
      gap: `Very small sovereign states do not receive a complete standalone record across these provider systems. For San Marino, UN Comtrade does not contribute an import-concentration observation. The social-cohesion feed from IEP, UNHCR, and UCDP is marked source unavailable in this snapshot. Reporters Without Borders supplies no information-environment value, and the World Bank debt slot is unmonitored. Those gaps leave coverage at ${facts.coverage}, ${facts.shortfall} under the ${facts.coverageFloor}% floor.`,
      evidence: `San Marino retains ${facts.readingCount} dimension measurements backed by observed data: ${facts.readings}. Source families on the covered side include ${facts.sourceExamples}. These lines stay separate because the publication rule blocks an overall number.`,
      comparatorLead: 'European ranked pages provide the comparison frame.',
      useRegionalComparators: true,
      comparatorTail: 'Their complete published rows are reference cases, not estimates for San Marino.',
      crisis: `San Marino does not appear in a dedicated crawlable crisis tracker. The registry covers a fixed set of ${facts.crisisRegistrySize} crisis desks, so this omission is about tracker selection rather than national conditions.`,
      limits: `This ${facts.capturedDate} San Marino inventory uses ${facts.methodologyFormula}. A ${facts.coverage} coverage reading and ${facts.imputationShare} imputation share describe evidence quality only; no resilience total is released.`,
      readingGuide: `Read San Marino's measured dimensions beside live European alerts, not as a substitute aggregate. Shared formula history and published changes are available through the two reference links.`,
      faqs: [
        {
          question: 'What prevents a San Marino ranking?',
          answer: `Coverage is ${facts.coverage} because very small sovereign-state records from UN Comtrade, social-cohesion feeds, Reporters Without Borders, and the World Bank debt feed do not all provide usable standalone San Marino observations.`,
        },
        {
          question: 'What evidence is available for San Marino?',
          answer: `${facts.readingCount} dimensions have observed readings, among them ${facts.highlightedDimensions}. They can support evidence review but not an unpublished aggregate.`,
        },
        {
          question: 'Which comparisons help with San Marino?',
          answer: 'Use the linked European ranked pages as published reference cases. Keep their national scores separate from San Marino source availability.',
        },
      ],
    }),
  },
});

export function buildMicrostateCoverageStoryContent(facts) {
  const story = MICROSTATE_COVERAGE_STORIES[facts.code];
  if (!story) return null;
  const currentGaps = new Set(facts.gapDimensionIds);
  const staleClaims = story.requiredGapDimensionIds.filter((id) => !currentGaps.has(id));
  if (staleClaims.length > 0) {
    throw new Error(
      `${facts.code} coverage story cites dimensions that are no longer coverage gaps: ${staleClaims.join(', ')}`,
    );
  }
  return story.build(facts);
}
