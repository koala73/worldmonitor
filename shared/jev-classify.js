/**
 * Headline threat classification as TypeSafe Jev questions.
 *
 * Pure: builds the request body and parses the answer body. Transport belongs
 * to the caller (scripts/lib/jev-classify-relay.cjs for the relay). Criteria
 * restate the relay's CLASSIFY_SYSTEM_PROMPT guidelines as described
 * situations, because Jev reads literally and does not count ("10+ killed"
 * would be a numeric comparison it is documented to get wrong).
 */

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export const THREAT_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
export const THREAT_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

const LEVEL_INSTRUCTIONS =
  'Rate the real-world severity of the event this news headline reports, from a geopolitical monitoring standpoint. '
  + 'Judge the event itself, not the emotional tone of the wording. '
  + 'Opinion, editorial, analysis, explainer, retrospective and tutorial pieces are info regardless of their subject.';

export const LEVEL_CRITERIA = {
  critical:
    'An event with geopolitical scope that destabilizes international order, threatens cross-border security or disrupts global systems: '
    + 'active military strikes with international implications, many people killed in conflict, terrorism or state action, '
    + 'a ceasefire agreed or collapsing, a nuclear incident, a pandemic declaration, a coup, closure of a strait or major waterway.',
  high:
    'A serious event without that global scope: an armed conflict update, a major diplomatic action, a sanctions package, '
    + 'a significant natural disaster, a blockade, a terrorist attack, or a domestic mass-casualty event such as a mass shooting or industrial disaster.',
  medium:
    'Reporting on ongoing conflict without a new major event, economic impact reports, protest movements, regional policy changes, military exercises.',
  low:
    'Routine international affairs: diplomatic meetings, trade discussions, humanitarian aid, election updates, peacekeeping deployments.',
  info:
    'Not an event to monitor: opinion or editorial, analysis or explainer, historical retrospective, lifestyle, entertainment, sport, '
    + 'routine local news, individual domestic crime, tutorials and how-to content.',
};

const CATEGORY_INSTRUCTIONS = 'Which single topic best describes what this news headline is about?';

export const CATEGORY_CRITERIA = {
  conflict: 'Armed conflict, war, fighting between states or armed groups, strikes, ceasefires.',
  protest: 'Protests, demonstrations, strikes by workers, riots, civil unrest.',
  disaster: 'Natural disasters and major accidents: earthquakes, floods, storms, wildfires, explosions, crashes.',
  diplomatic: 'Diplomacy, summits, treaties, sanctions as foreign policy, elections and government politics.',
  economic: 'Economy, markets, trade, tariffs, companies, prices, central banks.',
  terrorism: 'Terrorist attacks, plots, extremist groups.',
  cyber: 'Cyberattacks, hacks, data breaches, malware, vulnerabilities.',
  health: 'Disease outbreaks, pandemics, public health, medicine.',
  environmental: 'Climate, pollution, environmental damage, conservation.',
  military: 'Armed forces activity short of fighting: deployments, exercises, weapons programs, procurement, defense policy.',
  crime: 'Crime, policing, courts and prosecutions, not terrorism.',
  infrastructure: 'Power, energy facilities, pipelines, transport, shipping lanes, telecoms and internet outages.',
  tech: 'Technology products, AI, software, science, space.',
  general: 'None of the other topics fit.',
};

// TypeSafe documents non-English scripts as weaker, and the judged set held
// none, so callers keep these titles off Jev until they are measured.
export const hasNonLatinLetters = (title) => /(?=\p{L})\P{Script=Latin}/u.test(title);

export function sanitizeHeadline(title, maxTextChars = 200) {
  return String(title).replace(/[\n\r]/g, ' ').slice(0, maxTextChars).trim();
}

const levelQuestion = (subject) => ({
  type: 'choice',
  instructions: `${LEVEL_INSTRUCTIONS} The headline is ${subject}.`,
  criteria: LEVEL_CRITERIA,
});
const categoryQuestion = (subject) => ({
  type: 'choice',
  instructions: `${CATEGORY_INSTRUCTIONS} The headline is ${subject}.`,
  criteria: CATEGORY_CRITERIA,
});

/**
 * One request for `titles`. A single title gets `{headline}` as state. Several
 * share one state keyed h0..hN, with a level and a category question each.
 */
export function buildJevRequest(titles, { maxTextChars = 200, model = JEV_MODEL, levelOnly = false } = {}) {
  const clean = titles.map((t) => sanitizeHeadline(t, maxTextChars));
  if (clean.length === 1) {
    // levelOnly: the level answer is the same with or without the category
    // question beside it (median |dP| 0.01 over 40 titles) at 618 input tokens
    // instead of 1,030.
    const questions = { l0: levelQuestion('`headline`') };
    if (!levelOnly) questions.c0 = categoryQuestion('`headline`');
    return { model, state: { headline: clean[0] }, questions };
  }
  const headlines = {};
  const questions = {};
  clean.forEach((t, i) => {
    headlines[`h${i}`] = t;
    questions[`l${i}`] = levelQuestion(`\`headlines.h${i}\``);
    questions[`c${i}`] = categoryQuestion(`\`headlines.h${i}\``);
  });
  return { model, state: { headlines }, questions };
}

function readChoice(answer, valid) {
  if (answer?.type !== 'choice' || !valid.includes(answer.choice)) return null;
  const conf = Number(answer.confidence);
  if (!Number.isFinite(conf)) return null;
  return { choice: answer.choice, conf, probabilities: answer.probabilities ?? {} };
}

/**
 * Labels for every index whose answers are valid. Others are absent. With
 * `levelOnly` no category was asked, so none is required and `c` is omitted.
 */
export function parseJevAnswers(body, count, { levelOnly = false } = {}) {
  const answers = body?.answers;
  if (!answers || typeof answers !== 'object') return [];
  const labels = [];
  for (let i = 0; i < count; i++) {
    const level = readChoice(answers[`l${i}`], THREAT_LEVELS);
    const category = levelOnly ? null : readChoice(answers[`c${i}`], THREAT_CATEGORIES);
    if (!level || (!levelOnly && !category)) continue;
    const p = level.probabilities;
    // A level without its own probability is a response shape this parser does
    // not understand. Dropping it sends the title to the fallback, where reading
    // pAlert as 0 would instead cache an alert level that can never publish.
    if (typeof p[level.choice] !== 'number' || !Number.isFinite(p[level.choice])) continue;
    labels.push({
      i,
      l: level.choice,
      ...(category ? { c: category.choice } : {}),
      levelConf: level.conf,
      pAlert: [p.critical, p.high].reduce((sum, v) => sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0),
    });
  }
  return labels;
}
