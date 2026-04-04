"""
Market Data Service — Zebu/MYNT broker API only (no Yahoo Finance).

All market data comes exclusively from:
  1. User's personal Zebu broker session (if connected)
  2. Master Zebu account (shared NSE live feed if configured in .env)

All quote functions require an active broker session or master session.
If no session is available, a BrokerNotConnected exception is raised.

Responsibilities:
    * Symbol formatting (_format_symbol)
    * User-scoped quote access (get_quote, get_quote_safe)
    * System-level quote access (get_system_quote, get_system_quote_safe)
    * Stock search (local NSE list + Zebu SearchScrip API)
    * Convenience lists (POPULAR_INDIAN_STOCKS, INDIAN_INDICES)
"""

from typing import Optional, Mapping, Any
import time
import logging
import asyncio
import random
import hashlib
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from config.settings import settings
from engines.market_session import market_session, MarketState
from services.nse_stocks import NSE_STOCK_LIST
from providers.symbol_mapper import is_mcx_symbol

logger = logging.getLogger(__name__)


# ── Request deduplication (prevent duplicate concurrent requests) ──
@dataclass
class _RequestInFlight:
    task: asyncio.Task
    created_at: float


_batch_requests: dict = {}  # key → in-flight task
_symbol_requests: dict = {}  # symbol → in-flight task
_cleanup_interval = 300  # Clean old entries after 5 minutes


def _strict_zebu_only() -> bool:
    return bool(getattr(settings, "STRICT_ZEBU_MARKET_DATA", False))


# Provider timeout to prevent hanging request
PROVIDER_TIMEOUT_SECONDS = 3.0


# ── Timeout wrapper for provider calls ──
async def _call_provider_with_timeout(
    coro, symbol: str, timeout: float = PROVIDER_TIMEOUT_SECONDS
):
    """
    Call provider method with timeout.
    Returns None if timeout, letting fallback (yfinance) handle it.
    """
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning(f"Provider timeout for {symbol} (>{timeout}s) — using fallback")
        return None
    except Exception as e:
        logger.warning(f"Provider error for {symbol}: {e} — using fallback")
        return None


# Thread pool for blocking yfinance calls
_yf_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="yfinance")

# Per-symbol yfinance quote cache (30s TTL — avoids hammering yfinance on every poll)
_yf_quote_cache: dict = {}
_yf_quote_cache_ts: dict = {}
YF_QUOTE_CACHE_DURATION = 30  # seconds

# ── Search result cache (Yahoo queries are expensive) ──────────────────────────
_search_cache: dict = {}
_search_cache_ts: dict = {}
SEARCH_CACHE_DURATION = 300  # 5 minutes

# Popular Indian stocks (used for ticker bar, default suggestions)
POPULAR_INDIAN_STOCKS = [
    {"symbol": "RELIANCE.NS", "name": "Reliance Industries", "exchange": "NSE"},
    {"symbol": "TCS.NS", "name": "Tata Consultancy Services", "exchange": "NSE"},
    {"symbol": "HDFCBANK.NS", "name": "HDFC Bank", "exchange": "NSE"},
    {"symbol": "INFY.NS", "name": "Infosys", "exchange": "NSE"},
    {"symbol": "ICICIBANK.NS", "name": "ICICI Bank", "exchange": "NSE"},
    {"symbol": "HINDUNILVR.NS", "name": "Hindustan Unilever", "exchange": "NSE"},
    {"symbol": "SBIN.NS", "name": "State Bank of India", "exchange": "NSE"},
    {"symbol": "BHARTIARTL.NS", "name": "Bharti Airtel", "exchange": "NSE"},
    {"symbol": "ITC.NS", "name": "ITC Limited", "exchange": "NSE"},
    {"symbol": "KOTAKBANK.NS", "name": "Kotak Mahindra Bank", "exchange": "NSE"},
    {"symbol": "LT.NS", "name": "Larsen & Toubro", "exchange": "NSE"},
    {"symbol": "AXISBANK.NS", "name": "Axis Bank", "exchange": "NSE"},
    {"symbol": "WIPRO.NS", "name": "Wipro", "exchange": "NSE"},
    {"symbol": "HCLTECH.NS", "name": "HCL Technologies", "exchange": "NSE"},
    {"symbol": "TATAMOTORS.NS", "name": "Tata Motors", "exchange": "NSE"},
    {"symbol": "SUNPHARMA.NS", "name": "Sun Pharma", "exchange": "NSE"},
    {"symbol": "MARUTI.NS", "name": "Maruti Suzuki", "exchange": "NSE"},
    {"symbol": "TITAN.NS", "name": "Titan Company", "exchange": "NSE"},
    {"symbol": "BAJFINANCE.NS", "name": "Bajaj Finance", "exchange": "NSE"},
    {"symbol": "ADANIENT.NS", "name": "Adani Enterprises", "exchange": "NSE"},
]

# MCX / NCDEX Commodities — realistic Indian market prices (INR)
# base_price = approximate MCX/NCDEX reference price used for simulation
POPULAR_COMMODITIES = [
    # ── Metals (MCX) ──
    {
        "symbol": "GOLD",
        "name": "Gold",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per 10g",
        "lot": 1,
        "base_price": 73250,
    },
    {
        "symbol": "SILVER",
        "name": "Silver",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per kg",
        "lot": 1,
        "base_price": 86500,
    },
    {
        "symbol": "COPPER",
        "name": "Copper",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per kg",
        "lot": 250,
        "base_price": 812,
    },
    {
        "symbol": "ALUMINIUM",
        "name": "Aluminium",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per kg",
        "lot": 500,
        "base_price": 236,
    },
    {
        "symbol": "ZINC",
        "name": "Zinc",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per kg",
        "lot": 500,
        "base_price": 265,
    },
    {
        "symbol": "LEAD",
        "name": "Lead",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per kg",
        "lot": 500,
        "base_price": 192,
    },
    {
        "symbol": "NICKEL",
        "name": "Nickel",
        "exchange": "MCX",
        "category": "metals",
        "unit": "per kg",
        "lot": 100,
        "base_price": 1340,
    },
    # ── Energy (MCX) ──
    {
        "symbol": "CRUDEOIL",
        "name": "Crude Oil",
        "exchange": "MCX",
        "category": "energy",
        "unit": "per bbl",
        "lot": 100,
        "base_price": 6480,
    },
    {
        "symbol": "NATURALGAS",
        "name": "Natural Gas",
        "exchange": "MCX",
        "category": "energy",
        "unit": "per MMBtu",
        "lot": 1250,
        "base_price": 285,
    },
    # ── Agriculture (NCDEX) ──
    {
        "symbol": "COTTON",
        "name": "Cotton",
        "exchange": "NCDEX",
        "category": "agriculture",
        "unit": "per bale",
        "lot": 25,
        "base_price": 56800,
    },
    {
        "symbol": "CASTORSEED",
        "name": "Castor Seed",
        "exchange": "NCDEX",
        "category": "agriculture",
        "unit": "per quintal",
        "lot": 100,
        "base_price": 5720,
    },
    {
        "symbol": "SOYBEAN",
        "name": "Soybean",
        "exchange": "NCDEX",
        "category": "agriculture",
        "unit": "per quintal",
        "lot": 100,
        "base_price": 4350,
    },
    {
        "symbol": "GUARSEED",
        "name": "Guar Seed",
        "exchange": "NCDEX",
        "category": "agriculture",
        "unit": "per quintal",
        "lot": 100,
        "base_price": 5480,
    },
    {
        "symbol": "RMSEED",
        "name": "Mustard Seed",
        "exchange": "NCDEX",
        "category": "agriculture",
        "unit": "per quintal",
        "lot": 100,
        "base_price": 5150,
    },
    {
        "symbol": "CHANA",
        "name": "Chana",
        "exchange": "NCDEX",
        "category": "agriculture",
        "unit": "per quintal",
        "lot": 100,
        "base_price": 5280,
    },
    {
        "symbol": "MENTHOIL",
        "name": "Mentha Oil",
        "exchange": "MCX",
        "category": "agriculture",
        "unit": "per kg",
        "lot": 360,
        "base_price": 1025,
    },
]

