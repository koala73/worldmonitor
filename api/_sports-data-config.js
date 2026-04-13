const RAW_SPORTS_DATA_PROVIDERS = Object.freeze({
  thesportsdb: {
    baseUrl: 'https://www.thesportsdb.com/api/v1/json/123',
    endpointTtls: Object.freeze({
      '/all_leagues.php': 6 * 60 * 60,
      '/lookupleague.php': 60 * 60,
      '/search_all_seasons.php': 60 * 60,
      '/lookuptable.php': 10 * 60,
      '/eventslast.php': 10 * 60,
      '/eventsnext.php': 5 * 60,
      '/eventsday.php': 5 * 60,
      '/lookupevent.php': 2 * 60,
      '/lookupeventstats.php': 10 * 60,
      '/searchvenues.php': 6 * 60 * 60,
      '/searchplayers.php': 30 * 60,
      '/lookupplayer.php': 60 * 60,
    }),
    allowedParams: Object.freeze({
      '/all_leagues.php': [],
      '/lookupleague.php': ['id'],
      '/search_all_seasons.php': ['id'],
      '/lookuptable.php': ['l', 's'],
      '/eventslast.php': ['id'],
      '/eventsnext.php': ['id'],
      '/eventsday.php': ['d', 's'],
      '/lookupevent.php': ['id'],
      '/lookupeventstats.php': ['id'],
      '/searchvenues.php': ['v'],
      '/searchplayers.php': ['p'],
      '/lookupplayer.php': ['id'],
    }),
  },
  espn: {
    baseUrl: 'https://www.espn.com',
    endpointTtls: Object.freeze({
      '/nba/standings': 5 * 60,
    }),
    allowedParams: Object.freeze({
      '/nba/standings': [],
    }),
  },
  espnsite: {
    baseUrl: 'https://site.api.espn.com/apis/site/v2/sports',
    endpointTtls: Object.freeze({
      '/soccer/eng.1/scoreboard': 5 * 60,
      '/soccer/eng.1/summary': 2 * 60,
      '/soccer/uefa.champions/scoreboard': 5 * 60,
      '/soccer/uefa.champions/summary': 2 * 60,
      '/soccer/fifa.world/scoreboard': 10 * 60,
      '/soccer/fifa.world/summary': 2 * 60,
      '/soccer/uefa.euro/scoreboard': 10 * 60,
      '/soccer/uefa.euro/summary': 2 * 60,
      '/soccer/conmebol.america/scoreboard': 10 * 60,
      '/soccer/conmebol.america/summary': 2 * 60,
      '/soccer/conmebol.libertadores/scoreboard': 5 * 60,
      '/soccer/conmebol.libertadores/summary': 2 * 60,
      '/soccer/esp.1/scoreboard': 5 * 60,
      '/soccer/esp.1/summary': 2 * 60,
      '/soccer/ger.1/scoreboard': 5 * 60,
      '/soccer/ger.1/summary': 2 * 60,
      '/soccer/ita.1/scoreboard': 5 * 60,
      '/soccer/ita.1/summary': 2 * 60,
      '/soccer/fra.1/scoreboard': 5 * 60,
      '/soccer/fra.1/summary': 2 * 60,
      '/soccer/ned.1/scoreboard': 5 * 60,
      '/soccer/ned.1/summary': 2 * 60,
      '/soccer/por.1/scoreboard': 5 * 60,
      '/soccer/por.1/summary': 2 * 60,
      '/soccer/usa.1/scoreboard': 5 * 60,
      '/soccer/usa.1/summary': 2 * 60,
      '/soccer/mex.1/scoreboard': 5 * 60,
      '/soccer/mex.1/summary': 2 * 60,
      '/soccer/eng.2/scoreboard': 5 * 60,
      '/soccer/eng.2/summary': 2 * 60,
      '/soccer/eng.3/scoreboard': 5 * 60,
      '/soccer/eng.3/summary': 2 * 60,
      '/soccer/sco.1/scoreboard': 5 * 60,
      '/soccer/sco.1/summary': 2 * 60,
      '/soccer/arg.1/scoreboard': 5 * 60,
      '/soccer/arg.1/summary': 2 * 60,
      '/basketball/nba/standings': 5 * 60,
      '/basketball/nba/scoreboard': 2 * 60,
      '/basketball/nba/summary': 90,
      '/hockey/nhl/scoreboard': 2 * 60,
      '/hockey/nhl/summary': 2 * 60,
      '/baseball/mlb/scoreboard': 2 * 60,
      '/baseball/mlb/summary': 2 * 60,
      '/football/nfl/scoreboard': 2 * 60,
      '/football/nfl/summary': 2 * 60,
    }),
    allowedParams: Object.freeze({
      '/soccer/eng.1/scoreboard': ['dates'],
      '/soccer/eng.1/summary': ['event'],
      '/soccer/uefa.champions/scoreboard': ['dates'],
      '/soccer/uefa.champions/summary': ['event'],
      '/soccer/fifa.world/scoreboard': ['dates'],
      '/soccer/fifa.world/summary': ['event'],
      '/soccer/uefa.euro/scoreboard': ['dates'],
      '/soccer/uefa.euro/summary': ['event'],
      '/soccer/conmebol.america/scoreboard': ['dates'],
      '/soccer/conmebol.america/summary': ['event'],
      '/soccer/conmebol.libertadores/scoreboard': ['dates'],
      '/soccer/conmebol.libertadores/summary': ['event'],
      '/soccer/esp.1/scoreboard': ['dates'],
      '/soccer/esp.1/summary': ['event'],
      '/soccer/ger.1/scoreboard': ['dates'],
      '/soccer/ger.1/summary': ['event'],
      '/soccer/ita.1/scoreboard': ['dates'],
      '/soccer/ita.1/summary': ['event'],
      '/soccer/fra.1/scoreboard': ['dates'],
      '/soccer/fra.1/summary': ['event'],
      '/soccer/ned.1/scoreboard': ['dates'],
      '/soccer/ned.1/summary': ['event'],
      '/soccer/por.1/scoreboard': ['dates'],
      '/soccer/por.1/summary': ['event'],
      '/soccer/usa.1/scoreboard': ['dates'],
      '/soccer/usa.1/summary': ['event'],
      '/soccer/mex.1/scoreboard': ['dates'],
      '/soccer/mex.1/summary': ['event'],
      '/soccer/eng.2/scoreboard': ['dates'],
      '/soccer/eng.2/summary': ['event'],
      '/soccer/eng.3/scoreboard': ['dates'],
      '/soccer/eng.3/summary': ['event'],
      '/soccer/sco.1/scoreboard': ['dates'],
      '/soccer/sco.1/summary': ['event'],
      '/soccer/arg.1/scoreboard': ['dates'],
      '/soccer/arg.1/summary': ['event'],
      '/basketball/nba/standings': [],
      '/basketball/nba/scoreboard': ['dates'],
      '/basketball/nba/summary': ['event'],
      '/hockey/nhl/scoreboard': ['dates'],
      '/hockey/nhl/summary': ['event'],
      '/baseball/mlb/scoreboard': ['dates'],
      '/baseball/mlb/summary': ['event'],
      '/football/nfl/scoreboard': ['dates'],
      '/football/nfl/summary': ['event'],
    }),
  },
  jolpica: {
    baseUrl: 'https://api.jolpi.ca',
    endpointTtls: Object.freeze({
      '/ergast/f1/current/driverStandings.json': 5 * 60,
      '/ergast/f1/current/constructorStandings.json': 5 * 60,
      '/ergast/f1/current/last/results.json': 5 * 60,
      '/ergast/f1/current/next.json': 30 * 60,
    }),
    allowedParams: Object.freeze({
      '/ergast/f1/current/driverStandings.json': [],
      '/ergast/f1/current/constructorStandings.json': [],
      '/ergast/f1/current/last/results.json': [],
      '/ergast/f1/current/next.json': [],
    }),
  },
  openf1: {
    baseUrl: 'https://api.openf1.org',
    endpointTtls: Object.freeze({
      '/v1/drivers': 6 * 60 * 60,
    }),
    allowedParams: Object.freeze({
      '/v1/drivers': ['session_key'],
    }),
  },
});

