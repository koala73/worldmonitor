'use strict';

function createExplicitTierFourSourceSet(sourceTiers) {
  return new Set(
    Object.entries(sourceTiers)
      .filter(([, tier]) => tier === 4)
      .map(([sourceName]) => sourceName),
  );
}

function isExplicitTierFourSource(sourceName, tierFourSources) {
  return tierFourSources.has(sourceName ?? '');
}

function shouldDropRelaySourceForTier(gatesReady, sourceName, tierFourSources) {
  return gatesReady && isExplicitTierFourSource(sourceName, tierFourSources);
}

module.exports = {
  createExplicitTierFourSourceSet,
  isExplicitTierFourSource,
  shouldDropRelaySourceForTier,
};