# Indian market indices — Yahoo Finance symbols
# Core indices that reliably work with yfinance
INDIAN_INDICES = [
    {"symbol": "^NSEI", "name": "NIFTY 50"},
    {"symbol": "^BSESN", "name": "SENSEX"},
    {"symbol": "^NSEBANK", "name": "BANK NIFTY"},
    {"symbol": "^CNXIT", "name": "NIFTY IT"},
    {"symbol": "^CNXPHARMA", "name": "NIFTY PHARMA"},
    {"symbol": "^CNXAUTO", "name": "NIFTY AUTO"},
    {"symbol": "^CNXMETAL", "name": "NIFTY METAL"},
    {"symbol": "^CNXFMCG", "name": "NIFTY FMCG"},
    {"symbol": "^CNXPSUBANK", "name": "NIFTY PSU BANK"},
]


def _format_symbol(symbol: str) -> str:
    """Ensure symbol has .NS suffix for NSE stocks.
    Indices (^), commodity futures (=F), and MCX commodity symbols are left as-is.
    """
    if symbol.startswith("^") or symbol.endswith(("=F", ".NS", ".BO")):
        return symbol
    if is_mcx_symbol(symbol):
        return symbol.upper()
    return f"{symbol}.NS"


def _normalize_quote(quote: Optional[dict]) -> Optional[dict]:
    """
    Normalize quote from ANY source into standardized field names.
    Extracts price from: price, lp, ltp, last_price, lastPrice, last_traded_price
    Extracts change from: change, net_change, netChange, pChange, price_change
    Extracts change% from: change_percent, changePercent, pct_change, pChange, percent_change
    Extracts prev_close from: prev_close, prevClose, previous_close, close
    Returns None if quote is invalid or missing required fields.
    """
    if not quote or not isinstance(quote, dict):
        return None

    # Extract price (required for valid quote)
    price = (
        quote.get("price")
        or quote.get("lp")
        or quote.get("ltp")
        or quote.get("last_price")
        or quote.get("lastPrice")
        or quote.get("last_traded_price")
    )
    try:
        price = float(price) if price else None
        if not price or price <= 0:
            return None
    except (TypeError, ValueError):
        return None

    # Extract previous close
    prev_close = (
        quote.get("prev_close")
        or quote.get("prevClose")
        or quote.get("previous_close")
        or quote.get("close")
    )
    try:
        prev_close = float(prev_close) if prev_close else 0.0
    except (TypeError, ValueError):
        prev_close = 0.0

    # Extract change (derived if missing)
    change = (
        quote.get("change")
        or quote.get("net_change")
        or quote.get("netChange")
        or quote.get("price_change")
    )
    try:
        change = float(change) if change is not None else None
    except (TypeError, ValueError):
        change = None
    if change is None and prev_close:
        change = round(float(price) - float(prev_close), 2)
    else:
        change = round(float(change), 2) if change else 0.0

    # Extract change percent (derived if missing)
    change_percent = (
        quote.get("change_percent")
        or quote.get("changePercent")
        or quote.get("pct_change")
        or quote.get("pChange")
        or quote.get("percent_change")
    )
    try:
        change_percent = float(change_percent) if change_percent is not None else None
    except (TypeError, ValueError):
        change_percent = None
    if change_percent is None and prev_close:
        change_percent = (
            round((float(change) / float(prev_close) * 100), 2) if prev_close else 0.0
        )
    else:
        change_percent = round(float(change_percent), 2) if change_percent else 0.0

    # Extract optional fields
    open_price = quote.get("open") or quote.get("o")
    try:
        open_price = round(float(open_price), 2) if open_price else 0.0
    except (TypeError, ValueError):
        open_price = 0.0

    high = quote.get("high") or quote.get("h")
    try:
        high = round(float(high), 2) if high else 0.0
    except (TypeError, ValueError):
        high = 0.0

    low = quote.get("low") or quote.get("l")
    try:
        low = round(float(low), 2) if low else 0.0
    except (TypeError, ValueError):
        low = 0.0

    volume = quote.get("volume") or quote.get("v") or quote.get("vo")
    try:
        volume = int(float(volume)) if volume else 0
    except (TypeError, ValueError):
        volume = 0

    # Build normalized output
    normalized = {
        "symbol": quote.get("symbol", ""),
        "name": quote.get("name", ""),
        "price": round(float(price), 2),
        "change": change,
        "change_percent": change_percent,
        "prev_close": round(float(prev_close), 2) if prev_close else 0.0,
        "open": open_price,
        "high": high,
        "low": low,
        "volume": volume,
        "timestamp": quote.get("timestamp", datetime.now(timezone.utc).isoformat()),
    }

    # Preserve additional fields from original quote (for compatibility)
    for key in [
        "source",
        "exchange",
        "kind",
        "category",
        "unit",
        "lot",
        "market_status",
    ]:
        if key in quote:
            normalized[key] = quote[key]

    return normalized


def _coerce_unix_seconds(raw_time) -> Optional[int]:
    """Convert mixed timestamp formats (sec/ms/us/ns/ISO) into Unix seconds."""
    if raw_time is None:
        return None

    # Numeric-like timestamp (int/float or numeric string)
    try:
        as_float = float(raw_time)
        if as_float <= 0:
            return None
        # Detect common epoch units and normalize to seconds.
        if as_float > 1e18:  # nanoseconds
            as_float /= 1_000_000_000.0
        elif as_float > 1e15:  # microseconds
            as_float /= 1_000_000.0
        elif as_float > 1e12:  # milliseconds
            as_float /= 1_000.0
        return int(as_float)
    except (TypeError, ValueError):
        pass

    # ISO datetime string
    if isinstance(raw_time, str):
        try:
            iso = raw_time.replace("Z", "+00:00")
            return int(datetime.fromisoformat(iso).timestamp())
        except Exception:
            return None

    return None


def normalize_history_candles(candles: list) -> list:
    """Normalize mixed OHLCV candle payloads into clean, sorted Unix-second candles."""
    normalized = []

    for candle in candles or []:
        if not isinstance(candle, dict):
            continue

        raw_time = (
            candle.get("time")
            or candle.get("t")
            or candle.get("timestamp")
            or candle.get("datetime")
        )
        t = _coerce_unix_seconds(raw_time)
        if t is None:
            continue

        try:
            o = float(candle.get("open"))
            h = float(candle.get("high"))
            l = float(candle.get("low"))
            c = float(candle.get("close"))
        except (TypeError, ValueError):
            continue

        if not all(x > 0 for x in [o, h, l, c]):
            continue

        high = max(h, o, c, l)
        low = min(l, o, c, h)

        try:
            v = int(float(candle.get("volume", 0) or 0))
        except (TypeError, ValueError):
            v = 0

        normalized.append(
            {
                "time": int(t),
                "open": round(o, 2),
                "high": round(high, 2),
                "low": round(low, 2),
                "close": round(c, 2),
                "volume": max(0, v),
            }
        )

    normalized.sort(key=lambda x: x["time"])

    deduped = {}
    for item in normalized:
        deduped[item["time"]] = item

    return list(deduped.values())


