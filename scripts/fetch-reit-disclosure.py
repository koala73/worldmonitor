#!/usr/bin/env python3
"""
Fetch C-REIT disclosure data via akshare (EastMoney source).
Outputs JSON to stdout for consumption by seed-reit-disclosure.mjs.

Data per REIT:
  - NAV (单位净值) + date
  - Cumulative NAV (累计净值)
  - Premium/discount vs NAV
  - Dividend history (分红送配)
  - Annual yield from distributions
"""

import akshare as ak
import json
import re
import sys
import time
from datetime import datetime

# 9 C-REITs — must match shared/reits.json china entries
CREIT_CODES = [
    {"code": "180607", "symbol": "180607.SZ", "name": "华夏中海商业REIT"},
    {"code": "180801", "symbol": "180801.SZ", "name": "华夏华润商业REIT"},
    {"code": "508016", "symbol": "508016.SS", "name": "嘉实物美消费REIT"},
    {"code": "180601", "symbol": "180601.SZ", "name": "华夏首创奥莱REIT"},
    {"code": "508027", "symbol": "508027.SS", "name": "华夏华润有巢REIT"},
    {"code": "508058", "symbol": "508058.SS", "name": "中金城投宽庭REIT"},
    {"code": "180401", "symbol": "180401.SZ", "name": "鹏华厦门安居REIT"},
    {"code": "508068", "symbol": "508068.SS", "name": "华夏北京保障房REIT"},
    {"code": "180501", "symbol": "180501.SZ", "name": "红土深圳安居REIT"},
]


def parse_dividend_amount(text):
    """Extract numeric dividend from '每份派现金0.0433元'."""
    m = re.search(r"(\d+\.?\d*)", text or "")
    return float(m.group(1)) if m else 0.0


def fetch_realtime():
    """Fetch real-time prices for all C-REITs in one call."""
    try:
        df = ak.reits_realtime_em()
        return {str(r["代码"]): r for _, r in df.iterrows()}
    except Exception as e:
        print(f"  [akshare] realtime failed: {e}", file=sys.stderr)
        return {}


def fetch_disclosure(code, realtime_map):
    """Fetch NAV + dividend disclosure for a single C-REIT."""
    result = {"code": code, "error": None}

    # Real-time price
    rt = realtime_map.get(code)
    if rt is not None:
        result["price"] = float(rt["最新价"]) if rt["最新价"] else None
        result["change"] = float(rt["涨跌幅"]) if rt["涨跌幅"] else None
        result["volume"] = int(rt["成交量"]) if rt["成交量"] else 0
        result["turnover"] = float(rt["成交额"]) if rt["成交额"] else 0
        result["open"] = float(rt["开盘价"]) if rt["开盘价"] else None
        result["high"] = float(rt["最高价"]) if rt["最高价"] else None
        result["low"] = float(rt["最低价"]) if rt["最低价"] else None
        result["prevClose"] = float(rt["昨收"]) if rt["昨收"] else None

    # NAV (单位净值)
    time.sleep(0.3)
    try:
        nav_df = ak.fund_open_fund_info_em(symbol=code, indicator="单位净值走势")
        if not nav_df.empty:
            latest = nav_df.iloc[-1]
            nav_val = float(latest["单位净值"])
            # Timestamp may be int (ms) or string
            nav_ts = latest["净值日期"]
            if isinstance(nav_ts, (int, float)):
                nav_date = datetime.fromtimestamp(nav_ts / 1000).strftime("%Y-%m-%d")
            else:
                nav_date = str(nav_ts)[:10]
            result["nav"] = nav_val
            result["navDate"] = nav_date

            # Premium/discount to NAV
            price = result.get("price")
            if price and nav_val > 0:
                result["premiumDiscount"] = round((price - nav_val) / nav_val * 100, 2)
    except Exception as e:
        print(f"  [akshare] {code} NAV failed: {e}", file=sys.stderr)

    # Cumulative NAV (累计净值)
    time.sleep(0.3)
    try:
        cnav_df = ak.fund_open_fund_info_em(symbol=code, indicator="累计净值走势")
        if not cnav_df.empty:
            result["cumulativeNav"] = float(cnav_df.iloc[-1]["累计净值"])
    except Exception as e:
        print(f"  [akshare] {code} cumulative NAV failed: {e}", file=sys.stderr)

    # Dividend history (分红送配详情)
    time.sleep(0.3)
    try:
        div_df = ak.fund_open_fund_info_em(symbol=code, indicator="分红送配详情")
        if not div_df.empty:
            dividends = []
            total_div_amount = 0.0
            for _, row in div_df.iterrows():
                amt = parse_dividend_amount(row.get("每份分红", ""))
                total_div_amount += amt
                dividends.append({
                    "year": row.get("年份", ""),
                    "recordDate": row.get("权益登记日", ""),
                    "exDate": row.get("除息日", ""),
                    "amount": amt,
                    "description": row.get("每份分红", ""),
                    "payDate": row.get("分红发放日", ""),
                })
            result["dividends"] = dividends
            result["totalDistributed"] = round(total_div_amount, 4)

            # Annualized distribution yield (last 12 months)
            recent_divs = [d for d in dividends if d["year"].startswith(("2025", "2026"))]
            recent_total = sum(d["amount"] for d in recent_divs)
            price = result.get("price")
            if price and price > 0 and recent_total > 0:
                result["distributionYield"] = round(recent_total / price * 100, 2)
        else:
            result["dividends"] = []
    except Exception as e:
        print(f"  [akshare] {code} dividends failed: {e}", file=sys.stderr)
        result["dividends"] = []

    return result


def main():
    print("Fetching C-REIT disclosure data via akshare...", file=sys.stderr)

    # Single bulk call for real-time prices
    realtime_map = fetch_realtime()
    print(f"  [akshare] realtime: {len(realtime_map)} REITs", file=sys.stderr)

    disclosures = []
    for cfg in CREIT_CODES:
        code = cfg["code"]
        print(f"  [akshare] {code} {cfg['name']}...", file=sys.stderr)
        try:
            data = fetch_disclosure(code, realtime_map)
            data["symbol"] = cfg["symbol"]
            data["name"] = cfg["name"]
            disclosures.append(data)
            nav = data.get("nav", "N/A")
            prem = data.get("premiumDiscount", "N/A")
            ndiv = len(data.get("dividends", []))
            print(f"    NAV={nav} premium={prem}% dividends={ndiv}", file=sys.stderr)
        except Exception as e:
            print(f"    ERROR: {e}", file=sys.stderr)
            disclosures.append({"code": code, "symbol": cfg["symbol"], "name": cfg["name"], "error": str(e)})

    output = {
        "disclosures": disclosures,
        "source": "akshare/eastmoney",
        "lastUpdated": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
