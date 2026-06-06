---
title: "Price a Chokepoint Closure: The Supply Chain Scenario Engine That Quantifies 'What If'"
description: "Model a Strait of Hormuz blockade, Suez closure, or Taiwan Strait crisis with World Monitor's scenario engine. See cost shocks per sector, bypass corridors, and days of delay on a live map."
metaTitle: "Supply Chain Scenario Engine | Chokepoint Closure Cost Calculator"
keywords: "supply chain scenario planning, chokepoint closure impact, Strait of Hormuz blockade cost, supply chain risk calculator, shipping disruption cost model, maritime chokepoint analysis, bypass corridor intelligence, trade route risk assessment, supply chain stress test"
audience: "Supply chain managers, procurement directors, commodity traders, risk analysts, logistics planners, reinsurance analysts, policy researchers"
heroImage: "/blog/images/blog/supply-chain-scenario-engine-chokepoint-closure-cost.jpg"
pubDate: "2026-04-18"
---

> **Summary:** World Monitor's Scenario Engine lets you model the cost of closing any major maritime chokepoint. Pick a corridor, set a duration, and see the dollar impact per sector, the bypass corridors that absorb overflow, and the countries most exposed. Pre-built templates cover Hormuz, Suez, Taiwan Strait, Panama, and Russian grain routes.