# ── Provider accessor ──────────────────────────────────────────────


def _get_provider_for_user(user_id: str):
    """Return user provider, falling back to master/any active provider."""
    from services.broker_session import broker_session_manager

    provider = broker_session_manager.get_session(user_id)
    if provider is None:
        provider = broker_session_manager.get_any_session()
    if provider is None:
        raise BrokerNotConnected(user_id)
    return provider


def _get_any_provider():
    """Return ANY active provider for system-level tasks. Raises RuntimeError if none."""
    from services.broker_session import broker_session_manager

    provider = broker_session_manager.get_any_session()
    if provider is None:
        raise RuntimeError("No active broker sessions — market data unavailable")
    return provider


class BrokerNotConnected(Exception):
    """Raised when a user has no active broker session."""

    def __init__(self, user_id: str = ""):
        self.user_id = user_id
        super().__init__(
            f"Broker not connected"
            + (f" for user {str(user_id)[:8]}..." if user_id else "")
        )


class ProviderDataUnavailable(Exception):
    """Raised when the active provider has no data for a symbol."""

    pass


# ── User-scoped quote functions ────────────────────────────────────

# Market states where Zebu REST returns unreliable last-price data
_CLOSED_STATES = {MarketState.WEEKEND, MarketState.HOLIDAY, MarketState.CLOSED}
_STALE_QUOTE_MAX_AGE_SECONDS = 120


def _adjust_for_market_state(quote: dict) -> dict:
    """Override stale lp with prev_close when the market is not active."""
    state = market_session.get_current_state()
    if state in _CLOSED_STATES:
        prev_close = quote.get("prev_close") or quote.get("close")
        if prev_close and prev_close > 0:
            quote["price"] = prev_close
            quote["change"] = 0
            quote["change_percent"] = 0
        quote["market_status"] = state.value
    return quote


def _parse_quote_timestamp(value: Any) -> Optional[float]:
    """Parse quote timestamp formats (ISO, epoch sec/ms) into epoch seconds."""
    if value in (None, ""):
        return None

    # Numeric epoch path
    try:
        numeric = float(value)
        # Milliseconds epoch
        if numeric > 1_000_000_000_000:
            numeric /= 1000.0
        return numeric if numeric > 0 else None
    except (TypeError, ValueError):
        pass

    # ISO datetime path
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:
        return None


def _is_quote_stale(
    quote: Any, max_age_seconds: int = _STALE_QUOTE_MAX_AGE_SECONDS
) -> bool:
    """True when quote is missing/invalid or timestamp is too old."""
    if not isinstance(quote, Mapping):
        return True

    price = quote.get("price")
    try:
        if float(price) <= 0:
            return True
    except (TypeError, ValueError):
        return True

    ts = _parse_quote_timestamp(
        quote.get("timestamp") or quote.get("last_trade_time") or quote.get("ft")
    )
    if ts is None:
        return False

    return (time.time() - ts) > max_age_seconds


async def _prefer_yfinance_quote(
    symbol: str, quote: Optional[dict], reason: str
) -> Optional[dict]:
    """Use yfinance when provider quote is stale or market is closed in non-strict mode."""
    if _strict_zebu_only() or not symbol:
        return quote

    state = market_session.get_current_state()
    should_refresh = state in _CLOSED_STATES or _is_quote_stale(quote)
    if not should_refresh:
        return quote

    yf_quote = await get_yfinance_quote(symbol)
    if not yf_quote:
        return quote

    if state in _CLOSED_STATES:
        yf_quote["market_status"] = state.value

    logger.info(
        f"Using yfinance quote for {symbol} ({reason}) | "
        f"state={state.value} stale={_is_quote_stale(quote)}"
    )
    return _adjust_for_market_state(yf_quote)


async def _get_yfinance_batch_quotes(symbols: list[str]) -> dict[str, dict]:
    """Fetch yfinance quotes concurrently for multiple symbols."""

    async def _yf_one(sym: str):
        formatted = _format_symbol(sym)
        try:
            q = await get_yfinance_quote(formatted)
            return (formatted, q)
        except Exception:
            return (formatted, None)

    pairs = await asyncio.gather(*[_yf_one(s) for s in symbols])
    return {sym: q for sym, q in pairs if q}


async def get_quote(symbol: str, user_id: str) -> dict:
    """
    Get real-time quote for a symbol via the user's ZebuProvider.

    Raises:
        BrokerNotConnected       – user has no active session.
        ProviderDataUnavailable  – provider returned None for the symbol.
    """
    symbol = _format_symbol(symbol)
    provider = _get_provider_for_user(user_id)
    quote = await provider.get_quote(symbol)
    if quote is None:
        raise ProviderDataUnavailable(
            f"{type(provider).__name__} returned no data for {symbol}"
        )
    return _adjust_for_market_state(quote)


async def get_quote_safe(symbol: str, user_id: str) -> Optional[dict]:
    """
    Like get_quote() but returns None instead of raising on safe errors.

    Falls back to yfinance when no broker session is available so that
    demo-mode users always see price data.

    Runs provider + yfinance in parallel via asyncio.gather so neither
    task is ever cancelled mid-flight (avoids CancelledError 500s).
    """
    fmt = _format_symbol(symbol)

    # Deduplication: if identical request is in-flight, wait for it
    dedup_key = f"{fmt}:{user_id}"
    if dedup_key in _symbol_requests:
        try:
            return await _symbol_requests[dedup_key].task
        except Exception:
            pass  # Fall through to new request

    async def _fetch():
        try:
            provider_coro = None
            try:
                provider = _get_provider_for_user(user_id)
                provider_coro = _call_provider_with_timeout(
                    provider.get_quote(fmt), fmt, PROVIDER_TIMEOUT_SECONDS
                )
            except (BrokerNotConnected, RuntimeError):
                pass

            if provider_coro:
                # Run provider + yfinance in parallel; return_exceptions=True
                # means neither task is ever cancelled — no CancelledError.
                provider_result, yf_result = await asyncio.gather(
                    provider_coro,
                    get_yfinance_quote(fmt),
                    return_exceptions=True,
                )
                # Prefer provider result when fresh
                if (
                    not isinstance(provider_result, BaseException)
                    and provider_result
                    and not _is_quote_stale(provider_result)
                ):
                    return _adjust_for_market_state(provider_result)
                # Fall back to yfinance
                if not isinstance(yf_result, BaseException) and yf_result:
                    return yf_result
                return None
            else:
                return await get_yfinance_quote(fmt)
        except Exception as e:
            logger.debug(f"get_quote_safe({fmt}) error: {e}")
            return None

    request_task = asyncio.create_task(_fetch())
    _symbol_requests[dedup_key] = _RequestInFlight(request_task, time.time())
    try:
        return await request_task
    finally:
        if dedup_key in _symbol_requests:
            del _symbol_requests[dedup_key]


# ── System-level quote functions (no user context) ─────────────────


async def get_system_quote(symbol: str) -> dict:
    """
    Get a quote using ANY available provider session.
    For system-level tasks (workers, ZeroLoss) that don't have user context.

    Raises RuntimeError if no sessions exist.
    """
    symbol = _format_symbol(symbol)
    provider = _get_any_provider()
    quote = await provider.get_quote(symbol)
    if quote is None:
        raise ProviderDataUnavailable(
            f"{type(provider).__name__} returned no data for {symbol}"
        )
    return _adjust_for_market_state(quote)


