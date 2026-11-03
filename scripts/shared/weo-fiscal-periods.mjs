// Verified WEO government-finance fiscal periods for the national debt clock.
// A JS module, not JSON: the middleware bundle cannot use import attributes.
export default {
  "weoVintage": "October 2026",
  "sourceUrl": "https://www.imf.org/-/media/files/publications/weo/2026/october/english/statsappendix.pdf#page=13",
  "coverage": "Every Online Table F economy with fiscal-year government finance, except Puerto Rico (a territory the seeder excludes) and Singapore, whose WEO calendar years blend two fiscal years (CY(t) = 0.25*FY(t-1/t) + 0.75*FY(t/t+1)) and so stay on the calendar-year fallback. Table F month ranges alone do not establish the year label: each row cites the WEO METHODOLOGY_NOTES mapping, returned only by a single-country SDMX query with attributes=all, or an IMF staff-report figure matched to the WEO value. Re-verify each row when the WEO vintage changes.",
  "countries": {
    "AFG": {
      "name": "Afghanistan",
      "endMonth": 3,
      "endDay": 20,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/AFG.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'Solar year (March 21 March 20) data are mapped to calendar year such that SY(t/t+1)=CY(t).' Data through 2020 are calendar years."
    },
    "BGD": {
      "name": "Bangladesh",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/BGD.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year July/June."
    },
    "BHS": {
      "name": "The Bahamas",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/BHS.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'Fiscal year data are mapped to calendar year as follows: FY(t-1/t) = CY(t)'; reporting year July/June."
    },
    "BRB": {
      "name": "Barbados",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/BRB.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year April/March."
    },
    "BTN": {
      "name": "Bhutan",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/BTN.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year July/June."
    },
    "BWA": {
      "name": "Botswana",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/BWA.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t/t+1) = CY(t)'; reporting year April/March."
    },
    "DMA": {
      "name": "Dominica",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/DMA.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t/t+1) = CY(t)'; reporting year July/June."
    },
    "EGY": {
      "name": "Egypt",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://www.imf.org/en/news/articles/2026/07/08/tr070826-weo-press-briefing-transcript-july-8-2026",
      "labelEvidence": "The July WEO briefing identifies Egypt's 2026 as fiscal year 2025/26, and WEO METHODOLOGY_NOTES state 'FY(t-1/t) = CY(t)'. October Table F reports July to June for government finance."
    },
    "ETH": {
      "name": "Ethiopia",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/ETH.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'. The note gives no end day, so the row uses Table F's July/June month end."
    },
    "FJI": {
      "name": "Fiji",
      "endMonth": 7,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/FJI.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: Fiji moved to an August/July fiscal year from 2016; 'FY(t/t+1) = CY(t)'."
    },
    "FSM": {
      "name": "Micronesia",
      "endMonth": 9,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/FSM.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year October/September."
    },
    "HKG": {
      "name": "Hong Kong SAR",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://www.imf.org/-/media/files/publications/cr/2025/english/1hkgea2025001-print-pdf.pdf",
      "labelEvidence": "WEO notes give no mapping. IMF Country Report 25/15 puts the FY2023/24 deficit at 5.8 percent of GDP, and its fiscal table (footnote 'Fiscal year begins April 1') shows -5.8 in the 2023 column, so column Y holds the fiscal year starting April of Y."
    },
    "HTI": {
      "name": "Haiti",
      "endMonth": 9,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/HTI.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year October/September."
    },
    "IND": {
      "name": "India",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://www.imf.org/-/media/files/publications/weo/2026/october/english/text.pdf#page=26",
      "labelEvidence": "Table 1.1 footnote 4 places FY2025/26, starting April 2025, in the 2025 column, and WEO METHODOLOGY_NOTES state 'FY(t/t+1) = CY(t)'. October Table F reports April to March for government finance."
    },
    "IRN": {
      "name": "Iran",
      "endMonth": 3,
      "endDay": 20,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/IRN.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'Iranian year starts in March 21 and ends in March 20. Fiscal year data are mapped to calendar year as follows: FY(t/t+1) = CY(t).'"
    },
    "JAM": {
      "name": "Jamaica",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/JAM.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t/t+1)= CY(t)'; reporting year April/March."
    },
    "LCA": {
      "name": "St. Lucia",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/LCA.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year April/March."
    },
    "LSO": {
      "name": "Lesotho",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/LSO.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t/t+1) = CY(t)'; reporting year April/March."
    },
    "MHL": {
      "name": "Marshall Islands",
      "endMonth": 9,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/MHL.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year October/September."
    },
    "MMR": {
      "name": "Myanmar",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/MMR.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; the fiscal year was restored to April/March from FY2021/22."
    },
    "MUS": {
      "name": "Mauritius",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/MUS.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t/t+1) = CY(t)'; the authorities returned to July/June fiscal-year reporting."
    },
    "NPL": {
      "name": "Nepal",
      "endMonth": 7,
      "endDay": 15,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/NPL.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)' and 'Fiscal year starts on July 16th, and ends July 15th the following year.'"
    },
    "NRU": {
      "name": "Nauru",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/NRU.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year July/June."
    },
    "PAK": {
      "name": "Pakistan",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/PAK.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year July/June."
    },
    "PLW": {
      "name": "Palau",
      "endMonth": 9,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/PLW.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year October/September."
    },
    "SWZ": {
      "name": "Eswatini",
      "endMonth": 3,
      "endDay": 31,
      "yearLabel": "start",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/SWZ.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t/t+1) = CY(t)'; reporting year April/March."
    },
    "THA": {
      "name": "Thailand",
      "endMonth": 9,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://www.imf.org/-/media/files/publications/cr/2025/english/1thaea2025001-print-pdf.pdf",
      "labelEvidence": "WEO notes give no mapping. IMF Country Report 25/45 (fiscal year October to September) gives public debt of 41.06, 49.42, 58.34 and 60.52 percent of GDP for FY2019-FY2022; WEO shows 41.06, 49.43, 58.37 and 60.55 for 2019-2022, so column Y holds the fiscal year ending September of Y."
    },
    "TON": {
      "name": "Tonga",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/TON.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year July/June."
    },
    "TTO": {
      "name": "Trinidad and Tobago",
      "endMonth": 9,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/TTO.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year October/September."
    },
    "WSM": {
      "name": "Samoa",
      "endMonth": 6,
      "endDay": 30,
      "yearLabel": "end",
      "labelSourceUrl": "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/WSM.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all",
      "labelEvidence": "WEO METHODOLOGY_NOTES: 'FY(t-1/t) = CY(t)'; reporting year July/June."
    }
  }
};
