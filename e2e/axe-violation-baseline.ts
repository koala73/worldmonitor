export type KnownAxeViolationBaseline = Readonly<Record<string, readonly string[]>>;

export interface AxeViolationLike {
  id: string;
  nodes: ReadonlyArray<{ target: unknown }>;
}

export interface AxeViolationBaselineDiff {
  unexpectedRuleIds: string[];
  expandedTargets: string[];
  staleTargets: string[];
  invalidBaselineRuleIds: string[];
}

/** Serialize axe's cross-tree selector without losing frame boundaries. */
export function axeTargetFingerprint(target: unknown): string {
  return JSON.stringify(target) ?? String(target);
}

/**
 * Compare exact violating nodes, not just rule IDs. A known rule may neither
 * expand to another node nor retain a stale node without making the gate red.
 */
export function compareAxeViolationBaseline(
  violations: readonly AxeViolationLike[],
  baseline: KnownAxeViolationBaseline,
): AxeViolationBaselineDiff {
  const actualByRule = new Map<string, Set<string>>();
  for (const violation of violations) {
    const targets = actualByRule.get(violation.id) ?? new Set<string>();
    for (const node of violation.nodes) targets.add(axeTargetFingerprint(node.target));
    actualByRule.set(violation.id, targets);
  }

  const baselineRuleIds = new Set(Object.keys(baseline));
  const unexpectedRuleIds = [...actualByRule.keys()]
    .filter((id) => !baselineRuleIds.has(id))
    .sort();
  const expandedTargets: string[] = [];
  const staleTargets: string[] = [];
  const invalidBaselineRuleIds: string[] = [];

  for (const [ruleId, expectedTargetList] of Object.entries(baseline)) {
    if (expectedTargetList.length === 0) invalidBaselineRuleIds.push(ruleId);
    const expectedTargets = new Set(expectedTargetList);
    const actualTargets = actualByRule.get(ruleId) ?? new Set<string>();
    for (const target of actualTargets) {
      if (!expectedTargets.has(target)) expandedTargets.push(`${ruleId}: ${target}`);
    }
    for (const target of expectedTargets) {
      if (!actualTargets.has(target)) staleTargets.push(`${ruleId}: ${target}`);
    }
  }

  return {
    unexpectedRuleIds,
    expandedTargets: expandedTargets.sort(),
    staleTargets: staleTargets.sort(),
    invalidBaselineRuleIds: invalidBaselineRuleIds.sort(),
  };
}