async def get_system_quote_safe(symbol: str) -> Optional[dict]:
    """
    System-level quote using master Zebu or any active provider session.

    Falls back to yfinance when no master session is active so that
    ticker bars and indices always show data for demo users.

    Uses asyncio.gather (return_exceptions=True) — no task cancellation,
    no CancelledError 500s.
    """
    fmt = _format_symbol(symbol)

    # Deduplication: if identical request is in-flight, wait for it
    dedup_key = f"sys:{fmt}"
    if dedup_key in _symbol_requests:
        try:
            return await _symbol_requests[dedup_key].task
        except Exception:
            pass

    async def _fetch():
        try:
            provider_coro = None
            try:
                provider = _get_any_provider()
                provider_coro = _call_provider_with_timeout(
                    provider.get_quote(fmt), fmt, PROVIDER_TIMEOUT_SECONDS
                )
            except (RuntimeError, Exception):
                pass

            if provider_coro:
                provider_result, yf_result = await asyncio.gather(
                    provider_coro,
                    get_yfinance_quote(fmt),
                    return_exceptions=True,
                )
                if (
                    not isinstance(provider_result, BaseException)
                    and provider_result
                    and not _is_quote_stale(provider_result)
                ):
                    return _adjust_for_market_state(provider_result)
                if not isinstance(yf_result, BaseException) and yf_result:
                    return yf_result
                return None
            else:
                return await get_yfinance_quote(fmt)
        except Exception as e:
            logger.debug(f"get_system_quote_safe({fmt}) error: {e}")
            return None

    request_task = asyncio.create_task(_fetch())
    _symbol_requests[dedup_key] = _RequestInFlight(request_task, time.time())
    try:
        return await request_task
    finally:
        if dedup_key in _symbol_requests:
            del _symbol_requests[dedup_key]


# ── yfinance single-symbol quote (broker-free fallback) ────────────


def _get_yfinance_quote_sync(symbol: str) -> Optional[dict]:
    """Blocking yfinance single-symbol quote — runs in thread pool."""
    import yfinance as yf

    try:
        ticker = yf.Ticker(symbol)
        info = ticker.fast_info
        price = getattr(info, "last_price", None) or getattr(info, "previous_close", 0)
        prev_close = getattr(info, "previous_close", 0) or 0
        if not price:
            return None
        change = (price - prev_close) if prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0
        return {
            "symbol": symbol,
            "name": symbol.replace(".NS", "").replace("^", ""),
            "price": round(float(price), 2),
            "change": round(float(change), 2),
            "change_percent": round(float(change_pct), 2),
            "prev_close": round(float(prev_close), 2),
            "open": round(float(getattr(info, "open", 0) or 0), 2),
            "high": round(float(getattr(info, "day_high", 0) or 0), 2),
            "low": round(float(getattr(info, "day_low", 0) or 0), 2),
            "volume": int(getattr(info, "three_month_average_volume", 0) or 0),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        logger.debug(f"yfinance quote {symbol} failed: {e}")
        return None


async def get_yfinance_quote(symbol: str) -> Optional[dict]:
    """
    Get a single quote from yfinance — no broker session required.
    Results are cached for YF_QUOTE_CACHE_DURATION seconds.
    Returns normalized quote format.
    """
    now = time.time()
    if (
        symbol in _yf_quote_cache
        and (now - _yf_quote_cache_ts.get(symbol, 0)) < YF_QUOTE_CACHE_DURATION
    ):
        return _yf_quote_cache[symbol]

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_yf_executor, _get_yfinance_quote_sync, symbol)
    if result:
        normalized = _normalize_quote(result)
        if normalized:
            _yf_quote_cache[symbol] = normalized
            _yf_quote_cache_ts[symbol] = now
            return normalized
    return None


def _get_yfinance_history_sync(symbol: str, period: str, interval: str) -> list:
    """Blocking yfinance historical data — runs in thread pool."""
    import yfinance as yf

    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period=period, interval=interval)
        if df is None or df.empty:
            return []
        candles = []
        for ts, row in df.iterrows():
            try:
                unix_ts = int(ts.timestamp())
            except Exception:
                try:
                    unix_ts = int(ts) // 1_000_000_000
                except Exception:
                    continue

            try:
                o = float(row["Open"])
                h = float(row["High"])
                l = float(row["Low"])
                c = float(row["Close"])
            except (TypeError, ValueError):
                continue

            if not all(x > 0 for x in [o, h, l, c]):
                continue

            try:
                volume = int(float(row.get("Volume", 0) or 0))
            except (TypeError, ValueError):
                volume = 0

            candles.append(
                {
                    "time": unix_ts,
                    "open": round(o, 2),
                    "high": round(max(h, o, c, l), 2),
                    "low": round(min(l, o, c, h), 2),
                    "close": round(c, 2),
                    "volume": max(0, volume),
                }
            )
        return normalize_history_candles(candles)
    except Exception as e:
        logger.debug(f"yfinance history {symbol} failed: {e}")
        return []