const PROVIDER_KEYS = Object.freeze(Object.keys(RAW_SPORTS_DATA_PROVIDERS));
const PROVIDER_KEY_SET = new Set(PROVIDER_KEYS);

function createProviderConfig(rawProvider) {
  const endpointTtls = Object.freeze({ ...rawProvider.endpointTtls });
  const endpointPaths = Object.keys(endpointTtls);
  const allowedParamsEntries = Object.entries(rawProvider.allowedParams);
  const allowedPaths = allowedParamsEntries.map(([path]) => path);

  if (allowedPaths.length !== endpointPaths.length || !endpointPaths.every((path) => allowedPaths.includes(path))) {
    throw new Error('Sports proxy config mismatch between endpoint TTLs and allowed parameter paths');
  }

  const allowedParams = Object.freeze(Object.fromEntries(
    allowedParamsEntries.map(([path, params]) => [path, new Set(params)]),
  ));

  return Object.freeze({
    baseUrl: rawProvider.baseUrl,
    endpointTtls,
    endpoints: new Set(endpointPaths),
    allowedParams,
  });
}

export function createSportsDataProviders() {
  return Object.freeze(Object.fromEntries(
    Object.entries(RAW_SPORTS_DATA_PROVIDERS).map(([providerKey, provider]) => [providerKey, createProviderConfig(provider)]),
  ));
}

export function isSportsProvider(providerKey) {
  return typeof providerKey === 'string' && PROVIDER_KEY_SET.has(providerKey);
}

export function getSportsProviderKeys() {
  return [...PROVIDER_KEYS];
}
