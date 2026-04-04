"""
NSE Options Service — Real option chain data from NSE India public API.

NSE provides a free, unauthenticated option chain API that returns live
call/put data for indices (NIFTY, BANKNIFTY, SENSEX, FINNIFTY) and
individual stocks.

Flow:
  1. Visit nseindia.com to obtain session cookies (required by NSE CDN).
  2. Hit the option-chain endpoint with those cookies.
  3. Parse and normalise the response into a consistent schema.

Data refreshed every 60 seconds (NSE updates ~1 min during market hours).
"""

import logging
import time
import asyncio
from typing import Optional

logger = logging.getLogger(__name__)

# ── NSE API config ─────────────────────────────────────────────────────────────
_NSE_BASE = "https://www.nseindia.com"
_NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.nseindia.com/",
    "X-Requested-With": "XMLHttpRequest",
    "Connection": "keep-alive",
}

# Index symbols supported by the indices endpoint
_INDEX_SYMBOLS = {"NIFTY", "BANKNIFTY", "NIFTYBANK", "SENSEX", "FINNIFTY",
                  "MIDCPNIFTY", "NIFTYNXT50"}

# ── In-memory cache ──────────────────────────────────────────────────────────
_cache: dict = {}          # symbol → response dict
_cache_ts: dict = {}       # symbol → float epoch
_CACHE_TTL = 60            # seconds

# ── Cookie cache (avoids re-visiting homepage on every request) ───────────────
_nse_cookies: dict = {}
_nse_cookies_ts: float = 0.0
_COOKIE_TTL = 300          # refresh cookies every 5 minutes


async def _get_cookies() -> dict:
    """Visit nseindia.com homepage to obtain session cookies."""
    global _nse_cookies, _nse_cookies_ts
    import httpx

    now = time.time()
    if _nse_cookies and (now - _nse_cookies_ts) < _COOKIE_TTL:
        return _nse_cookies

    try:
        async with httpx.AsyncClient(
            headers=_NSE_HEADERS, follow_redirects=True, timeout=10
        ) as client:
            resp = await client.get(_NSE_BASE)
            _nse_cookies = dict(resp.cookies)
            _nse_cookies_ts = now
            logger.debug("NSE cookies refreshed (%d cookies)", len(_nse_cookies))
            return _nse_cookies
    except Exception as exc:
        logger.warning("NSE cookie fetch failed: %s", exc)
        return _nse_cookies  # return stale if available


async def _fetch_nse(endpoint: str) -> Optional[dict]:
    """Fetch a single NSE API endpoint with session cookies."""
    import httpx

    cookies = await _get_cookies()
    url = f"{_NSE_BASE}/api/{endpoint}"

    try:
        async with httpx.AsyncClient(
            headers=_NSE_HEADERS,
            cookies=cookies,
            follow_redirects=True,
            timeout=12,
        ) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                return resp.json()
            logger.warning("NSE API %s returned HTTP %s", endpoint, resp.status_code)
            return None
    except Exception as exc:
        logger.error("NSE API fetch failed (%s): %s", endpoint, exc)
        return None


def _normalise_strike(record: dict, option_type: str) -> Optional[dict]:
    """Extract and normalise a single call or put row from NSE option chain record."""
    data = record.get(option_type)
    if not data:
        return None
    return {
        "strike":           record.get("strikePrice", 0),
        "expiry":           data.get("expiryDate", ""),
        "option_type":      option_type,          # "CE" or "PE"
        "ltp":              data.get("lastPrice", 0),
        "change":           data.get("change", 0),
        "change_pct":       data.get("pChange", 0),
        "volume":           data.get("totalTradedVolume", 0),
        "oi":               data.get("openInterest", 0),
        "oi_change":        data.get("changeinOpenInterest", 0),
        "bid":              data.get("bidprice", 0),
        "ask":              data.get("askPrice", 0),
        "iv":               data.get("impliedVolatility", 0),
        "delta":            data.get("delta", None),
        "gamma":            data.get("gamma", None),
        "theta":            data.get("theta", None),
        "vega":             data.get("vega", None),
    }