async def get_yfinance_history(
    symbol: str, period: str = "1mo", interval: str = "1d"
) -> list:
    """Get historical OHLCV data from yfinance — no broker session required."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _yf_executor, _get_yfinance_history_sync, symbol, period, interval
    )


async def get_historical_data(
    symbol: str,
    period: str = "1mo",
    interval: str = "1d",
    user_id: Optional[str] = None,
) -> list:
    """
    Get historical OHLCV data for charts.

    OPTIMIZED: Runs provider + yfinance in parallel with timeout.
    Ensures charts never timeout even if provider hangs.
    """
    symbol = _format_symbol(symbol)

    # Cache key for in-flight deduplication (shared across users for same symbol window)
    # Historical candles are symbol/period/interval scoped and cached upstream in Redis,
    # so sharing in-flight work prevents N parallel users from triggering N provider calls.
    cache_key = f"hist:{symbol}:{period}:{interval}"
    if cache_key in _symbol_requests:
        try:
            return await _symbol_requests[cache_key].task
        except Exception:
            pass

    async def _fetch_history():
        # Run provider + yfinance in parallel and return first VALID dataset.
        provider_task = None
        tasks = []
        try:
            if user_id:
                provider = _get_provider_for_user(user_id)
            else:
                provider = _get_any_provider()

            provider_task = asyncio.create_task(
                _call_provider_with_timeout(
                    provider.get_historical_data(
                        symbol, period=period, interval=interval
                    ),
                    symbol,
                    PROVIDER_TIMEOUT_SECONDS,
                )
            )
            tasks.append(provider_task)
        except (BrokerNotConnected, RuntimeError):
            provider_task = None

        async def _fetch_yf_with_timeout():
            try:
                return await asyncio.wait_for(
                    get_yfinance_history(symbol, period=period, interval=interval),
                    timeout=5.0,
                )
            except (asyncio.TimeoutError, Exception) as e:
                logger.debug(f"yfinance history timeout/error for {symbol}: {e}")
                return []

        # Always fetch yfinance in parallel (don't serialize behind provider)
        yf_task = asyncio.create_task(_fetch_yf_with_timeout())
        tasks.append(yf_task)

        pending = set(tasks)
        try:
            while pending:
                done, pending = await asyncio.wait(
                    pending, return_when=asyncio.FIRST_COMPLETED
                )

                for finished in done:
                    try:
                        candles = finished.result()
                    except Exception as e:
                        logger.debug(f"Chart data task failed for {symbol}: {e}")
                        candles = []

                    normalized = normalize_history_candles(candles)
                    if normalized:
                        # Cancel any slower task; we already have valid chart data.
                        for leftover in pending:
                            leftover.cancel()
                        return normalized

            return []
        finally:
            for leftover in pending:
                leftover.cancel()

    request_task = asyncio.create_task(_fetch_history())
    _symbol_requests[cache_key] = _RequestInFlight(request_task, time.time())
    try:
        return await request_task
    finally:
        if cache_key in _symbol_requests:
            del _symbol_requests[cache_key]


async def search_stocks(query: str) -> list:
    """Search for Indian stocks — Zebu-first, multi-tier search.

    Priority order:
    1. Local NSE list (~400 stocks, instant, prefix-ranked)
    2. Zebu SearchScrip API (real broker data, covers ALL NSE stocks)
    3. Yahoo Finance search API (fallback when no broker connected)

    Zebu + Yahoo run in parallel for speed.
    Results are merged, deduplicated, and returned (max 20).
    """
    query_upper = query.upper().strip()
    if not query_upper:
        return []

    # ── Check search cache ─────────────────────────────────────────────────────
    now = time.time()
    if (
        query_upper in _search_cache
        and (now - _search_cache_ts.get(query_upper, 0)) < SEARCH_CACHE_DURATION
    ):
        return _search_cache[query_upper]

    # ── Step 0: Search indices (NIFTY, SENSEX, BANK NIFTY, etc.) ────────────
    index_matches = []
    for idx in INDIAN_INDICES:
        idx_name_upper = idx["name"].upper()
        idx_sym_upper = idx["symbol"].upper().replace("^", "")
        if (
            query_upper in idx_name_upper
            or query_upper in idx_sym_upper
            or idx_name_upper.startswith(query_upper)
        ):
            index_matches.append(
                {
                    "symbol": idx["symbol"],
                    "name": idx["name"],
                    "exchange": "NSE",
                    "kind": "index",
                }
            )

    # ── Step 1: Local search with ranking (instant) ────────────────────────────
    prefix_matches = []
    substring_matches = []
    for stock in NSE_STOCK_LIST:
        sym_upper = stock["symbol"].upper().replace(".NS", "")
        name_upper = stock["name"].upper()
        if sym_upper.startswith(query_upper) or name_upper.startswith(query_upper):
            prefix_matches.append(stock)
        elif query_upper in sym_upper or query_upper in name_upper:
            substring_matches.append(stock)
    local_results = index_matches + prefix_matches + substring_matches

    # ── Step 2: Remote searches (run in parallel) ──────────────────────────────
    # Try Zebu first (real broker data). Fall back to Yahoo only if Zebu
    # is unavailable (no broker connected).
    has_broker = False
    try:
        _get_any_provider()
        has_broker = True
    except (RuntimeError, Exception):
        pass

    # Always run Yahoo search as a supplement for broader coverage.
    # When broker is connected, Zebu runs in parallel with Yahoo for speed.
    import asyncio as _asyncio

    if has_broker:
        # Broker connected → run Zebu + Yahoo in parallel
        zebu_task = _asyncio.ensure_future(_search_zebu(query_upper))
        if _strict_zebu_only():
            zebu_results = await zebu_task
            yahoo_results = []
        else:
            yahoo_task = _asyncio.ensure_future(_search_yahoo(query_upper))
            zebu_results, yahoo_results = await _asyncio.gather(
                zebu_task, yahoo_task, return_exceptions=True
            )
        zebu_results = zebu_results if isinstance(zebu_results, list) else []
        yahoo_results = yahoo_results if isinstance(yahoo_results, list) else []
        remote_results = zebu_results + yahoo_results
    else:
        # No broker → strict mode disables Yahoo fallback
        if _strict_zebu_only():
            remote_results = []
        else:
            remote_results = await _search_yahoo(query_upper)

    # ── Step 3: Merge & deduplicate ────────────────────────────────────────────
    seen = set()
    merged = []

    # Local results first (best ranking, reliable names)
    for r in local_results:
        sym = r["symbol"]
        if sym not in seen:
            seen.add(sym)
            merged.append(r)

    # Then remote results (Zebu or Yahoo — whichever was used)
    for r in remote_results:
        sym = r["symbol"]
        if sym not in seen:
            seen.add(sym)
            merged.append(r)

    result = merged[:20]

    # Cache the result
    _search_cache[query_upper] = result
    _search_cache_ts[query_upper] = now

    return result


async def _search_zebu(query: str) -> list:
    """Search for instruments via Zebu SearchScrip API."""
    try:
        from providers.symbol_mapper import load_zebu_contracts

        provider = _get_any_provider()
        data = await provider._rest_post(
            "/SearchScrip",
            {
                "exch": "NSE",
                "stext": query,
            },
        )
        if not data or data.get("stat") != "Ok":
            return []

        results = []
        contracts_to_register = []
        for item in data.get("values", []):
            tsym = item.get("tsym", "")
            token = item.get("token", "")
            # Filter to EQ segment only
            if "-EQ" not in tsym:
                continue
            name = tsym.replace("-EQ", "")
            symbol = f"{name}.NS"
            results.append(
                {
                    "symbol": symbol,
                    "name": item.get("instname", name),
                    "exchange": "NSE",
                    "token": token,
                }
            )
            if token:
                contracts_to_register.append(
                    {"symbol": name, "token": token, "exchange": "NSE"}
                )

        # Register found tokens so subsequent quotes/history work without SearchScrip
        if contracts_to_register:
            load_zebu_contracts(contracts_to_register)

        return results[:15]
    except (RuntimeError, Exception) as e:
        logger.debug(f"Zebu SearchScrip failed: {e}")
        return []


def _search_yahoo_sync(query: str) -> list:
    """Search stocks via Yahoo Finance public search API (blocking)."""
    import requests

    try:
        url = "https://query2.finance.yahoo.com/v1/finance/search"
        params = {
            "q": query,
            "quotesCount": 15,
            "newsCount": 0,
            "enableFuzzyQuery": True,
        }
        headers = {"User-Agent": "Mozilla/5.0"}
        r = requests.get(url, params=params, headers=headers, timeout=5)
        r.raise_for_status()
        data = r.json()

        results = []
        seen_syms = set()
        for q in data.get("quotes", []):
            symbol = q.get("symbol", "")
            exchange = q.get("exchDisp", "")

            # Only include NSE stocks (skip BSE/BO, US, etc.)
            if not symbol.endswith(".NS"):
                # If it's a BSE listing, convert to NSE equivalent
                if symbol.endswith(".BO") and exchange in ("Bombay", "BSE"):
                    symbol = symbol.replace(".BO", ".NS")
                else:
                    continue

            # Filter out mutual funds (0P...), ETFs, and other non-equity symbols
            base = symbol.replace(".NS", "")
            if base.startswith("0P") or base.startswith("^") or not base[0].isalpha():
                continue

            name = (
                q.get("shortname", "")
                or q.get("longname", "")
                or symbol.replace(".NS", "")
            )
            # Deduplicate within Yahoo results
            if symbol in seen_syms:
                continue
            seen_syms.add(symbol)

            # Clean up ALL-CAPS names from Yahoo
            if name == name.upper() and len(name) > 4:
                name = name.title()

            results.append(
                {
                    "symbol": symbol,
                    "name": name,
                    "exchange": "NSE",
                }
            )
        return results
    except Exception as e:
        logger.debug(f"Yahoo Finance search failed for '{query}': {e}")
        return []


async def _search_yahoo(query: str) -> list:
    """Search stocks via Yahoo Finance — async wrapper."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_yf_executor, _search_yahoo_sync, query)


