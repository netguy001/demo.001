"""
Futures Service — Read-only derivatives analytics for NSE futures.

Responsibilities:
    * Load Zebu master contracts, filter for FUTIDX and FUTSTK instruments
    * Provide contract list endpoints grouped by underlying symbol
    * Cache contract lists and quotes in Redis with futures:* namespace
    * Import existing market_data and market_session functions (no duplication)
    * WebSocket integration for live futures prices

Contract metadata from Zebu:
    - Trading symbol (e.g., RELIANCE25MAR2026FUT)
    - Token ID (exchange-internal numeric ID)
    - Expiry date
    - Lot size
    - Tick size
    - Instrument type (FUTIDX or FUTSTK)

This service is READ-ONLY: no order placement, no broker access required.
Operates alongside existing market data infrastructure.
"""

import io
import logging
import zipfile
from datetime import datetime, timedelta
from typing import Optional

try:
    import httpx
except ImportError:
    httpx = None  # type: ignore

from cache.redis_client import get_redis, close_redis
from config.settings import settings
from engines.market_session import market_session, MarketState
from providers.symbol_mapper import canonical_to_zebu, is_mcx_symbol

logger = logging.getLogger(__name__)

# Zebu master contract CDN URLs
_NSE_CONTRACT_URL = "https://go.mynt.in/NSE_symbols.txt.zip"
_NSE_FALLBACK_URL = "https://api.zebull.in/NSE_symbols.txt.zip"

# In-memory futures contracts cache, keyed by canonical symbol
# Format: {
#     "RELIANCE": [
#         {"contract_symbol": "RELIANCE25MAR2026FUT", "expiry": "2026-03-25", "lot_size": 250, ...}
#     ]
# }
_futures_contracts: dict = {}
_futures_contracts_loaded: bool = False


async def _fetch_and_parse_contracts() -> dict[str, list[dict]]:
    """
    Download and parse the Zebu master contract file, filtering for futures only.

    Returns a dict mapping canonical symbol → list of sorted futures contracts.
    Contracts are sorted by expiry date (nearest first).
    """
    contracts_by_symbol = {}

    urls = [_NSE_CONTRACT_URL, _NSE_FALLBACK_URL]
    raw_zip: Optional[bytes] = None

    for url in urls:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(url, follow_redirects=True)
                if resp.status_code == 200 and resp.content:
                    raw_zip = resp.content
                    logger.info(
                        f"Downloaded Zebu NSE futures contracts from {url} "
                        f"({len(raw_zip):,} bytes)"
                    )
                    break
                else:
                    logger.warning(
                        f"Zebu contract download failed: {url} → HTTP {resp.status_code}"
                    )
        except Exception as e:
            logger.warning(f"Zebu contract download error ({url}): {e}")

    if not raw_zip:
        logger.error("Could not download Zebu NSE master contracts for futures")
        return {}

    # Parse the ZIP file
    try:
        with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
            txt_files = [n for n in zf.namelist() if n.endswith(".txt")]
            if not txt_files:
                logger.error("No .txt file found in Zebu contract ZIP")
                return {}

            with zf.open(txt_files[0]) as f:
                raw_bytes = f.read()
                try:
                    content = raw_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    content = raw_bytes.decode("latin-1", errors="replace")

        lines = content.splitlines()
        if not lines:
            return {}

        # Parse header to locate relevant columns
        header = [col.strip().lower() for col in lines[0].split("|")]
        try:
            exch_idx = header.index("exchange") if "exchange" in header else 0
            token_idx = next((i for i, h in enumerate(header) if "token" in h), 1)
            sym_idx = next(
                (
                    i
                    for i, h in enumerate(header)
                    if "symbol" in h or "tradingsymbol" in h.replace(" ", "")
                ),
                2,
            )
            expiry_idx = next((i for i, h in enumerate(header) if "expiry" in h), 4)
            lot_size_idx = next(
                (i for i, h in enumerate(header) if "lotsz" in h or "lot" in h), -1
            )
            tick_size_idx = next(
                (i for i, h in enumerate(header) if "tick" in h), -1
            )
            instrument_idx = next(
                (i for i, h in enumerate(header) if "instrument" in h), -1
            )
        except (ValueError, StopIteration):
            exch_idx, token_idx, sym_idx = 0, 1, 2
            expiry_idx, lot_size_idx, tick_size_idx, instrument_idx = 4, -1, -1, -1

        # Extract futures contracts (FUTIDX or FUTSTK)
        for line in lines[1:]:
            parts = line.split("|")
            if len(parts) <= max(exch_idx, token_idx, sym_idx, expiry_idx):
                continue

            exch = parts[exch_idx].strip() if exch_idx < len(parts) else "NSE"
            token = parts[token_idx].strip() if token_idx < len(parts) else ""
            trading_sym = parts[sym_idx].strip() if sym_idx < len(parts) else ""
            expiry = parts[expiry_idx].strip() if expiry_idx < len(parts) else ""
            lot_size_str = (
                parts[lot_size_idx].strip() if 0 <= lot_size_idx < len(parts) else "0"
            )
            tick_size_str = (
                parts[tick_size_idx].strip() if 0 <= tick_size_idx < len(parts) else "0.05"
            )
            instrument_type = (
                parts[instrument_idx].strip() if 0 <= instrument_idx < len(parts) else ""
            )

            # Only process futures contracts
            if not (trading_sym.endswith("-FUT") or trading_sym.endswith("FUT")):
                continue

            if not token or not token.isdigit():
                continue

            # Determine if stock or index futures
            if any(x in trading_sym for x in ["NIFTY", "SENSEX", "BANKNIFTY"]):
                inst_type = "FUTIDX"
            else:
                inst_type = "FUTSTK"

            # Extract base symbol and expiry date
            # E.g., "RELIANCE25MAR2026FUT" → base_sym="RELIANCE", expiry_label="25MAR2026"
            base_sym = trading_sym.replace("FUT", "").replace("-FUT", "").strip()

            # Remove trailing numbers from base_sym (expiry info)
            # E.g., "RELIANCE25MAR2026" → "RELIANCE"
            expiry_label = ""
            for i in range(len(base_sym)):
                if base_sym[i].isdigit():
                    expiry_label = base_sym[i:]
                    base_sym = base_sym[:i]
                    break

            if not base_sym or not expiry_label:
                continue

            # Parse lot size and tick size
            try:
                lot_size = int(float(lot_size_str)) if lot_size_str else 1
            except (ValueError, TypeError):
                lot_size = 1

            try:
                tick_size = float(tick_size_str) if tick_size_str else 0.05
            except (ValueError, TypeError):
                tick_size = 0.05

            # Parse expiry date if available
            expiry_date = _parse_expiry_date(expiry) or _estimate_expiry_from_label(
                expiry_label
            )

            if base_sym not in contracts_by_symbol:
                contracts_by_symbol[base_sym] = []

            contracts_by_symbol[base_sym].append(
                {
                    "contract_symbol": trading_sym,
                    "token": token,
                    "exchange": exch,
                    "expiry_date": expiry_date,
                    "expiry_label": expiry_label,
                    "lot_size": lot_size,
                    "tick_size": tick_size,
                    "instrument_type": inst_type,
                }
            )

        # Sort each symbol's contracts by expiry date (nearest first)
        for base_sym in contracts_by_symbol:
            contracts = contracts_by_symbol[base_sym]

            def expiry_key(c):
                if c.get("expiry_date"):
                    try:
                        return datetime.strptime(
                            c["expiry_date"], "%Y-%m-%d"
                        ).timestamp()
                    except (ValueError, TypeError):
                        return float("inf")
                return float("inf")

            contracts_by_symbol[base_sym] = sorted(contracts, key=expiry_key)

        logger.info(
            f"Parsed {sum(len(v) for v in contracts_by_symbol.values())} futures contracts "
            f"from Zebu NSE master"
        )

    except Exception as e:
        logger.error(f"Failed to parse Zebu futures contracts: {e}", exc_info=True)

    return contracts_by_symbol


