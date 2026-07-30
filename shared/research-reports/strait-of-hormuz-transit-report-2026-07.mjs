// Report definition for the July 2026 Strait of Hormuz transit report — the
// pilot of the /research/ report family (issue #5668).
//
// This file is the versioned editorial contract for one report edition: page
// metadata, layer-labelled prose, named sources, and limitations. Quantitative
// values are NEVER hand-written here — prose references computed metrics as
// `{{m:<metricId>}}` tokens, which scripts/build-research-reports.mjs resolves
// from the committed snapshot named below. An unresolved token fails the build
// (fail closed), so published numbers cannot drift from the data.
//
// Evidence layers follow the #5668 contract: observed transport data, derived
// analysis, and news context stay separately labelled and are never blended
// into a combined score. Layers this edition does not collect are declared in
// `layersNotCovered` and rendered as explicit gaps, not omissions.

export const REPORT = {
  schemaVersion: 1,
  id: 'strait-of-hormuz-transit-report-2026-07',
  slug: 'strait-of-hormuz-transit-report-2026-07',
  series: 'chokepoint-transit',
  edition: '2026-07',
  version: '1.0.0',
  title: 'Strait of Hormuz Transit Report — July 2026',
  metaTitle: 'Strait of Hormuz Transit Report: July 2026 Traffic Data',
  // {{m:...}} tokens resolve to computed values here too (plain text, no
  // markup) so the meta description, JSON-LD, and lede can never disagree
  // with the data the way hand-written numbers can.
  description:
    'Strait of Hormuz transits are down {{m:declinePct}} since the March 2026 closure — {{m:disruptionDailyAvg}} ships/day since March 1 versus {{m:sameWindow2025DailyAvg}} in the same 2025 window — with July at about {{m:julVsFebShare}} of the February baseline, from IMF PortWatch daily data.',
  disruptionStart: '2026-03-01',
  author: {
    name: 'World Monitor Research',
    url: 'https://www.worldmonitor.app/',
  },
  datePublished: '2026-07-27',
  dateModified: '2026-07-27',
  snapshotPath: 'docs/snapshots/chokepoint-transit-2026-07.json',
  focusChokepointId: 'hormuz_strait',
  contextChokepointIds: ['bab_el_mandeb', 'suez', 'cape_of_good_hope'],

  // Why this topic: the evidence trail required by #5668 AC#1, kept in the
  // published report so readers can audit the selection logic itself.
  topicJustification: [
    'Issue #5667 recorded a 2026-07-26 spot check in which World Monitor was absent from returned results for “Strait of Hormuz live traffic tracker” — the exact reviewed query q07 in the visibility baseline (use-case intent, chokepoints page family, IMF PortWatch as named source).',
    'The 2026-07-27 visibility baseline shows the category query already earning AI citations (4/4 platform mentions, 3/4 direct) while use-case queries have no observed visibility, so the next authority asset belongs on a use-case surface.',
    'The baseline’s expansion gate allows at most one evidence-rich report experiment before credentialed demand data arrives; this pilot is that single experiment.',
  ],

  layersNotCovered: [
    {
      layer: 'Official statements',
      note: 'Primary-source government and IRGC statements are not independently collected in this edition; the timeline relies on the named third-party reporting below.',
    },
    {
      layer: 'Market context',
      note: 'Freight rates, war-risk insurance premia, and energy prices are not collected in this edition. No market claim in this report should be inferred from transit counts alone.',
    },
  ],

  // News-context layer: every entry was retrieved and read on the stated date.
  // Claims here are attributed to their source and are NOT World Monitor
  // observations.
  newsContext: [
    {
      claim:
        'IMF PortWatch’s disruptions database lists event “HORMUZ-26” (alert level RED, event type “other”) affecting the Strait of Hormuz chokepoint, with a start date of 2026-03-01 and no end date.',
      source: 'IMF PortWatch disruptions database (ArcGIS portwatch_disruptions_database)',
      url: 'https://portwatch.imf.org/',
      sourceDate: '2026-03-01',
      retrievedAt: '2026-07-27',
    },
    {
      claim:
        'CSIS reports the disruption began on 2026-03-02 following U.S. and Israeli strikes on Iran, that Iran declared the strait open on 2026-04-17 with the IRGC reversing course on 2026-04-18, and that the strait carries roughly a quarter of global oil flows.',
      source: 'CSIS, “The Strait of Hormuz in 8 Charts” (published 2026-04-22)',
      url: 'https://www.csis.org/analysis/strait-hormuz-8-charts',
      sourceDate: '2026-04-22',
      retrievedAt: '2026-07-27',
    },
    {
      claim:
        'The independent tracker straits.live counted 99 tankers “running dark” (transmitting no AIS) in the region and cautions that AIS-based transit counts may understate true flow.',
      source: 'straits.live independent Hormuz tracker',
      url: 'https://straits.live/',
      sourceDate: '2026-07-27',
      retrievedAt: '2026-07-27',
    },
  ],

  // Prose sections. `layer` labels the evidence type per the #5668 contract.
  // Special blocks (stats, charts, context table, downloads, provenance) are
  // rendered by the generator at the positions marked with `block`.
  sections: [
    {
      id: 'summary',
      heading: 'Direct answer',
      layer: 'derived',
      paragraphs: [
        'Is the Strait of Hormuz open? Commercial transit has partially resumed but remains far below normal. Between 2026-03-01 and {{m:observationEnd}}, IMF PortWatch recorded {{m:disruptionTransits}} vessel transits — a daily average of {{m:disruptionDailyAvg}} against {{m:sameWindow2025DailyAvg}} in the same 2025 window, a {{m:declinePct}} decline. July traffic to date averages {{m:julToDateAvgTotal}} transits per day, about {{m:julVsFebShare}} of the February 2026 pre-disruption baseline.',
        'This report quantifies the collapse and partial recovery using daily AIS-derived transit counts, keeps observed data separate from third-party event reporting, and documents exactly what this data cannot show — including vessels transiting with AIS transmitters off.',
      ],
    },
    { id: 'key-figures', heading: 'Key figures', layer: 'derived', block: 'stats' },
    {
      id: 'observed',
      heading: 'What the observed data shows',
      layer: 'observed',
      block: 'charts',
      paragraphs: [
        'Through February 2026, Hormuz transit levels were unremarkable: {{m:febAvgTotal}} transits per day in February against a {{m:avg2025Total}} full-year 2025 average. The series breaks on 2026-03-01 ({{m:mar1Total}} transits) and collapses from 2026-03-02, averaging {{m:marAvgTotal}} per day for March — including {{m:marZeroDays}} days with zero AIS-observed transits. Across the full window since 2026-03-01 there have been {{m:zeroTransitDays}} zero-transit days; the preceding seven years of the series contain none (the pre-collapse daily minimum was {{m:preCollapseMinTotal}}).',
        'Recovery has been partial and uneven: {{m:aprAvgTotal}} per day in April, {{m:mayAvgTotal}} in May, {{m:junAvgTotal}} in June, and {{m:julToDateAvgTotal}} for 2026-07-01 through {{m:observationEnd}}. The strongest single day since the collapse was {{m:peakRecoveryDate}} with {{m:peakRecoveryTotal}} transits — still {{m:peakVsFebNote}} below the February daily average. The final week of the observation window averaged {{m:last7Avg}} transits per day, lower than the preceding week, so the series gives no basis to describe the recovery as steadily improving.',
        'Tanker traffic collapsed hardest. June 2026 averaged {{m:junAvgTanker}} tanker transits per day against {{m:jun25AvgTanker}} in June 2025, and aggregate transiting tanker capacity fell from {{m:febAvgTankerDwtM}} million DWT per day in February to {{m:junAvgTankerDwtM}} million in June.',
      ],
    },
    {
      id: 'context',
      heading: 'Other chokepoints in the same window',
      layer: 'observed',
      block: 'context-table',
      paragraphs: [
        'The Hormuz collapse is not visible in the neighbouring corridors. Bab el-Mandeb and Suez continue at the depressed levels that have persisted since the 2023–24 Red Sea crisis, and Cape of Good Hope diversion traffic remains elevated but flat. Any rerouting associated with the Hormuz disruption does not appear as a level change in these three series during this window.',
      ],
    },
    {
      id: 'timeline',
      heading: 'Event context from named sources',
      layer: 'news',
      block: 'news-context',
      paragraphs: [
        'World Monitor does not independently verify the events below; they are third-party reporting, listed with source and dates, and kept separate from the observed transit data above.',
      ],
    },
    {
      id: 'methodology',
      heading: 'Methodology',
      layer: 'methodology',
      paragraphs: [
        'All transit figures derive from one source: IMF PortWatch daily chokepoint transit calls (portwatch.imf.org, based on UN Global Platform AIS data), retrieved on {{m:capturedAtDate}} from the public PortWatch ArcGIS service and frozen into the versioned snapshot named below. A transit call is an AIS-observed passage; vessel classes (tanker, container, dry bulk, general cargo, ro-ro) and deadweight-tonnage aggregates are PortWatch fields, not World Monitor estimates.',
        'Derived figures are arithmetic over that series only — period averages, sums, and percentage comparisons, each documented in the provenance table below. No smoothing, interpolation, forecasting, or cross-source blending is applied. Missing days would be listed explicitly rather than filled; this snapshot has {{m:missingDatesTotal}} missing days across all four series. The report page is rebuilt deterministically from the committed snapshot, so every figure can be recomputed from the published data files.',
      ],
    },
    {
      id: 'limitations',
      heading: 'Limitations and known gaps',
      layer: 'methodology',
      paragraphs: [
        'AIS undercount: PortWatch counts AIS-broadcasting passages. In a conflict zone with GPS interference and deliberate transponder shutdowns, physical transits can exceed AIS-observed transits by an unknown margin; an independent tracker counted 99 tankers in the region transmitting no AIS on 2026-07-27. The published counts are therefore a lower bound on total transit activity, not a measurement of total physical flow.',
        'Publication lag: the PortWatch series ended at {{m:observationEnd}} when retrieved on {{m:capturedAtDate}} — an eight-day lag. This report does not estimate the missing days. Upstream revisions: PortWatch may revise history; this edition is pinned to its retrieval snapshot and states its retrieval time precisely so revisions are detectable.',
        'July 2026 figures cover 2026-07-01 through {{m:observationEnd}} only and are labelled partial wherever they appear. Official statements and market context are out of scope for this edition, as declared above.',
      ],
    },
    { id: 'downloads', heading: 'Download the data', layer: 'data', block: 'downloads' },
    { id: 'provenance', heading: 'Figure provenance', layer: 'methodology', block: 'provenance' },
    { id: 'citation', heading: 'Cite this report', layer: 'methodology', block: 'citation' },
    { id: 'live', heading: 'Track this live', layer: 'product', block: 'live-handoff' },
  ],

};