async def get_indices(user_id: Optional[str] = None) -> list:
    """Get Indian market indices — fetches all in parallel for speed."""
    import asyncio as _asyncio

    async def _fetch_one(idx_info):
        try:
            if user_id:
                quote = await get_quote_safe(idx_info["symbol"], user_id)
            else:
                quote = await get_system_quote_safe(idx_info["symbol"])
            if quote:
                quote["name"] = idx_info["name"]
                return quote
        except Exception:
            pass
        return None

    results = await _asyncio.gather(
        *[_fetch_one(idx) for idx in INDIAN_INDICES],
        return_exceptions=True,
    )
    return [r for r in results if isinstance(r, dict)]


async def get_ticker_data(user_id: Optional[str] = None) -> list:
    """
    Get indices + all popular stocks for the scrolling ticker bar.

    OPTIMIZED: All symbols fetched in parallel with per-item timeout.
    Each symbol runs provider + yfinance in parallel to ensure ticker never hangs.
    """
    import asyncio as _asyncio

    def _normalise_quote(raw_quote: Any, *, name: str, kind: str) -> Optional[dict]:
        if not raw_quote:
            return None
        if isinstance(raw_quote, Mapping):
            quote = dict(raw_quote)
        elif isinstance(raw_quote, dict):
            quote = raw_quote.copy()
        else:
            logger.warning(
                f"Ticker quote ignored for {name}: unexpected type {type(raw_quote).__name__}"
            )
            return None
        quote["name"] = name
        quote["kind"] = kind
        return quote

    async def _fetch_one(symbol: str, name: str, kind: str):
        """Fetch single ticker item with timeout protection."""
        try:
            coro = None
            if user_id:
                coro = get_quote_safe(symbol, user_id)
            else:
                coro = get_system_quote_safe(symbol)

            # Tight timeout for ticker items (2s)
            quote = await asyncio.wait_for(coro, timeout=2.0)
            return _normalise_quote(quote, name=name, kind=kind)
        except (asyncio.TimeoutError, Exception) as e:
            logger.debug(f"Ticker fetch timeout/error ({symbol}): {e}")
            return None

    # Build task list: indices first, then popular stocks
    tasks = []
    for idx_info in INDIAN_INDICES:
        tasks.append(_fetch_one(idx_info["symbol"], idx_info["name"], "index"))
    for stock in POPULAR_INDIAN_STOCKS:
        tasks.append(_fetch_one(stock["symbol"], stock["name"], "stock"))

    results = await _asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in results if isinstance(r, dict)]


async def get_batch_quotes(symbols: list[str], user_id: Optional[str] = None) -> dict:
    """
    Get quotes for multiple symbols in parallel.

    OPTIMIZED: Runs provider + yfinance in parallel with timeout.
    Provider has 3s timeout — if slow, yfinance kicks in immediately.
    Deduplicates concurrent identical requests.
    """
    symbol_list = [_format_symbol(s) for s in symbols if s]
    if not symbol_list:
        return {}

    # Deduplication: check if identical batch request is in-flight
    batch_key = f"batch:{','.join(sorted(symbol_list))}"
    if batch_key in _batch_requests:
        try:
            return await _batch_requests[batch_key].task
        except Exception:
            pass

    async def _fetch_batch():
        # Run provider + yfinance in PARALLEL (not sequential fallback)
        provider_task = None
        try:
            if user_id:
                provider = _get_provider_for_user(user_id)
            else:
                provider = _get_any_provider()

            provider_task = asyncio.create_task(
                _call_provider_with_timeout(
                    provider.get_batch_quotes(symbol_list),
                    ",".join(symbol_list[:3]),  # For logging
                    PROVIDER_TIMEOUT_SECONDS,
                )
            )
        except (BrokerNotConnected, RuntimeError):
            provider_task = None

        # Always fetch yfinance in parallel (don't wait for provider)
        yf_task = asyncio.create_task(_get_yfinance_batch_quotes(symbol_list))

        results = {}

        # Race: whichever finishes first or if provider times out
        if provider_task:
            try:
                provider_quotes = await asyncio.wait_for(
                    provider_task, timeout=PROVIDER_TIMEOUT_SECONDS
                )
                if provider_quotes and not _strict_zebu_only():
                    results.update(provider_quotes)
            except (asyncio.TimeoutError, Exception) as e:
                logger.debug(f"Provider batch timeout/error: {e}")

        # Fill missing symbols with yfinance
        missing = [
            s
            for s in symbol_list
            if s not in results or _is_quote_stale(results.get(s))
        ]
        if missing:
            try:
                yf_quotes = await asyncio.wait_for(yf_task, timeout=5.0)
                results.update({s: q for s, q in yf_quotes.items() if q})
            except (asyncio.TimeoutError, Exception) as e:
                logger.debug(f"Batch yfinance error: {e}")

        return {sym: _adjust_for_market_state(q) for sym, q in results.items() if q}

    request_task = asyncio.create_task(_fetch_batch())
    _batch_requests[batch_key] = _RequestInFlight(request_task, time.time())
    try:
        return await request_task
    finally:
        if batch_key in _batch_requests:
            del _batch_requests[batch_key]


# ── yfinance public ticker (no broker needed) ─────────────────────

# Cache for yfinance ticker data
_yf_ticker_cache: list = []
_yf_ticker_cache_ts: float = 0
YF_TICKER_CACHE_DURATION = 30  # 30 seconds

# Symbols for the public ticker
_YF_TICKER_SYMBOLS = [s["symbol"] for s in POPULAR_INDIAN_STOCKS[:10]]
_YF_INDEX_SYMBOLS = [idx["symbol"] for idx in INDIAN_INDICES]


# ── Simulated NSE stock fallback (demo resilience) ─────────────────
_stock_sim_state: dict = {}


