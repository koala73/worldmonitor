// Bet-template registry core (Phase 1 / #5233 re-engine).
//
// A "bet template" turns one feed into a crisp, resolution-bound forecast.
// Adding a domain = adding templates, not a hand-coded detector. Every template
// carries its own metric extractor, question builder, and resolution-spec
// builder (reusing the #4976 spec contract) so a generated bet is resolvable by
// construction. Pure + injected: no Redis, R2, or wall-clock reads (nowMs in).
//
// Template shape:
//   {
//     id:            string                       // stable slug, e.g. 'energy:crude-inventory'
//     feedKey:       string                       // the feed this template reads
//     domain:        string                       // forecast domain bucket
//     extractMetric: (feedData) => metric | null  // null = feed absent/unusable → skip
//     horizonPolicy: (ctx) => deadlineMs          // when the bet resolves
//     buildResolutionSpec: (ctx) => spec          // #4976 hard/judged spec
//     buildQuestion: (ctx) => string              // crisp YES criterion
//     buildTitle?:   (ctx) => string              // display title (defaults to question)
//     userValueScore?: (ctx) => number            // 0..1 ranking signal
//   }
// ctx passed to horizon/spec/question/title/score:
//   { template, metric, feed, nowMs, deadlineMs, spec }

export function generateBets(templates, feedsByKey, nowMs) {
  const bets = [];
  const seen = new Set();
  for (const template of Array.isArray(templates) ? templates : []) {
    const feed = feedsByKey?.[template.feedKey];
    let metric = null;
    try {
      metric = template.extractMetric(feed);
    } catch {
      metric = null;
    }
    if (!metric) continue; // feed absent or metric not extractable → no bet

    const baseCtx = { template, metric, feed, nowMs };
    let deadlineMs;
    let spec;
    let question;
    try {
      deadlineMs = Number(template.horizonPolicy({ ...baseCtx }));
      if (!Number.isFinite(deadlineMs)) continue;
      const ctx = { ...baseCtx, deadlineMs };
      spec = template.buildResolutionSpec(ctx);
      if (!spec) continue;
      question = template.buildQuestion({ ...ctx, spec });
    } catch {
      continue;
    }
    if (!question || typeof question !== 'string') continue;

    const ctx = { ...baseCtx, deadlineMs, spec };
    const id = String(template.buildId ? template.buildId(ctx) : `${template.id}:${metric.subject}`);
    const dedupeKey = `${id}@${spec.deadline}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    bets.push({
      id,
      domain: template.domain,
      title: template.buildTitle ? String(template.buildTitle(ctx)) : question,
      question,
      probability: null, // set downstream by base-rate (Phase 1) / ensemble (Phase 2)
      resolution: spec,
      generationOrigin: 'bet_engine',
      userValueScore: clamp01(template.userValueScore ? Number(template.userValueScore(ctx)) : 0.5),
      generatedAt: nowMs,
      feedKey: template.feedKey,
      templateId: template.id,
    });
  }
  return bets;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
