// @ts-check
// Rule-based regime derivation. Mirrors the rule table in
// docs/internal/pro-regional-intelligence-upgrade.md.
// Pure function: takes a balance vector, returns a regime label.

/**
 * @param {import('../../shared/regions.types.js').BalanceVector} balance
 * @returns {import('../../shared/regions.types.js').RegimeLabel}
 */
export function deriveRegime(balance) {
  const coercive = balance.coercive_pressure;
  const alliance = balance.alliance_cohesion;
  const net = balance.net_balance;

  if (coercive > 0.8 && net < -0.4) return 'escalation_ladder';
  if (coercive > 0.6 && alliance < 0.3) return 'fragmentation_risk';
  if (coercive > 0.5 && net > -0.1) return 'coercive_stalemate';
  if (net > 0.1 && coercive > 0.3) return 'managed_deescalation';
  if (net < -0.1) return 'stressed_equilibrium';
  return 'calm';
}

/**
 * Build a RegimeState by comparing the new balance to a previous regime label.
 *
 * @param {import('../../shared/regions.types.js').BalanceVector} balance
 * @param {import('../../shared/regions.types.js').RegimeLabel | ''} previousLabel
 * @param {string} transitionDriver
 * @returns {import('../../shared/regions.types.js').RegimeState}
 */
export function buildRegimeState(balance, previousLabel, transitionDriver = '') {
  const label = deriveRegime(balance);
  const transitioned = label !== previousLabel;
  return {
    label,
    previous_label: previousLabel,
    transitioned_at: transitioned ? Date.now() : 0,
    transition_driver: transitioned ? transitionDriver : '',
  };
}