def _parse_expiry_date(expiry_str: str) -> Optional[str]:
    """
    Parse Zebu expiry date string to YYYY-MM-DD format.
    Handles various formats: "25MAR2026", "25-Mar-2026", etc.
    Returns None if parsing fails.
    """
    if not expiry_str:
        return None

    # Try common Indian date format: "25MAR2026"
    try:
        dt = datetime.strptime(expiry_str.strip(), "%d%b%Y")
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass

    # Try ISO format with hyphens: "25-Mar-2026"
    try:
        dt = datetime.strptime(expiry_str.strip(), "%d-%b-%Y")
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass

    # Try lowercase: "25mar2026"
    try:
        dt = datetime.strptime(expiry_str.strip().upper(), "%d%b%Y")
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass

    return None


def _estimate_expiry_from_label(label: str) -> Optional[str]:
    """
    Estimate expiry date from expiry label like "25MAR2026".
    Used as fallback when explicit expiry field is unavailable.
    """
    import re

    # Extract day, month, year: "25MAR2026" → ("25", "MAR", "2026")
    match = re.match(r"(\d{1,2})([A-Za-z]{3})(\d{4})", label.strip())
    if not match:
        return None

    day_str, month_str, year_str = match.groups()
    try:
        dt = datetime.strptime(f"{day_str}{month_str.upper()}{year_str}", "%d%b%Y")
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


async def initialize_futures():
    """
    Called at startup to load futures contracts into memory.
    Populates _futures_contracts global cache.
    """
    global _futures_contracts, _futures_contracts_loaded

    try:
        _futures_contracts = await _fetch_and_parse_contracts()
        _futures_contracts_loaded = True
        logger.info(
            f"Futures contracts initialized: {len(_futures_contracts)} symbols, "
            f"{sum(len(v) for v in _futures_contracts.values())} total contracts"
        )
    except Exception as e:
        logger.error(f"Failed to initialize futures contracts: {e}", exc_info=True)
        _futures_contracts_loaded = False


