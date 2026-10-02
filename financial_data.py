#!/usr/bin/env python3
"""Yahoo Finance market/financials for NSE tickers. No qualitative model."""

from __future__ import annotations

import json
import math
import re
import sys
from typing import Any

TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.&-]{0,20}$")


class StockDataError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def yahoo_symbol(ticker: str) -> str:
    t = (ticker or "").strip().upper()
    if t.endswith(".NS") or t.endswith(".BO"):
        t = t[:-3]
    t = t.replace(" ", "")
    if not TICKER_RE.fullmatch(t):
        raise StockDataError("invalid_ticker", "Enter a valid NSE ticker")
    return f"{t}.NS"


def nse_ticker(symbol: str) -> str:
    t = (symbol or "").strip().upper()
    if t.endswith(".NS") or t.endswith(".BO"):
        t = t[:-3]
    return t


def _num(v: Any) -> float | None:
    if v is None:
        return None
    try:
        if isinstance(v, float) and math.isnan(v):
            return None
        n = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n):
        return None
    return n


def cagr(start: float | None, end: float | None, years: int) -> float | None:
    if years <= 0:
        return None
    s, e = _num(start), _num(end)
    if s is None or e is None:
        return None
    if s <= 0 or e <= 0:
        return None
    return (e / s) ** (1.0 / years) - 1.0


def _row_series(df: Any, names: list[str]) -> list[tuple[str, float]]:
    if df is None:
        return []
    empty = getattr(df, "empty", True)
    if empty:
        return []
    idx = {str(i).strip().lower(): i for i in df.index}
    key = None
    for name in names:
        hit = idx.get(name.strip().lower())
        if hit is not None:
            key = hit
            break
    if key is None:
        return []
    out: list[tuple[str, float]] = []
    row = df.loc[key]
    for col, val in row.items():
        n = _num(val)
        if n is None:
            continue
        label = str(getattr(col, "year", col))
        if hasattr(col, "strftime"):
            label = col.strftime("%Y")
        else:
            m = re.search(r"(19|20)\d{2}", str(col))
            label = m.group(0) if m else str(col)
        out.append((label, n))
    out.sort(key=lambda x: x[0])
    return out


def _window_cagr(series: list[tuple[str, float]], years: int) -> float | None:
    if len(series) < years + 1:
        return None
    start = series[-(years + 1)][1]
    end = series[-1][1]
    return cagr(start, end, years)


def _mean_ratio(
    num: list[tuple[str, float]],
    den: list[tuple[str, float]],
    years: int,
) -> float | None:
    dmap = {y: v for y, v in den}
    ratios: list[float] = []
    for y, n in num:
        d = dmap.get(y)
        if d is None or d == 0:
            continue
        ratios.append(n / d)
    if years <= 0:
        return ratios[-1] if ratios else None
    take = ratios[-years:] if len(ratios) >= years else []
    if len(take) < years:
        return None
    return sum(take) / len(take)