Right now, [World Monitor's live chokepoint tracker](https://worldmonitor.app) shows elevated disruption scores across multiple corridors. The question supply chain teams are asking is not *if* a chokepoint closes. It is *what does it cost when it does*.

Everyone in shipping, energy, and geopolitics asks "what happens if the Strait of Hormuz closes?" Most answers are qualitative: "oil prices would spike," "shipping costs would increase," "global trade would be disrupted." These answers are correct and useless. A procurement director cannot hedge against "disrupted." They need a number.

World Monitor's **Global Shipping Intelligence** panel now includes a scenario engine that turns "what if" into a quantified cost shock with sector-level granularity, bypass corridor modeling, and a live map visualization. For background on the live chokepoint monitoring that feeds this engine, see [Tracking Global Trade Routes, Chokepoints, and Freight Costs](/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/).

## Five Pre-Built Scenarios, Infinite Custom Ones

The scenario engine ships with five geopolitically realistic templates, each calibrated against historical precedents and live traffic data:

| Scenario | Blockage | Duration | Cost Multiplier | Key Impact |
|----------|----------|----------|-----------------|------------|
| **Hormuz Tanker Blockade** | 100% | 14 days | 2.10x | Persian Gulf crude, LNG to Asia |
| **Taiwan Strait Full Closure** | 100% | 30 days | 1.45x | Semiconductor supply, trans-Pacific trade |
| **Suez + Bab el-Mandeb Simultaneous** | 80% | 60 days | 1.35x | Europe-Asia container trade |
| **Panama Drought Restriction** | 50% capacity | 90 days | 1.22x | US East Coast imports, grain exports |
| **Russia Grain Suspension** | Sanctions-driven | 180 days | Variable | Cereals, oilseeds, fertilizer |

Each template specifies the affected chokepoints, the disruption percentage, duration, impacted HS2 trade sectors, and a cost-shock multiplier derived from historical disruption data and rerouting cost analysis.

But the templates are starting points. You can adjust every parameter:

- **Chokepoints affected**: Select one or multiple corridors
- **Disruption percentage**: From partial restriction (30%) to full closure (100%)
- **Duration**: Days, weeks, or months
- **Sectors impacted**: Filter to specific HS2 product categories
- **Cost multiplier**: Override the default based on your own intelligence

## How the Cost Shock Calculator Works

When you run a scenario, the engine computes a cost shock by combining three data layers:

### 1. Live Chokepoint Flow Data

The engine uses **IMF PortWatch** vessel transit data, calibrated by **deadweight tonnage (DWT)**, not just vessel count. This distinction matters. A VLCC carrying 300,000 tonnes of crude is not the same as a coastal feeder carrying 5,000 tonnes of general cargo. Flow-weighted pre-computation means the cost shock reflects what *actually* moves through the corridor, not how many ships transit it.

Each chokepoint has a live baseline calculated from the trailing 30-day average, with seasonal adjustment. When you model a closure, the engine measures the gap between baseline flow and zero (or whatever disruption percentage you set).

### 2. Bypass Corridor Intelligence

Closing a chokepoint does not eliminate trade. It reroutes it. The cost shock is not the lost cargo; it is the *added cost* of the alternative path.

For each scenario, the engine identifies the available bypass corridors and their characteristics:

- **Hormuz closure**: Cape of Good Hope reroute adds 10-15 days for Asia-bound crude. Existing pipeline capacity through Saudi Arabia (East-West Pipeline) can absorb some, but not all, crude flow.
- **Suez closure**: Cape of Good Hope reroute adds 8-12 days for Europe-Asia container trade. No pipeline alternative for containerized goods.
- **Taiwan Strait**: Rerouting south of Taiwan adds 2-3 days but creates congestion in the Luzon Strait. Air freight is viable for high-value semiconductors but at 10-50x the cost.
- **Panama restrictions**: Suez + Mediterranean routing is viable for US East Coast traffic but adds 5-8 days and crosses the Bab el-Mandeb risk zone.

The engine models bypass capacity constraints. The Cape of Good Hope can absorb rerouted traffic, but port congestion in Cape Town and Durban creates a secondary bottleneck that the cost multiplier accounts for.

### 3. Sector-Level Trade Exposure

Not every sector is equally exposed. The engine breaks down the impact by **HS2 trade category** (the international Harmonized System used to classify traded goods):

- **Mineral fuels (HS 27)**: Overwhelmingly Hormuz-dependent. A 14-day closure affects 20% of global crude and 25% of LNG.
- **Electrical machinery (HS 85)**: Taiwan Strait concentration. Includes semiconductors, integrated circuits, and components with no short-term substitutes.
- **Vehicles (HS 87)**: Suez-dependent for Europe-Asia automotive supply chains. Just-in-time manufacturing amplifies any delay.
- **Cereals (HS 10)**: Black Sea and Panama-dependent. Russia's grain export routes through the Turkish Straits and Kerch are geopolitically fragile.

For each sector, the engine shows **which countries** are most exposed based on their bilateral trade flows through the affected corridor. A Hormuz closure hits South Korea and Japan differently than it hits the United States, because their import dependency ratios differ.

## On the Map: Animated Trade Routes and Disruption Arcs

The scenario engine is not just a spreadsheet calculation. It renders on the World Monitor map.

**Animated trade route trails** show how traffic actually flows through each chokepoint in normal conditions, rendered as moving particle trails along the shipping lane. When you activate a scenario, the animation shifts to show the rerouted flow: the Hormuz trail goes dark, and the Cape of Good Hope trail lights up with increased density.

**Disruption-score arc coloring** paints each route segment on a gradient from green (normal flow) to red (high disruption). Click any arc to see a detailed breakdown: vessel type composition, cargo categories, estimated daily value of goods transiting, and the specific bypass corridor that would absorb this flow.

**Pulsing chokepoint markers** indicate active risk levels. A chokepoint with a current disruption score above 70% pulses red on the map. Clicking the marker opens the transit chart: a stacked vessel-type visualization with a 7-day moving average, split between tanker and cargo traffic, with a DWT tab for tonnage-weighted analysis and zoom controls for historical comparison.

The animated trails are impossible to convey in a blog post. Open the Supply Chain panel, run the Hormuz scenario, and watch the particle trails shift in real time. It takes 30 seconds.

## A Worked Example: You Are a Japanese Refiner

You are the procurement director at a Japanese refinery that imports 80% of its crude from the Persian Gulf. Your CEO asks: "What does a Hormuz blockade cost us?"

1. **Open the scenario engine.** Select the "Hormuz Tanker Blockade" template: 100% blockage, 14 days.
2. **Read the cost shock.** Crude oil: 2.10x cost multiplier. Your $70/bbl feedstock is now priced at $147/bbl on the spot market. LNG: 1.95x. Your gas-fired backup generators cost nearly double to run.
3. **Check the bypass.** The Cape of Good Hope reroute adds 12 days. Your next scheduled cargo, currently in the Gulf of Oman, will arrive 12 days late. You have 23 days of crude stock. After day 12, you start drawing down.
4. **Assess alternatives.** The engine suggests West African crude (Nigeria, Angola) via Cape of Good Hope, no chokepoint exposure, different crude grade. US shale exports via the Atlantic, 18-day transit. Both have higher freight costs but arrive without Hormuz risk.
5. **Check the probability.** Switch to the [prediction markets panel](/blog/posts/prediction-markets-ai-forecasting-geopolitics/). Polymarket prices a full Hormuz closure at X% over 90 days. The military posture panel shows current naval deployments in the corridor.

You now have a number for your CEO, a backup plan for your traders, and a probability estimate for your risk committee. The scenario took 90 seconds to run.

## The Multi-Sector Cost Shock Calculator

For supply chain planners who manage multi-sector procurement, the **cost shock calculator** provides a consolidated view:

1. Select a scenario (or build a custom one)
2. Set the closure duration with the slider
3. See the per-sector cost impact displayed as a heat table:

| Sector | Normal Cost Index | Disrupted Cost Index | Increase | Days Added |
|--------|------------------|---------------------|----------|------------|
| Crude Oil | 100 | 210 | +110% | 12 |
| LNG | 100 | 195 | +95% | 14 |
| Container (General) | 100 | 135 | +35% | 10 |
| Dry Bulk (Grain) | 100 | 122 | +22% | 8 |
| Chemicals | 100 | 155 | +55% | 11 |

*Example output for a 14-day Hormuz full closure scenario. Actual values are computed from live flow data.*

The calculator accounts for the non-linearity of disruption costs. A 7-day closure is not half the cost of a 14-day closure, because inventory buffers absorb the first few days and depletion accelerates after day 5-7. The cost curve steepens as existing stocks are drawn down and spot-market premiums compound.

## Alternative Supplier Risk Assessment

When a chokepoint closes, the immediate question is "who else can supply what we need?" The scenario engine includes an **alternative supplier assessment** that:

1. Identifies which countries currently supply each affected product through the disrupted corridor
2. Lists alternative suppliers whose routes do *not* cross the disrupted chokepoint
3. Scores each alternative by its own chokepoint exposure (to avoid replacing one concentration risk with another)
4. Shows the price premium of switching, based on freight rate differentials

For example, if Hormuz closes and your firm imports crude from Saudi Arabia:

- **Alternative 1**: West African crude (Nigeria, Angola) via Cape of Good Hope. No chokepoint exposure, but higher freight cost and different crude grade.
- **Alternative 2**: US shale exports via Atlantic. No chokepoint exposure, competitive on price, but limited tanker availability in a surge scenario.
- **Alternative 3**: Pre-positioned Saudi crude via the East-West Pipeline to Yanbu (Red Sea). Avoids Hormuz, but pipeline capacity caps throughput.

The assessment is route-aware: it traces the full path from supplier to your import destination and flags any intermediate chokepoints. A supplier that routes through Bab el-Mandeb is not a safe alternative when Suez is also disrupted.

## Who Needs This

**Procurement directors** run Hormuz and Taiwan scenarios quarterly to stress-test their supplier portfolios. The output feeds into dual-sourcing decisions and safety-stock calculations.

**Commodity traders** use the cost-shock multipliers to price disruption optionality. When Hormuz tensions rise, the scenario output quantifies the expected freight premium and helps calibrate spread positions.

**Reinsurance analysts** use the sector-level exposure data to model portfolio concentration in maritime chokepoint risk. The per-country breakdown maps directly to exposure assessment.

**Policy researchers** use the scenario templates to brief legislators on the economic cost of military escalation. "A 14-day Hormuz blockade imposes a 2.1x cost multiplier on crude imports for Japan" is more useful than "Hormuz is important."

**Logistics planners** use the bypass corridor intelligence to pre-negotiate rerouting contracts. Knowing that a Cape of Good Hope reroute adds 12 days and creates Cape Town congestion means you can pre-position vessel bookings before the disruption happens.

## From "What If" to "What Now"

The scenario engine connects to every other intelligence layer in World Monitor. When you model a Hormuz closure:

- The **chokepoint panel** shows the [current live disruption score](/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/) (is it already elevated?)
- The **energy panel** shows SPR levels and days-of-cover for affected importers
- The **freight indices** (BDI, SCFI, BCI) show whether markets are already pricing in disruption
- The **military posture** panel shows whether naval deployments suggest escalation
- The **prediction markets** panel shows what [bettors think](/blog/posts/prediction-markets-ai-forecasting-geopolitics/) about the probability of the scenario you are modeling
- The **[AI analyst](/blog/posts/ai-geopolitical-analyst-chat-market-signals/)** can explain the transmission chain from corridor closure to specific market impacts
- The **[country resilience scores](/blog/posts/country-resilience-score-risk-index-methodology/)** show which affected importers have the structural capacity to absorb the shock

The scenario is not isolated. It sits inside a live intelligence context that tells you how likely your "what if" actually is, and how well each affected country can handle it.

## Frequently Asked Questions

**Is the scenario engine free?**
The basic supply chain panel and chokepoint monitoring are free for all users. The full scenario engine with custom parameters, bypass corridor intelligence, and the cost shock calculator is a PRO feature.

**Where does the flow data come from?**
Vessel transit counts come from IMF PortWatch, calibrated by deadweight tonnage. The baseline is a trailing 30-day average with seasonal adjustment. Freight indices come from the Baltic Exchange, Shanghai Shipping Exchange, and FRED.

**Can I model multiple simultaneous closures?**
Yes. The Suez + Bab el-Mandeb template is an example of a multi-chokepoint scenario. You can combine any set of corridors in a custom scenario.

**How accurate are the cost multipliers?**
The multipliers are derived from historical disruption data (Suez blockage 2021, Red Sea rerouting 2024, Hormuz tensions 2019) and adjusted for current freight market conditions. They represent central estimates with significant uncertainty, especially for unprecedented scenarios like a full Taiwan Strait closure.

**Can I export scenario results?**
PRO users can export scenario analysis. The output includes per-sector cost tables, bypass corridor options, and country-level exposure rankings.

**How often is the baseline flow data updated?**
PortWatch vessel transit data updates every 2 hours. Freight indices update daily. The baseline recalculates on each query to reflect current conditions.

---

**Open the Supply Chain panel at [worldmonitor.app](https://worldmonitor.app), click Scenarios, and run the Hormuz scenario. The per-sector cost table takes 30 seconds to generate. You will have a number for your next risk committee meeting before you finish your coffee.**
