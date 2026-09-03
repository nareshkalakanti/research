#!/usr/bin/env python3
"""Fetch market cap for NSE/BSE listed stocks from a CSV of company names and symbols.

Primary source: Tickertape (numeric market cap in INR crore).
Fallback source: Groww (displayed market cap string, parsed to crore).

Example:
  python3 scripts/fetch_market_cap.py
  python3 scripts/fetch_market_cap.py --input data/missing-metrics-All-2026-09-03.csv --limit 10
  python3 scripts/fetch_market_cap.py --resume --workers 6
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from threading import Lock
from typing import Any

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
TICKERTAPE_SEARCH = "https://api.tickertape.in/stocks/search?text={query}"
TICKERTAPE_INFO = "https://api.tickertape.in/stocks/info/{sid}"
GROWW_SEARCH = "https://groww.in/v1/api/search/v1/entity?app=web&query={query}&entity_type=stocks"
GROWW_COMPANY = "https://groww.in/v1/api/stocks_data/v1/company/search_id/{search_id}"
GROWW_PRICE = (
    "https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/{exchange}"
    "/segment/CASH/{symbol}/latest"
)

OUTPUT_FIELDS = [
    "company name",
    "symbol",
    "website",
    "matched_name",
    "exchange",
    "isin",
    "sector",
    "subsector",
    "about",
    "ceo",
    "managing_director",
    "founded_year",
    "last_price",
    "market_cap_cr",
    "market_cap_inr",
    "source",
    "status",
    "error",
]

CRORE = 10_000_000
print_lock = Lock()


def log(message: str) -> None:
    with print_lock:
        print(message, file=sys.stderr, flush=True)


def http_get_json(url: str, timeout: float = 20.0, retries: int = 4) -> Any:
    last_error: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in {429, 500, 502, 503, 504} and attempt < retries - 1:
                time.sleep((1.5**attempt) + random.random())
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < retries - 1:
                time.sleep((1.5**attempt) + random.random())
                continue
            raise
    raise RuntimeError(f"GET failed for {url}: {last_error}")


def normalize_name(value: str) -> str:
    text = value.lower()
    text = re.sub(r"&", " and ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(
        r"\b(limited|ltd|pvt|private|the|india|indian)\b",
        " ",
        text,
    )
    return re.sub(r"\s+", " ", text).strip()


def names_match(left: str, right: str) -> bool:
    a, b = normalize_name(left), normalize_name(right)
    if not a or not b:
        return False
    return a == b or a in b or b in a


def first_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text and text.lower() not in {"unknown", "none", "null"}:
            return text
    return ""


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", first_text(value)).strip()


def fill_blank(target: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    for key, value in extra.items():
        if value and not str(target.get(key) or "").strip():
            target[key] = value
    return target


def subsector_from_tags(tags: list[dict[str, Any]] | None) -> str:
    for tag in tags or []:
        if (tag.get("type") or "").lower() == "sub-sector":
            return first_text(tag.get("name"))
    return ""


def parse_compact_inr(value: str | None) -> float | None:
    """Parse strings like '₹25Cr', 'Rs. 1,234.5 Cr', '35 Cr' into INR crore."""
    if not value:
        return None
    text = (
        value.replace("₹", "")
        .replace("Rs.", "")
        .replace("INR", "")
        .replace(",", "")
        .strip()
    )
    match = re.search(r"([0-9]*\.?[0-9]+)\s*(L\s*Cr|Lakh Cr|Cr|Crore|Lakh|L)?", text, re.I)
    if not match:
        return None
    number = float(match.group(1))
    unit = (match.group(2) or "Cr").lower().replace(" ", "")
    if unit in {"lcr", "lakhcr"}:
        return number * 100_000
    if unit in {"cr", "crore"}:
        return number
    if unit in {"lakh", "l"}:
        return number / 100.0
    return number


def tickertape_lookup(symbol: str, company_name: str) -> dict[str, Any] | None:
    payload = http_get_json(TICKERTAPE_SEARCH.format(query=urllib.parse.quote(symbol)))
    results = ((payload.get("data") or {}).get("searchResults") or [])
    exact = []
    fuzzy = []
    for item in results:
        info = ((item.get("stock") or {}).get("info") or {})
        ticker = (info.get("ticker") or "").strip().upper()
        name = info.get("name") or ""
        sid = item.get("sid")
        if not sid:
            continue
        row = {
            "sid": sid,
            "ticker": ticker,
            "name": name,
            "exchange": info.get("exchange") or "",
        }
        if ticker == symbol.upper():
            exact.append(row)
        elif names_match(company_name, name):
            fuzzy.append(row)
    chosen = (exact or fuzzy or [None])[0]
    if not chosen:
        return None

    info_payload = http_get_json(TICKERTAPE_INFO.format(sid=urllib.parse.quote(chosen["sid"])))
    data = info_payload.get("data") or {}
    ratios = data.get("ratios") or {}
    info = data.get("info") or {}
    gic = data.get("gic") or {}
    sector_label = (data.get("labels") or {}).get("sector") or {}
    market_cap_cr = ratios.get("marketCap")
    if market_cap_cr is None:
        market_cap_cr = ratios.get("mrktCapf")
    if market_cap_cr is None:
        return None
    market_cap_cr = float(market_cap_cr)
    last_price = ratios.get("lastPrice")
    exchange = info.get("exchange") or chosen["exchange"]
    return {
        "matched_name": info.get("name") or chosen["name"],
        "exchange": exchange,
        "isin": data.get("isin") or "",
        "sector": first_text(sector_label.get("title"), gic.get("sector")),
        "subsector": first_text(
            info.get("sector"),
            sector_label.get("description"),
            subsector_from_tags(info.get("tags")),
            gic.get("industry"),
            gic.get("subindustry"),
        ),
        "about": clean_text(info.get("description")),
        "ceo": "",
        "managing_director": "",
        "founded_year": "",
        "last_price": last_price,
        "market_cap_cr": round(market_cap_cr, 4),
        "market_cap_inr": int(round(market_cap_cr * CRORE)),
        "source": "tickertape",
        "status": "ok",
        "error": "",
    }


def groww_search_hit(symbol: str, company_name: str) -> dict[str, Any] | None:
    payload = http_get_json(GROWW_SEARCH.format(query=urllib.parse.quote(symbol)))
    hits = payload.get("content") or []
    exact = []
    fuzzy = []
    for hit in hits:
        nse = (hit.get("nse_scrip_code") or "").strip().upper()
        bse = str(hit.get("bse_scrip_code") or "").strip().upper()
        title = hit.get("title") or hit.get("company_short_name") or ""
        row = hit
        if nse == symbol.upper() or bse == symbol.upper():
            exact.append(row)
        elif names_match(company_name, title):
            fuzzy.append(row)
    return (exact or fuzzy or [None])[0]


def groww_company_data(symbol: str, company_name: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    hit = groww_search_hit(symbol, company_name)
    if not hit:
        return None
    search_id = hit.get("search_id") or hit.get("id")
    if not search_id:
        return None
    company = http_get_json(GROWW_COMPANY.format(search_id=urllib.parse.quote(search_id)))
    return hit, company


def profile_from_groww(company: dict[str, Any]) -> dict[str, str]:
    details = company.get("details") or {}
    return {
        "about": clean_text(details.get("businessSummary")),
        "ceo": first_text(details.get("ceo")),
        "managing_director": first_text(details.get("managingDirector")),
        "founded_year": first_text(details.get("foundedYear")),
    }


def groww_lookup(symbol: str, company_name: str) -> dict[str, Any] | None:
    data = groww_company_data(symbol, company_name)
    if not data:
        return None
    hit, company = data
    header = company.get("header") or {}
    fundamentals = company.get("fundamentals") or []
    market_cap_value = next(
        (item.get("value") for item in fundamentals if item.get("name") == "Market Cap"),
        None,
    )
    market_cap_cr = parse_compact_inr(market_cap_value)
    if market_cap_cr is None:
        return None

    exchange = "NSE" if header.get("isNseTradable") else "BSE" if header.get("isBseTradable") else ""
    last_price = None
    live_symbol = header.get("nseScriptCode") or header.get("bseScriptCode") or symbol
    if exchange and live_symbol:
        try:
            price_payload = http_get_json(
                GROWW_PRICE.format(exchange=exchange, symbol=urllib.parse.quote(str(live_symbol)))
            )
            last_price = price_payload.get("ltp") or price_payload.get("close")
        except Exception:
            last_price = None

    return {
        "matched_name": header.get("displayName") or hit.get("title") or "",
        "exchange": exchange,
        "isin": header.get("isin") or hit.get("isin") or "",
        "sector": "",
        "subsector": first_text(header.get("industryName")),
        **profile_from_groww(company),
        "last_price": last_price,
        "market_cap_cr": round(float(market_cap_cr), 4),
        "market_cap_inr": int(round(float(market_cap_cr) * CRORE)),
        "source": "groww",
        "status": "ok",
        "error": "",
    }


def fetch_one(row: dict[str, str], delay: float) -> dict[str, Any]:
    company_name = (row.get("company name") or "").strip()
    symbol = (row.get("symbol") or "").strip()
    website = (row.get("website") or "").strip()
    result = {
        "company name": company_name,
        "symbol": symbol,
        "website": website,
        "matched_name": "",
        "exchange": "",
        "isin": "",
        "sector": "",
        "subsector": "",
        "about": "",
        "ceo": "",
        "managing_director": "",
        "founded_year": "",
        "last_price": "",
        "market_cap_cr": "",
        "market_cap_inr": "",
        "source": "",
        "status": "not_found",
        "error": "",
    }
    if not symbol:
        result["status"] = "error"
        result["error"] = "missing symbol"
        return result

    if delay:
        time.sleep(delay)

    errors: list[str] = []
    found: dict[str, Any] | None = None
    try:
        found = tickertape_lookup(symbol, company_name)
    except Exception as exc:
        errors.append(f"tickertape_lookup: {exc}")

    if found:
        try:
            groww_data = groww_company_data(symbol, company_name)
            if groww_data:
                fill_blank(found, profile_from_groww(groww_data[1]))
        except Exception as exc:
            errors.append(f"groww_profile: {exc}")
        result.update(found)
        return result

    try:
        found = groww_lookup(symbol, company_name)
        if found:
            result.update(found)
            return result
    except Exception as exc:
        errors.append(f"groww_lookup: {exc}")

    result["error"] = " | ".join(errors) if errors else "no matching NSE/BSE quote"
    return result


def load_done_symbols(path: Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open(newline="", encoding="utf-8") as handle:
        return {
            (row.get("symbol") or "").strip().upper()
            for row in csv.DictReader(handle)
            if (row.get("status") or "") == "ok"
        }


def prepare_output(path: Path, resume: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if resume and path.exists() and path.stat().st_size > 0:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS).writeheader()


def append_row(path: Path, row: dict[str, Any], lock: Lock) -> None:
    serialized = {field: "" if row.get(field) is None else row.get(field) for field in OUTPUT_FIELDS}
    with lock:
        with path.open("a", newline="", encoding="utf-8") as handle:
            csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS).writerow(serialized)


def latest_missing_metrics_csv(data_dir: Path) -> Path | None:
    dated = data_dir / f"missing-metrics-All-{date.today().isoformat()}.csv"
    if dated.exists():
        return dated
    matches = sorted(
        (
            p
            for p in data_dir.glob("missing-metrics-*.csv")
            if "with-mcap" not in p.name
        ),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return matches[0] if matches else None


def parse_args() -> argparse.Namespace:
    default_output = Path(f"data/missing-metrics-with-mcap-{date.today().isoformat()}.csv")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Input CSV with company name, symbol, website (default: latest data/missing-metrics-*.csv)",
    )
    parser.add_argument("--output", type=Path, default=default_output, help="Output CSV path")
    parser.add_argument("--limit", type=int, default=0, help="Process only the first N rows (0 = all)")
    parser.add_argument("--workers", type=int, default=4, help="Parallel request workers")
    parser.add_argument("--delay", type=float, default=0.15, help="Per-task delay in seconds to avoid rate limits")
    parser.add_argument("--resume", action="store_true", help="Skip symbols already fetched successfully in the output file")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = args.input or latest_missing_metrics_csv(Path("data"))
    if input_path is None or not input_path.exists():
        log(
            "Input file not found. Download Missing data CSV, or pass "
            "--input data/missing-metrics-All-YYYY-MM-DD.csv",
        )
        return 1

    with input_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if args.limit:
        rows = rows[: args.limit]

    done = load_done_symbols(args.output) if args.resume else set()
    pending = [row for row in rows if (row.get("symbol") or "").strip().upper() not in done]
    prepare_output(args.output, args.resume)
    log(f"Fetching market cap for {len(pending)} of {len(rows)} symbols -> {args.output}")

    write_lock = Lock()
    ok = failed = 0
    workers = max(1, args.workers)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_one, row, args.delay): row for row in pending}
        for index, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            append_row(args.output, result, write_lock)
            if result["status"] == "ok":
                ok += 1
            else:
                failed += 1
            log(
                f"[{index}/{len(pending)}] {result['symbol']}: "
                f"{result['status']} mcap_cr={result['market_cap_cr']} "
                f"sector={result['sector']} about={str(result['about'])[:60]} "
                f"source={result['source']}"
            )

    log(f"Done. ok={ok} failed={failed} output={args.output}")
    return 0 if failed == 0 or ok > 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