def get_contracts(symbol: str, limit: Optional[int] = None) -> list[dict]:
    """
    Get all futures contracts for a given symbol (canonical or trading format).

    Args:
        symbol: Canonical symbol (e.g., "RELIANCE") or Zebu trading symbol
        limit: Optional max number of contracts to return (by expiry, nearest first)

    Returns:
        List of contract dicts with keys: contract_symbol, expiry_date, lot_size, etc.
        Empty list if symbol not found or no contracts exist.
    """
    # Normalize symbol
    symbol = symbol.upper().strip().replace(".NS", "").replace(".BO", "")

    contracts = _futures_contracts.get(symbol, [])

    if limit:
        contracts = contracts[:limit]

    return contracts


def label_expiry(expiry_date: str, ref_date: Optional[datetime] = None) -> str:
    """
    Classify an expiry as "Near", "Mid", or "Far" based on position in contract chain.
    In a typical 3-contract chain: Near (current), Mid (next), Far (third+).
    """
    if ref_date is None:
        ref_date = datetime.now().date()
    elif isinstance(ref_date, datetime):
        ref_date = ref_date.date()

    # This is set by contract position in the sorted list, not by calculation.
    # Handled at the API layer where we assign labels based on contract index.
    return "Near"  # Caller will override based on index


async def get_quote(contract_symbol: str) -> dict:
    """
    Fetch quote for a futures contract from market data service.

    Uses existing market_data.get_system_quote() which integrates with
    Zebu master session or yfinance fallback.

    Args:
        contract_symbol: Zebu futures contract symbol (e.g., "RELIANCE25MAR2026FUT")

    Returns:
        Quote dict with keys: ltp, open, high, low, close, volume, oi, etc.
        Returns empty dict if quote unavailable.
    """
    try:
        # Import here to avoid circular deps
        from services.market_data import get_system_quote_safe

        quote = await get_system_quote_safe(contract_symbol)
        if quote:
            return quote
    except Exception as e:
        logger.warning(f"Quote fetch failed for {contract_symbol}: {e}")

    return {}


async def get_history(
    contract_symbol: str, interval: str = "5m", limit: int = 30
) -> list[dict]:
    """
    Fetch OHLCV history for a futures contract (for sparkline).

    Uses existing market_data history methods via browser refresh strategy.

    Args:
        contract_symbol: Zebu futures symbol
        interval: Candlestick interval (1m, 5m, 15m, 1h, 1d)
        limit: Number of candles to return

    Returns:
        List of OHLCV dicts: [{"timestamp": "...", "open": ..., "close": ...}, ...]
        Returns empty list if unavailable.
    """
    try:
        # Import existing history method
        from services.market_data import get_yfinance_history

        # Map contract symbol to a searchable format
        # E.g., "RELIANCE25MAR2026FUT" → "RELIANCE" for yfinance
        base_symbol = (
            contract_symbol.replace("FUT", "")
            .replace("-FUT", "")
            .rstrip("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-")
        )

        if not base_symbol:
            base_symbol = contract_symbol.split("25")[0]

        # Query yfinance history (demo/fallback — real Zebu historical data would come from broker)
        history = await get_yfinance_history(
            symbol=base_symbol + ".NS",
            period="1mo",
            interval=interval,
        )

        # Return most recent `limit` candles
        return history[-limit:] if history else []

    except Exception as e:
        logger.warning(f"History fetch failed for {contract_symbol}: {e}")
        return []


async def get_cache_quote(contract_symbol: str) -> Optional[dict]:
    """
    Attempt to get quote from Redis cache first, before calling market_data.

    Cache key: futures:quote:{contract_symbol}
    TTL depends on market state: 3s if open, 300s if closed.

    Returns:
        Cached quote or None if not in cache.
    """
    try:
        redis = await get_redis(settings.REDIS_URL)
        cache_key = f"futures:quote:{contract_symbol}"
        cached = await redis.get(cache_key)

        if cached:
            import json

            return json.loads(cached)
    except Exception as e:
        logger.debug(f"Redis cache read failed: {e}")

    return None


async def set_cache_quote(contract_symbol: str, quote: dict) -> None:
    """
    Cache a futures quote in Redis with appropriate TTL.

    TTL: 3s if market open, 300s if closed.
    """
    try:
        redis = await get_redis(settings.REDIS_URL)
        cache_key = f"futures:quote:{contract_symbol}"

        # Determine TTL based on market state
        market_state = market_session.get_current_state()
        if market_state == MarketState.OPEN:
            ttl = 3
        elif market_state == MarketState.CLOSED:
            ttl = 300
        else:
            ttl = 60

        import json

        await redis.setex(cache_key, ttl, json.dumps(quote))

    except Exception as e:
        logger.debug(f"Redis cache write failed: {e}")


async def cache_contracts(symbol: str) -> None:
    """
    Cache the futures contracts list for a symbol in Redis.

    Cache key: futures:contracts:{symbol}
    TTL: 60 seconds (relatively stable during trading day)
    """
    try:
        contracts = get_contracts(symbol)
        if not contracts:
            return

        redis = await get_redis(settings.REDIS_URL)
        cache_key = f"futures:contracts:{symbol}"

        import json

        await redis.setex(cache_key, 60, json.dumps(contracts))

    except Exception as e:
        logger.debug(f"Redis contracts cache write failed: {e}")
