# Phase 7 — China industrial-cluster export explorer evidence

**Scope:** Native `/china-factory` UI, source/HS registry boundary, aggregate
trade filter isolation, truthful no-provider display and Phase 7 gates.

## Delivered surface

- Added the native scrollable China Factory workspace and market-panel entry.
- Added 22 reviewed, source-labelled seed records: 20 MIIT 2024 official
  reference clusters plus the requested `huidong-womens-footwear` and
  `putian-licheng-sports-footwear` entries.
- The Huidong and Putian entries use HS 64 with a separate UN Statistics HS
  classification source. The MIIT reference records do **not** claim inferred
  HS mappings and cannot display statistical values until a mapping is reviewed.
- Added a reviewed-import CSV template. Its only sample is visibly
  `example-id`, `.invalid`, `UNVERIFIED` and `statisticsEligible=false`; it is
  not read by production code and cannot become a displayed trade value.

## Source register used by the seed

| Record group | Source | Publisher / publication date | What it supports | What it does not support |
|---|---|---|---|---|
| 20 reference clusters | [MIIT 2024 industrial-cluster notice](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tg/art/2024/art_b83397048d374b0d8c51603f6385d7fa.html?app=mb) | Ministry of Industry and Information Technology; 2024-09-20 | Official recognition/name of the listed clusters | Product/HS code, production quantity, export volume, port, vessel or buyer |
| Huidong women's footwear | [Huidong government report](https://www.huidong.gov.cn/gkmlpt/content/3/3899/mpost_3899559.html) | Huidong Government Office; 2020-06-05 | Huidong women's-footwear cluster context | Its current company-level or shipment-level exports |
| Putian Licheng footwear | [Fujian investment-promotion report](https://fdi.swt.fujian.gov.cn/show-22624.html) | Fujian Investment Promotion Center; 2025-02-06 | Licheng footwear/sports-leisure shoe cluster context | A port, vessel, container, buyer or bill of lading |
| HS 64 footwear mapping | [UN Statistics HS detail, code 64](https://unstats.un.org/unsd/classifications/Econ/Structure/Detail/EN/32/64) | UN Statistics; page publication date not provided | HS 64 product-class mapping | Originating factory, exporter, port, shipment or live trade event |

## Browser acceptance

The local production-equivalent browser page was inspected at 1440×900:

- URL: `http://127.0.0.1:4184/china-factory?cluster=huidong-womens-footwear&period=2024&hs2=64`
- The selected cluster was Huidong women's footwear; the source card displayed
  the official source, its date, administrative scope and the separate HS 64
  mapping. The HS source correctly says `发布日期未提供`, rather than inventing a date.
- The owned workspace computed `overflow-y: auto`, `scrollHeight: 1017` and
  `clientHeight: 900`; it is vertically scrollable rather than trapping content.
- The page visibly stated that no verified trade record, port inference or B/L
  provider record exists. No sample trade number, vessel, container, buyer or
  cargo fact rendered.
- Selecting Putian changed canonical filter state to
  `cluster=putian-licheng-sports-footwear&period=2024&hs2=64` and retained the same
  no-shipment truth boundary.

Screenshot: `phase7-china-factory-huidong-no-provider-1440x900.png`.

## Outcome and limit

This phase is accepted for native UI, documented source/HS boundaries and
fail-closed behaviour. It is **not** a claim that every seed has a full HS
mapping, or that a provider-backed trade, port or B/L dataset is available.
Those value-bearing branches remain unavailable until lawful, independently
documented sources/entitlements return data.
