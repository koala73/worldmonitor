/**
 * Build the single story plan consumed by every digest delivery surface.
 *
 * A successful brief compose makes the envelope's capped, filtered stories
 * canonical. When compose misses, delivery falls back to the raw digest pool,
 * normalized to the fields used by cooldown evaluation and delivered-log
 * writes. Source counts always come from the raw clustered pool because a
 * BriefStory retains only its primary source.
 */

function clusterIdForRawStory(story) {
  if (Array.isArray(story?.mergedHashes)
    && story.mergedHashes.length > 0
    && typeof story.mergedHashes[0] === 'string') {
    return story.mergedHashes[0];
  }
  return typeof story?.hash === 'string' ? story.hash : '';
}

function briefStoriesToFormatterShape(briefStories) {
  return briefStories.map((story) => ({
    title: typeof story?.headline === 'string' ? story.headline : '',
    severity: typeof story?.threatLevel === 'string' ? story.threatLevel : 'high',
    sources: typeof story?.source === 'string' && story.source.length > 0 ? [story.source] : [],
    link: typeof story?.sourceUrl === 'string' ? story.sourceUrl : '',
    description: typeof story?.description === 'string' ? story.description : '',
    phase: 'sustained',
    // Formatters do not render this field, but downstream card identity does.
    hash: typeof story?.clusterId === 'string' ? story.clusterId : '',
  }));
}

function normalizeRawStoryForCooldown(story) {
  const sources = Array.isArray(story?.sources) ? story.sources : [];
  return {
    clusterId: clusterIdForRawStory(story),
    threatLevel: typeof story?.severity === 'string' ? story.severity : 'unknown',
    source: typeof sources[0] === 'string' ? sources[0] : '',
    sourceUrl: typeof story?.link === 'string' ? story.link : '',
    headline: typeof story?.title === 'string' ? story.title : '',
  };
}

function sourceCountsByClusterId(rawStories) {
  const sourceCountByClusterId = new Map();
  for (const story of rawStories) {
    const clusterId = clusterIdForRawStory(story);
    if (!clusterId || sourceCountByClusterId.has(clusterId)) continue;
    sourceCountByClusterId.set(clusterId, Array.isArray(story?.sources) ? story.sources.length : 0);
  }
  return sourceCountByClusterId;
}

export function buildDigestDeliveryPlan({ briefStories, rawStories }) {
  const raw = Array.isArray(rawStories) ? rawStories : [];
  const hasBriefStories = Array.isArray(briefStories) && briefStories.length > 0;

  return {
    formatterStories: hasBriefStories ? briefStoriesToFormatterShape(briefStories) : raw,
    cooldownIterableStories: hasBriefStories
      ? briefStories
      : raw.map(normalizeRawStoryForCooldown),
    sourceCountByClusterId: sourceCountsByClusterId(raw),
  };
}