async def get_option_chain(symbol: str) -> Optional[dict]:
    """
    Fetch live option chain for an index or stock.

    Returns:
        {
          "symbol":           str,
          "underlying_price": float,
          "expiry_dates":     [str, ...],      # sorted nearest-first
          "chain":            [
            {
              "strike":       float,
              "expiry":       str,
              "CE": {...},    # call data (may be None)
              "PE": {...},    # put data (may be None)
            },
            ...
          ],
          "timestamp":        str,
        }
    """
    sym = symbol.upper().strip()

    # Cache check
    now = time.time()
    if sym in _cache and (now - _cache_ts.get(sym, 0)) < _CACHE_TTL:
        return _cache[sym]

    # Choose correct endpoint
    if sym in _INDEX_SYMBOLS or sym.startswith("NIFTY") or sym == "SENSEX":
        endpoint = f"option-chain-indices?symbol={sym}"
    else:
        endpoint = f"option-chain-equities?symbol={sym}"

    raw = await _fetch_nse(endpoint)
    if not raw:
        return None

    try:
        records = raw.get("records", {})
        filtered = raw.get("filtered", {})

        underlying_price = (
            records.get("underlyingValue")
            or filtered.get("underlyingValue")
            or 0
        )
        expiry_dates = sorted(records.get("expiryDates", []))
        data_rows = records.get("data", [])

        # Build combined call+put rows per strike
        strike_map: dict = {}
        for row in data_rows:
            strike = row.get("strikePrice", 0)
            expiry = (row.get("CE") or row.get("PE") or {}).get("expiryDate", "")
            key = (expiry, strike)
            if key not in strike_map:
                strike_map[key] = {"strike": strike, "expiry": expiry, "CE": None, "PE": None}
            ce = _normalise_strike(row, "CE")
            pe = _normalise_strike(row, "PE")
            if ce:
                strike_map[key]["CE"] = ce
            if pe:
                strike_map[key]["PE"] = pe

        chain = sorted(strike_map.values(), key=lambda r: (r["expiry"], r["strike"]))

        result = {
            "symbol":           sym,
            "underlying_price": float(underlying_price),
            "expiry_dates":     expiry_dates,
            "chain":            chain,
            "timestamp":        raw.get("records", {}).get("timestamp", ""),
            "source":           "nse",
        }

        _cache[sym] = result
        _cache_ts[sym] = now
        return result

    except Exception as exc:
        logger.error("NSE option chain parse failed for %s: %s", sym, exc, exc_info=True)
        return None


async def get_expiry_dates(symbol: str) -> list:
    """Return available expiry dates for a symbol (nearest-first)."""
    chain = await get_option_chain(symbol)
    if chain:
        return chain.get("expiry_dates", [])
    return []


async def get_filtered_chain(
    symbol: str,
    expiry: Optional[str] = None,
    strikes_around_atm: int = 20,
) -> Optional[dict]:
    """
    Return option chain filtered to a single expiry and limited strikes around ATM.

    If expiry is None, the nearest available expiry is used.
    strikes_around_atm: number of strikes above AND below ATM to include.
    """
    full = await get_option_chain(symbol)
    if not full:
        return None

    expiry_dates = full["expiry_dates"]
    if not expiry_dates:
        return full

    target_expiry = expiry if expiry in expiry_dates else expiry_dates[0]
    spot = full["underlying_price"]

    rows = [r for r in full["chain"] if r["expiry"] == target_expiry]
    rows_sorted = sorted(rows, key=lambda r: r["strike"])

    # Find ATM index
    if spot and rows_sorted:
        atm_idx = min(
            range(len(rows_sorted)),
            key=lambda i: abs(rows_sorted[i]["strike"] - spot),
        )
        lo = max(0, atm_idx - strikes_around_atm)
        hi = min(len(rows_sorted), atm_idx + strikes_around_atm + 1)
        rows_sorted = rows_sorted[lo:hi]

    return {
        **full,
        "selected_expiry": target_expiry,
        "chain":           rows_sorted,
    }