def _stock_seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _guess_stock_base_price(symbol: str) -> float:
    """Deterministically pick a realistic INR base price for NSE symbols."""
    base = symbol.replace(".NS", "").replace(".BO", "").replace("^", "").upper()
    rng = random.Random(_stock_seed(base))

    # Known NSE/BSE price ranges (approx. 2024-2025 levels, INR)
    _KNOWN_RANGES: dict = {
        # Indices
        "NIFTY50": (21000, 26000), "NSEI": (21000, 26000),
        "BANKNIFTY": (44000, 55000), "NSEBANK": (44000, 55000),
        "CNXPHARMA": (18000, 23000), "CNXIT": (35000, 46000),
        "NIFTYMIDCAP100": (48000, 58000), "NIFTYNEXT50": (56000, 70000),
        "BSESN": (72000, 86000), "SENSEX": (72000, 86000),
        "CNXAUTO": (20000, 27000), "CNXMETAL": (8000, 12000),
        "CNXFMCG": (55000, 70000), "CNXPSUBANK": (6000, 8000),
        # ETFs (NAV-based, approx)
        "NIFTYBEES": (230, 270), "BANKBEES": (470, 540),
        "JUNIORBEES": (640, 730), "SBINEQWETF": (22, 28),
        "CPSEETF": (72, 90), "MAN50ETF": (200, 250),
        "ITBEES": (360, 440), "PHARMABEES": (180, 230),
        # Large caps
        "RELIANCE": (1200, 1600), "TCS": (3500, 4400),
        "HDFCBANK": (1500, 1800), "INFY": (1400, 1900),
        "ICICIBANK": (1100, 1400), "HINDUNILVR": (2300, 2900),
        "SBIN": (700, 950), "BHARTIARTL": (1400, 1900),
        "ITC": (400, 520), "KOTAKBANK": (1700, 2200),
        "LT": (3200, 4100), "AXISBANK": (1000, 1300),
        "BAJFINANCE": (6500, 8500), "ASIANPAINT": (2500, 3200),
        "MARUTI": (11000, 14500), "HCLTECH": (1600, 2200),
        "WIPRO": (450, 700), "ONGC": (240, 340),
        "POWERGRID": (280, 380), "NTPC": (330, 450),
        "SUNPHARMA": (1500, 1950), "DRREDDY": (1100, 1450),
        "CIPLA": (1400, 1750), "TECHM": (1500, 2000),
        "NESTLEIND": (2100, 2700), "BRITANNIA": (4800, 6200),
        "DIVISLAB": (4500, 5800), "TITAN": (3200, 4100),
        "ULTRACEMCO": (9500, 12500), "GRASIM": (2400, 3100),
        "BAJAJFINSV": (1500, 2100), "INDUSINDBK": (900, 1250),
        "EICHERMOT": (4200, 5500), "HINDALCO": (580, 780),
        "JSWSTEEL": (850, 1100), "TATASTEEL": (140, 185),
        "TATACONSUM": (950, 1250), "COALINDIA": (380, 500),
        "BPCL": (290, 420), "ADANIPORTS": (1100, 1550),
        "HEROMOTOCO": (4200, 5500), "APOLLOHOSP": (6800, 8800),
        "BAJAJAUTO": (8000, 10500), "SBILIFE": (1400, 1900),
        "HDFCLIFE": (580, 800), "DMART": (4000, 5800),
        "ADANIENT": (2800, 3800), "TATAPOWER": (380, 500),
        "HAVELLS": (1500, 1900), "DABUR": (500, 640),
        "PIDILITIND": (2700, 3400), "COLPAL": (2600, 3200),
        "MARICO": (580, 720), "GODREJCP": (1100, 1400),
        "PNB": (90, 140), "BANKBARODA": (200, 280),
        "CANARABANK": (90, 140), "YESBANK": (18, 30),
        "ZOMATO": (180, 280), "IRFC": (180, 260),
        "HAL": (3500, 4800), "BEL": (200, 310),
        "BHEL": (210, 290), "SAIL": (120, 175),
        "INDIGO": (3800, 5000), "IRCTC": (750, 1000),
        "RECLTD": (450, 620), "PFC": (400, 560),
    }

    # Normalize key: strip underscores and hyphens for flexible matching
    # e.g. NIFTY_MIDCAP_100 → NIFTYMIDCAP100, BAJAJ-AUTO → BAJAJAUTO
    normalized = base.replace("_", "").replace("-", "")
    lookup = normalized if normalized in _KNOWN_RANGES else base

    if lookup in _KNOWN_RANGES:
        lo, hi = _KNOWN_RANGES[lookup]
        return round(rng.uniform(lo, hi), 2)

    # Unknown symbol — use a modest mid-cap range rather than the full 80-4800 span
    return round(rng.uniform(200.0, 2000.0), 2)


def get_simulated_stock_quote(symbol: str) -> dict:
    """
    Return a realistic simulated NSE quote.
    Used only as a final fallback to keep demo mode functional.
    """
    fmt = _format_symbol(symbol)
    now = time.time()

    if fmt not in _stock_sim_state:
        seed = _stock_seed(fmt)
        rng = random.Random(seed)
        base = _guess_stock_base_price(fmt)
        prev_close = round(base * (1 + rng.uniform(-0.015, 0.015)), 2)
        _stock_sim_state[fmt] = {
            "base": base,
            "prev_close": prev_close,
            "price": prev_close,
            "last_tick": now,
            "rng": rng,
        }

    state = _stock_sim_state[fmt]
    rng = state["rng"]

    # When market is closed/weekend/holiday, freeze prices at prev_close.
    # Simulated prices must not random-walk while market is offline.
    closed_states = (MarketState.CLOSED, MarketState.WEEKEND, MarketState.HOLIDAY)
    if market_session.get_current_state() in closed_states:
        price = state["prev_close"]
        return {
            "symbol": fmt,
            "name": fmt.replace(".NS", "").replace(".BO", "").replace("^", ""),
            "price": price,
            "change": 0.0,
            "change_percent": 0.0,
            "prev_close": price,
            "open": price,
            "high": price,
            "low": price,
            "volume": 0,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": "simulated",
        }

    dt = max(0.0, now - state["last_tick"])
    if dt > 0:
        # Small random walk + gentle mean reversion to keep prices stable.
        drift = rng.gauss(0, 0.0015) * state["price"]
        revert = (state["base"] - state["price"]) * 0.0018
        new_price = state["price"] + drift + revert
        new_price = max(state["base"] * 0.90, min(state["base"] * 1.10, new_price))
        state["price"] = round(new_price, 2)
        state["last_tick"] = now

    price = state["price"]
    prev_close = state["prev_close"]
    change = round(price - prev_close, 2)
    change_pct = round((change / prev_close * 100) if prev_close else 0.0, 2)

    return {
        "symbol": fmt,
        "name": fmt.replace(".NS", "").replace(".BO", "").replace("^", ""),
        "price": price,
        "change": change,
        "change_percent": change_pct,
        "prev_close": prev_close,
        "open": round(prev_close * (1 + rng.uniform(-0.004, 0.004)), 2),
        "high": round(max(price, prev_close) * (1 + abs(rng.gauss(0, 0.003))), 2),
        "low": round(min(price, prev_close) * (1 - abs(rng.gauss(0, 0.003))), 2),
        "volume": rng.randint(80_000, 3_500_000),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "simulated",
    }


def get_simulated_history(
    symbol: str, period: str = "1mo", interval: str = "1d"
) -> list:
    """Generate deterministic synthetic OHLCV candles for charts in demo fallback."""
    fmt = _format_symbol(symbol)
    now = int(time.time())

    points_map = {
        "1d": 60,
        "5d": 100,
        "1mo": 120,
        "3mo": 180,
        "6mo": 220,
        "1y": 260,
        "2y": 300,
        "3y": 360,
        "5y": 420,
        "max": 500,
    }
    step_map = {
        "1m": 60,
        "2m": 120,
        "3m": 180,
        "5m": 300,
        "10m": 600,
        "15m": 900,
        "30m": 1800,
        "1h": 3600,
        "2h": 7200,
        "4h": 14400,
        "1d": 86400,
        "1wk": 604800,
        "1mo": 2592000,
    }
    points = points_map.get(period, 120)
    step = step_map.get(interval, 86400)

    quote = get_simulated_stock_quote(fmt)
    start_price = max(1.0, float(quote.get("price") or 100.0))
    rng = random.Random(_stock_seed(f"{fmt}:{period}:{interval}"))

    candles = []
    price = start_price
    start_ts = now - (points * step)
    for i in range(points):
        t = start_ts + (i * step)
        drift = rng.gauss(0, 0.0025) * price
        next_close = max(1.0, price + drift)
        high = max(price, next_close) * (1 + abs(rng.gauss(0, 0.002)))
        low = min(price, next_close) * (1 - abs(rng.gauss(0, 0.002)))
        candles.append(
            {
                "time": int(t),
                "open": round(price, 2),
                "high": round(high, 2),
                "low": round(low, 2),
                "close": round(next_close, 2),
                "volume": int(rng.randint(20_000, 800_000)),
            }
        )
        price = next_close

    return candles