def get_stock_data(ticker: str) -> dict[str, Any]:
    symbol = yahoo_symbol(ticker)
    bare = nse_ticker(symbol)
    warnings: list[str] = []

    try:
        import yfinance as yf
    except ImportError as e:
        raise StockDataError(
            "yahoo_unavailable",
            "yfinance is not installed in this Python",
        ) from e

    try:
        stock = yf.Ticker(symbol)
        info = stock.info or {}
        income = stock.income_stmt
        cashflow = stock.cashflow
        balance = stock.balance_sheet
    except StockDataError:
        raise
    except Exception as e:
        raise StockDataError(
            "yahoo_unavailable",
            f"Yahoo Finance unavailable: {e}",
        ) from e

    name = (
        info.get("longName")
        or info.get("shortName")
        or info.get("displayName")
        or None
    )
    price = _num(info.get("currentPrice") or info.get("regularMarketPrice"))
    if name is None and price is None and not info:
        raise StockDataError("invalid_ticker", f"No Yahoo quote for {symbol}")

    revenue_s = _row_series(income, ["Total Revenue", "Operating Revenue"])
    ni_s = _row_series(income, ["Net Income", "Net Income Common Stockholders"])
    eps_s = _row_series(income, ["Diluted EPS", "Basic EPS"])
    ebit_s = _row_series(income, ["EBIT", "Operating Income"])
    ebitda_s = _row_series(income, ["EBITDA"])
    fcf_s = _row_series(cashflow, ["Free Cash Flow"])
    equity_s = _row_series(
        balance,
        ["Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest"],
    )
    assets_s = _row_series(balance, ["Total Assets"])
    cl_s = _row_series(balance, ["Current Liabilities"])
    debt_s = _row_series(balance, ["Total Debt"])
    cash_s = _row_series(
        balance,
        ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments", "Cash Financial"],
    )

    trailing_eps = _num(info.get("trailingEps"))
    if trailing_eps is not None and trailing_eps < 0:
        warnings.append("negative_eps")
    if eps_s and eps_s[-1][1] < 0:
        if "negative_eps" not in warnings:
            warnings.append("negative_eps")

    eps_3 = _window_cagr(eps_s, 3)
    eps_5 = _window_cagr(eps_s, 5)
    if eps_3 is None:
        warnings.append("insufficient_history")
    if len(revenue_s) < 4:
        if "insufficient_history" not in warnings:
            warnings.append("insufficient_history")

    latest_ni = ni_s[-1][1] if ni_s else _num(info.get("netIncomeToCommon"))
    latest_rev = revenue_s[-1][1] if revenue_s else _num(info.get("totalRevenue"))
    latest_ebit = ebit_s[-1][1] if ebit_s else _num(info.get("ebit"))
    latest_eq = equity_s[-1][1] if equity_s else None
    latest_assets = assets_s[-1][1] if assets_s else None
    latest_cl = cl_s[-1][1] if cl_s else None

    roce = None
    if (
        latest_ebit is not None
        and latest_assets is not None
        and latest_cl is not None
    ):
        employed = latest_assets - latest_cl
        if employed > 0:
            roce = latest_ebit / employed

    roe = None
    if latest_ni is not None and latest_eq is not None and latest_eq > 0:
        roe = latest_ni / latest_eq

    margin_now = None
    if latest_ni is not None and latest_rev not in (None, 0):
        margin_now = latest_ni / latest_rev

    annuals = []
    years = sorted(
        {
            y
            for series in (revenue_s, ni_s, eps_s, ebitda_s, fcf_s)
            for y, _ in series
        }
    )
    rev_m = dict(revenue_s)
    ni_m = dict(ni_s)
    eps_m = dict(eps_s)
    ebitda_m = dict(ebitda_s)
    fcf_m = dict(fcf_s)
    for y in years:
        annuals.append(
            {
                "year": y,
                "revenue": rev_m.get(y),
                "net_income": ni_m.get(y),
                "eps": eps_m.get(y),
                "ebitda": ebitda_m.get(y),
                "free_cash_flow": fcf_m.get(y),
            }
        )

    missing = (
        price is None
        and latest_rev is None
        and latest_ni is None
        and not annuals
    )
    if missing:
        raise StockDataError(
            "missing_financial_data",
            f"Yahoo returned no usable financials for {symbol}",
        )

    return {
        "ok": True,
        "error": None,
        "error_code": None,
        "company_name": name,
        "ticker": bare,
        "yf_symbol": symbol,
        "price": price,
        "market_cap": _num(info.get("marketCap")),
        "pe": _num(info.get("trailingPE") or info.get("forwardPE")),
        "eps": trailing_eps,
        "revenue": latest_rev,
        "net_income": latest_ni,
        "ebitda": ebitda_s[-1][1] if ebitda_s else _num(info.get("ebitda")),
        "free_cash_flow": fcf_s[-1][1] if fcf_s else _num(info.get("freeCashflow")),
        "total_debt": debt_s[-1][1] if debt_s else _num(info.get("totalDebt")),
        "cash": cash_s[-1][1] if cash_s else _num(info.get("totalCash")),
        "shares_outstanding": _num(info.get("sharesOutstanding")),
        "roe": roe,
        "roce": roce,
        "cagr": {
            "revenue_3y": _window_cagr(revenue_s, 3),
            "revenue_5y": _window_cagr(revenue_s, 5),
            "eps_3y": eps_3,
            "eps_5y": eps_5,
            "profit_3y": _window_cagr(ni_s, 3),
            "profit_5y": _window_cagr(ni_s, 5),
        },
        "margin": {
            "current": margin_now,
            "3y": _mean_ratio(ni_s, revenue_s, 3),
            "5y": _mean_ratio(ni_s, revenue_s, 5),
        },
        "annuals": annuals,
        "warnings": warnings,
    }


def main() -> int:
    raw = ""
    if len(sys.argv) >= 3 and sys.argv[1] in ("--ticker", "-t"):
        raw = sys.argv[2]
    elif len(sys.argv) >= 2 and not sys.argv[1].startswith("-"):
        raw = sys.argv[1]
    else:
        payload = {
            "ok": False,
            "error_code": "invalid_ticker",
            "error": "Pass --ticker NSE_SYMBOL",
        }
        print(json.dumps(payload))
        return 2
    try:
        print(json.dumps(get_stock_data(raw), allow_nan=False))
        return 0
    except StockDataError as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error_code": e.code,
                    "error": e.message,
                    "ticker": nse_ticker(raw),
                    "yf_symbol": None,
                }
            )
        )
        return 1
    except Exception as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error_code": "yahoo_unavailable",
                    "error": str(e),
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
