# Peru RSS Feed Candidates

## Summary

This document proposes Peru-focused RSS feed candidates that could expand World Monitor's LATAM coverage across politics, economy, regional events, technology, infrastructure, and public-interest news.

This proposal is documentation-only. It does not add live feeds to the application and does not modify feed configuration files.

## Selection Criteria

Candidate feeds should be reviewed against the following criteria before implementation:

1. Feed availability and technical stability.
2. Editorial reliability and update frequency.
3. Clear category mapping.
4. Attribution requirements.
5. Language and regional relevance.
6. Risk of duplicate content.
7. Source tier classification.
8. State affiliation or propaganda-risk labeling, when applicable.

## Recommended Categories

| Category | Purpose |
|---|---|
| Politics | National political developments and government signals |
| Economy | Macroeconomic, business and markets coverage |
| Regional | Local incidents, infrastructure disruptions and regional alerts |
| Technology | Technology, cybersecurity and digital transformation coverage |
| World | International events relevant to Peru and LATAM |
| Public Safety | Events with operational impact, transport, incidents and emergencies |

## High-Priority Official / Institutional Feeds

### Agencia Andina

Agencia Andina is a high-priority candidate because it provides official public-interest coverage and has dedicated RSS channels.

Candidate feeds:

```text
http://www.andina.com.pe/rss/AndinaPolitica.xml
http://www.andina.com.pe/rss/AndinaEconomia.xml
http://www.andina.com.pe/rss/AndinaRegionales.xml
http://www.andina.com.pe/rss/AndinaLocales.xml
```

Suggested mapping:

| Feed | Category | Suggested Source Tier |
|---|---|---:|
| Andina Politica | politics | 2 |
| Andina Economia | economy | 2 |
| Andina Regionales | regional | 2 |
| Andina Locales | regional | 2 |

Notes:

- State-affiliated source.
- Useful for official narratives, government signals and regional reporting.
- Should be labeled clearly as official/state media.

## High-Priority Business / Economy Feeds

### Gestion

Gestion is a strong candidate for Peru business, markets, economy and technology coverage.

Candidate feeds to validate:

```text
https://gestion.pe/arc/outboundfeeds/rss/category/economia/?outputType=xml
https://gestion.pe/arc/outboundfeeds/rss/category/tecnologia/?outputType=xml
https://gestion.pe/arc/outboundfeeds/rss/category/mundo/?outputType=xml
```

Suggested mapping:

| Feed | Category | Suggested Source Tier |
|---|---|---:|
| Gestion Economia | economy | 2 |
| Gestion Tecnologia | technology | 2 |
| Gestion Mundo | world | 2 |

## High-Priority General News Feeds

### El Comercio Peru

El Comercio is a candidate for national coverage, economy, Peru, politics and world events.

Candidate feeds to validate:

```text
https://elcomercio.pe/arcio/rss/
https://elcomercio.pe/arcio/rss/category/politica/
https://elcomercio.pe/arcio/rss/category/economia/
https://elcomercio.pe/arcio/rss/category/peru/
https://elcomercio.pe/arcio/rss/category/mundo/
https://elcomercio.pe/arcio/rss/category/tecnologia/
```

Suggested mapping:

| Feed | Category | Suggested Source Tier |
|---|---|---:|
| El Comercio Politica | politics | 2 |
| El Comercio Economia | economy | 2 |
| El Comercio Peru | regional | 2 |
| El Comercio Mundo | world | 2 |
| El Comercio Tecnologia | technology | 2 |

## Additional Candidates Requiring Validation

### RPP

RPP is relevant for national news, regional coverage, technology, public safety and citizen-reported incidents.

Candidate endpoints to validate:

```text
https://rpp.pe/rss
https://rpp.pe/feed
https://rpp.pe/arc/outboundfeeds/rss/
```

Potential categories:

- politics
- national news
- regional events
- technology
- public safety
- citizen reports

### Regional / Local Candidates

Regional feeds can improve early detection of transport disruptions, floods, protests, public safety events and local emergencies.

Candidates to validate:

```text
https://elbuho.pe/feed
https://lahora.pe/feed
https://diariovoces.com.pe/feed
https://cronicaviva.com.pe/feed
https://caretas.pe/feed
https://perureports.com/feed
```

Suggested mapping:

| Source | Region / Focus | Potential Category |
|---|---|---|
| El Buho | Southern Peru / Arequipa | regional |
| La Hora | Northern Peru / Piura | regional |
| Diario Voces | Amazon / San Martin | regional |
| Cronica Viva | National / politics | politics |
| Caretas | Politics / analysis | politics |
| Peru Reports | English-language Peru news | world / regional |

## Proposed Validation Workflow

Before adding any feed to a live configuration:

1. Confirm the feed returns valid XML.
2. Confirm article URLs resolve correctly.
3. Confirm titles and descriptions are parsable.
4. Measure update frequency.
5. Check whether the feed duplicates existing sources.
6. Assign source tier.
7. Label state affiliation when applicable.
8. Run the repository feed validation script if feed configuration is modified.

Suggested command after implementation:

```bash
npm run test:feeds
```

## Proposed PR Scope

```text
docs: add Peru RSS feed candidates
```

Documentation-only contribution. No code changes.