def _fetch_yf_ticker_sync() -> list:
    """Batch yfinance ticker fetch — parallelized via ThreadPoolExecutor."""
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _fetch_one_ticker(symbol: str, name: str, kind: str) -> Optional[dict]:
        try:
            ticker = yf.Ticker(symbol)
            info = ticker.fast_info
            price = getattr(info, "last_price", None) or getattr(
                info, "previous_close", 0
            )
            prev_close = getattr(info, "previous_close", 0) or 0
            if not price:
                return None
            change = price - prev_close if prev_close else 0
            change_pct = (change / prev_close * 100) if prev_close else 0
            return {
                "symbol": symbol,
                "name": name,
                "price": round(price, 2),
                "change": round(change, 2),
                "change_percent": round(change_pct, 2),
                "prev_close": round(prev_close, 2),
                "kind": kind,
            }
        except Exception as e:
            logger.debug(f"yfinance {kind} {symbol} failed: {e}")
            return None

    items = []
    tasks = []

    with ThreadPoolExecutor(max_workers=6) as executor:
        # Submit all ticker fetches in parallel
        for idx_info in INDIAN_INDICES:
            tasks.append(
                executor.submit(
                    _fetch_one_ticker, idx_info["symbol"], idx_info["name"], "index"
                )
            )
        for stock in POPULAR_INDIAN_STOCKS[:10]:
            tasks.append(
                executor.submit(
                    _fetch_one_ticker, stock["symbol"], stock["name"], "stock"
                )
            )

        # Collect results as they complete (no need to wait for all)
        for future in as_completed(tasks):
            try:
                result = future.result(timeout=2.0)
                if result:
                    items.append(result)
            except Exception:
                pass

    return items


async def get_public_ticker_data() -> list:
    """Get ticker data from yfinance — no broker session required."""
    if _strict_zebu_only():
        return await get_ticker_data(user_id=None)

    global _yf_ticker_cache, _yf_ticker_cache_ts

    now = time.time()
    if _yf_ticker_cache and (now - _yf_ticker_cache_ts) < YF_TICKER_CACHE_DURATION:
        return _yf_ticker_cache

    try:
        loop = asyncio.get_event_loop()
        items = await loop.run_in_executor(_yf_executor, _fetch_yf_ticker_sync)
        if items:
            _yf_ticker_cache = items
            _yf_ticker_cache_ts = now
        return items
    except Exception as e:
        logger.error(f"yfinance public ticker failed: {e}")
        return _yf_ticker_cache  # return stale cache if available


# ── Commodity quotes (simulated MCX/NCDEX live prices in INR) ─────

# Persistent simulated state per commodity (survives across calls within a session)
_commodity_sim_state: dict = {}


def _commodity_seed(symbol: str) -> int:
    """Deterministic seed from symbol name."""
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _simulate_commodity_price(commodity: dict) -> dict:
    """
    Generate a realistic simulated MCX/NCDEX quote in INR.

    Uses the commodity's base_price as the anchor and applies small
    random walks so prices drift naturally across refreshes — similar
    to how the FuturesPage generates synthetic spot prices.
    """
    symbol = commodity["symbol"]
    base = commodity["base_price"]
    now = time.time()

    # Initialise state on first call
    if symbol not in _commodity_sim_state:
        seed = _commodity_seed(symbol)
        rng = random.Random(seed)
        # Start within ±1.5% of base
        initial_offset = base * rng.uniform(-0.015, 0.015)
        prev_close = round(base + initial_offset, 2)
        _commodity_sim_state[symbol] = {
            "prev_close": prev_close,
            "price": prev_close,
            "last_tick": now,
            "rng": rng,
        }

    state = _commodity_sim_state[symbol]
    rng = state["rng"]
    dt = now - state["last_tick"]

    # Apply a small random walk every time (capped at ±0.3% per tick)
    if dt > 0:
        volatility = 0.0012  # ~0.12% per tick
        drift = rng.gauss(0, volatility) * state["price"]
        # Mean-revert gently towards base_price
        revert = (base - state["price"]) * 0.002
        new_price = state["price"] + drift + revert
        # Clamp within ±5% of base to stay realistic
        new_price = max(base * 0.95, min(base * 1.05, new_price))
        state["price"] = round(new_price, 2)
        state["last_tick"] = now

    price = state["price"]
    prev_close = state["prev_close"]
    change = round(price - prev_close, 2)
    change_pct = round((change / prev_close * 100) if prev_close else 0, 2)

    return {
        "symbol": symbol,
        "name": commodity["name"],
        "price": price,
        "prev_close": prev_close,
        "change": change,
        "change_percent": change_pct,
        "open": round(prev_close + rng.uniform(-0.002, 0.002) * prev_close, 2),
        "high": round(max(price, prev_close) * (1 + abs(rng.gauss(0, 0.003))), 2),
        "low": round(min(price, prev_close) * (1 - abs(rng.gauss(0, 0.003))), 2),
        "volume": rng.randint(800, 25000),
        "exchange": commodity["exchange"],
        "category": commodity["category"],
        "unit": commodity["unit"],
        "lot": commodity.get("lot", 1),
        "kind": "commodity",
    }


async def get_commodity_quotes(user_id: Optional[str] = None) -> list:
    """
    Get MCX/NCDEX commodity quotes in INR.

    Priority:
      1. Redis cache (populated by MarketDataWorker from Zebu WebSocket ticks)
      2. Zebu REST API direct (if broker connected but no cache yet)
      3. Simulated prices (when no broker session available)

    Returns a list of quote dicts — one per commodity.
    """
    import asyncio as _asyncio

    # Check if any broker session is available
    has_broker = False
    try:
        _get_any_provider()
        has_broker = True
    except (RuntimeError, Exception):
        pass

    async def _fetch_one(commodity):
        symbol = commodity["symbol"]
        quote = None

        # 1. Try Redis cache (fastest — populated by MarketDataWorker)
        try:
            from cache.redis_client import get_price as redis_get_price

            cached = await redis_get_price(symbol)
            if cached and cached.get("price") and cached["price"] > 0:
                quote = cached
                quote["source"] = "live"
        except Exception:
            pass

        # 2. Try Zebu REST directly if cache miss
        if not quote and has_broker:
            try:
                provider = _get_any_provider()
                rest_quote = await provider.get_quote(symbol)
                if rest_quote and rest_quote.get("price") and rest_quote["price"] > 0:
                    quote = rest_quote
                    quote["source"] = "live"
            except Exception as e:
                logger.debug(f"Zebu commodity quote failed for {symbol}: {e}")

        # 3. No real data available
        if not quote:
            return None

        # Enrich with commodity metadata
        quote["name"] = commodity["name"]
        quote["exchange"] = commodity["exchange"]
        quote["category"] = commodity["category"]
        quote["unit"] = commodity["unit"]
        quote["lot"] = commodity.get("lot", 1)
        quote["kind"] = "commodity"
        return quote

    results = await _asyncio.gather(
        *[_fetch_one(c) for c in POPULAR_COMMODITIES],
        return_exceptions=True,
    )
    return [r for r in results if isinstance(r, dict)]


async def search_commodities(query: str) -> list:
    """Search commodities by name or symbol."""
    query_upper = query.upper().strip()
    if not query_upper:
        return []

    matches = []
    for c in POPULAR_COMMODITIES:
        sym_upper = c["symbol"].upper()
        name_upper = c["name"].upper()
        cat_upper = c["category"].upper()
        if (
            query_upper in sym_upper
            or query_upper in name_upper
            or query_upper in cat_upper
        ):
            matches.append(c)
    return matches
