/**
 * Canonical press / traction citations shared by marketing surfaces, llms.txt,
 * docs/about, and the blog chrome (#7377).
 *
 * Keep URLs here so homepage, docs, and agent briefings cannot drift on the
 * Silicon Canals 2M cite, the WIRED feature, or the country-reach figure.
 *
 * This list is the full press set, not a curated subset: the four prose lists
 * (public/llms.txt, public/world-monitor.md, docs/about.mdx, docs/zh/about.mdx)
 * are asserted equal to it in tests/geo-content-credibility-7377.test.mjs. They
 * had silently diverged three ways before that guard existed (#7530).
 */

export const WIRED_FEATURE_URL =
  'https://www.wired.com/story/world-monitor-elie-habib/';

/** Source of the public 2M+ users claim. */
export const SILICON_CANALS_2M_URL =
  'https://siliconcanals.com/sc-n-anghami-ceos-side-project-world-monitor-now-has-2-million-users-tracking-conflicts-in-real-time/';

export const ENTREPRENEUR_ME_URL =
  'https://mena.entrepreneur.com/business-news/how-elie-habib-built-world-monitor-to-track-global-events-in-real-time';

export const LORIENT_TODAY_URL =
  'https://today.lorientlejour.com/article/1496089/world-monitor-how-anghami-ceos-side-project-became-a-go-to-for-geopolitics-research.html';

export const ECONOMIC_TIMES_URL =
  'https://m.economictimes.com/tech/artificial-intelligence/gods-view-the-rise-of-ai-war-dashboards/articleshow/129553559.cms';

export const ARABIAN_BUSINESS_URL =
  'https://www.arabianbusiness.com/business/technology/exclusive-anghami-co-founders-ai-tool-tracking-global-crises-draws-millions-of-users';

/** Charlie Warzel, "Doomscrolling Is Over", 2026-03-14. */
export const THE_ATLANTIC_URL =
  'https://www.theatlantic.com/technology/2026/03/world-monitor-situation-meme/686389/';

/** Selva Vargas Reategui, 2026-03-16 (Tecnologia). */
export const EL_PAIS_URL =
  'https://elpais.com/tecnologia/2026-03-16/el-riesgo-de-seguir-en-directo-el-conflicto-de-oriente-proximo-en-plataformas-hechas-con-ia-hacen-que-parezca-casi-como-un-videojuego.html';

export const GITHUB_REPO_URL = 'https://github.com/koala73/worldmonitor';

/** shields.io badge that reads stargazers_count from the GitHub API. */
export const GITHUB_STARS_BADGE_URL =
  'https://img.shields.io/github/stars/koala73/worldmonitor';

export const GITHUB_STARGAZERS_URL = `${GITHUB_REPO_URL}/stargazers`;

export const ABOUT_DOCS_PATH = '/docs/about';

/** Canonical reach figures — every public surface must agree. */
export const USERS_CLAIM = '2M+';
export const COUNTRY_REACH_CLAIM = '190+';

export type PressLink = Readonly<{ label: string; url: string }>;

/** Press row for footers and agent briefings (order: WIRED first). */
export const PRESS_LINKS: ReadonlyArray<PressLink> = [
  { label: 'WIRED', url: WIRED_FEATURE_URL },
  { label: 'The Atlantic', url: THE_ATLANTIC_URL },
  { label: 'El Pais', url: EL_PAIS_URL },
  { label: 'Economic Times', url: ECONOMIC_TIMES_URL },
  { label: 'Arabian Business', url: ARABIAN_BUSINESS_URL },
  { label: 'Entrepreneur ME', url: ENTREPRENEUR_ME_URL },
  { label: 'Silicon Canals', url: SILICON_CANALS_2M_URL },
  { label: "L'Orient Today", url: LORIENT_TODAY_URL },
];
