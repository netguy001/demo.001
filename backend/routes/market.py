import logging
import asyncio
from fastapi import APIRouter, Query, Depends, HTTPException
from typing import Optional
from services import market_data
from config.settings import settings
from routes.auth import get_current_user, get_current_user_optional
from models.user import User
from engines.market_session import market_session
from cache.smart_cache import (
    quote_cache,
    history_cache,
    indices_cache,
    ticker_cache,
    search_cache,
)

router = APIRouter(prefix="/api/market", tags=["Market Data"])
logger = logging.getLogger(__name__)


def _strict_zebu_only() -> bool:
    return bool(getattr(settings, "STRICT_ZEBU_MARKET_DATA", False))


@router.get("/session")
async def get_market_session():
    """Market session info — public, no auth required."""
    return market_session.get_session_info()


@router.get("/quote/{symbol}")
async def get_quote(
    symbol: str, user: Optional[User] = Depends(get_current_user_optional)
):
    """
    Get quote for a symbol.
    SmartCache (in-memory) → Redis → provider → yfinance.
    """
    # 0. In-memory SmartCache (<1μs)
    cache_key = f"q:{symbol}"
    mem_cached = quote_cache.get(cache_key)
    if mem_cached:
        return mem_cached

    # 1. Try Redis cache (written by master session worker)
    try:
        from cache.redis_client import get_price as redis_get_price

        cached = await redis_get_price(symbol)
        if cached:
            quote_cache.set(cache_key, cached, ttl=5)
            return cached
    except Exception as e:
        logger.debug(f"Redis quote read failed ({symbol}): {e}")

    # 2. Fallback: fetch via user's provider (now includes yfinance fallback)
    quote = None
    try:
        quote = await market_data.get_quote_safe(symbol, user.id if user else "")
        if quote:
            quote = market_data._normalize_quote(quote)
    except Exception as e:
        logger.warning(f"Quote fetch failed for {symbol}: {e}")
    if quote:
        quote_cache.set(cache_key, quote, ttl=5)
        return quote

    # 3. Final fallback: direct yfinance quote
    if user is None or not _strict_zebu_only():
        yf_quote = await market_data.get_yfinance_quote(
            market_data._format_symbol(symbol)
        )
        if yf_quote:
            quote_cache.set(cache_key, yf_quote, ttl=5)
            return yf_quote

    # 4. Final demo fallback: synthetic quote so simulation mode never appears broken
    if settings.SIMULATION_MODE and not _strict_zebu_only():
        sim_quote = market_data.get_simulated_stock_quote(symbol)
        if sim_quote:
            normalized = market_data._normalize_quote(sim_quote)
            if normalized:
                quote_cache.set(cache_key, normalized, ttl=5)
                return normalized

    raise HTTPException(status_code=404, detail="Symbol not found or data unavailable")


@router.get("/search")
async def search_stocks(q: str = Query(..., min_length=1)):
    """Search is provider-independent — no auth required. Cached 5 min."""
    cache_key = f"search:{q.upper()}"
    cached = search_cache.get(cache_key)
    if cached is not None:
        return cached

    results = await market_data.search_stocks(q)
    response = {"results": results}
    search_cache.set(cache_key, response, ttl=300)
    return response


@router.get("/history/{symbol}")
async def get_history(
    symbol: str,
    period: str = Query("1mo", pattern="^(1d|5d|1mo|3mo|6mo|1y|2y|3y|5y|max)$"),
    interval: str = Query("1d", pattern="^(1m|2m|3m|5m|10m|15m|30m|1h|2h|4h|1d|1wk|1mo)$"),
    user: Optional[User] = Depends(get_current_user_optional),
):
    """Historical OHLCV — SmartCache → Redis → provider → yfinance."""
    # 0. In-memory SmartCache
    cache_key = f"hist:{symbol}:{period}:{interval}"
    mem_cached = history_cache.get(cache_key)
    if mem_cached:
        return mem_cached

    # 1. Try Redis cache for history
    try:
        from cache.redis_client import get_history as redis_get_history

        cached = await redis_get_history(symbol, period, interval)
        if cached:
            cached = market_data.normalize_history_candles(cached)
        if cached:
            response = {
                "symbol": symbol,
                "candles": cached,
                "count": len(cached),
                "source": "cache",
            }
            history_cache.set(cache_key, response, ttl=60)
            return response
    except Exception as e:
        logger.debug(f"Redis history read failed ({symbol}): {e}")

    data = await market_data.get_historical_data(
        symbol,
        period,
        interval,
        user_id=user.id if user else None,
    )
    data = market_data.normalize_history_candles(data)

    # If provider + built-in fallback returned nothing, try yfinance directly
    if not data and (user is None or not _strict_zebu_only()):
        formatted = market_data._format_symbol(symbol)
        data = await market_data.get_yfinance_history(
            formatted, period=period, interval=interval
        )
        data = market_data.normalize_history_candles(data)

    # Write to Redis for next caller
    if data:
        try:
            from cache.redis_client import set_history as redis_set_history

            await redis_set_history(symbol, period, interval, data)
        except Exception:
            pass

    # Final demo fallback for chart continuity
    if not data and settings.SIMULATION_MODE and not _strict_zebu_only():
        data = market_data.get_simulated_history(
            symbol, period=period, interval=interval
        )
        data = market_data.normalize_history_candles(data)

    response = {"symbol": symbol, "candles": data, "count": len(data)}
    if data:
        history_cache.set(cache_key, response, ttl=60)
    return response


@router.get("/indices")
async def get_indices(user: Optional[User] = Depends(get_current_user_optional)):
    """
    Index quotes — SmartCache → Redis → provider → yfinance.
    """
    # 0. In-memory SmartCache
    mem_cached = indices_cache.get("indices:all")
    if mem_cached:
        return mem_cached

    try:
        from cache.redis_client import get_indices as redis_get_indices

        cached = await redis_get_indices()
        if cached:
            response = {"indices": cached}
            indices_cache.set("indices:all", response, ttl=8)
            return response
    except Exception as e:
        logger.debug(f"Redis indices read failed: {e}")

    # Fetch indices with timeout
    try:
        indices = await asyncio.wait_for(
            market_data.get_indices(user_id=user.id if user else None), timeout=2.5
        )
        if indices:
            response = {"indices": indices}
            indices_cache.set("indices:all", response, ttl=8)
            return response
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"Indices fetch timeout/error: {e}")

    if _strict_zebu_only() and user is not None:
        return {"indices": []}

    # Fallback: fetch indices via yfinance (parallelized) with aggressive timeout
    if not _strict_zebu_only():
        try:
            yf_tasks = [
                market_data.get_yfinance_quote(idx_info["symbol"])
                for idx_info in market_data.INDIAN_INDICES
            ]
            yf_results = await asyncio.wait_for(
                asyncio.gather(*yf_tasks, return_exceptions=True), timeout=2.0
            )
            yf_indices = []
            for idx_info, result in zip(market_data.INDIAN_INDICES, yf_results):
                if result and not isinstance(result, Exception):
                    yf_q = result
                    yf_q["name"] = idx_info["name"]
                    yf_indices.append(yf_q)
            response = {"indices": yf_indices}
            if yf_indices:
                indices_cache.set("indices:all", response, ttl=8)
            return response
        except (asyncio.TimeoutError, Exception) as fallback_err:
            logger.debug(f"Indices yfinance fallback timeout/error: {fallback_err}")
    return {"indices": []}


@router.get("/ticker")
async def get_ticker(user: Optional[User] = Depends(get_current_user_optional)):
    """
    Ticker bar — SmartCache → Redis → provider → yfinance.
    """
    # 0. In-memory SmartCache
    mem_cached = ticker_cache.get("ticker:all")
    if mem_cached:
        return mem_cached

    try:
        from cache.redis_client import get_ticker as redis_get_ticker

        cached = await redis_get_ticker()
        if cached:
            response = {"items": cached, "source": "cache"}
            ticker_cache.set("ticker:all", response, ttl=8)
            return response
    except Exception as e:
        logger.debug(f"Redis ticker read failed: {e}")

    # Cache miss — fetch live with tight timeout to prevent hanging
    try:
        items = await asyncio.wait_for(
            market_data.get_ticker_data(user_id=user.id if user else None), timeout=3.0
        )
        # Write to Redis for next caller
        if items:
            try:
                from cache.redis_client import set_ticker as redis_set_ticker

                await redis_set_ticker(items)
            except Exception:
                pass
        response = {"items": items}
        if items:
            ticker_cache.set("ticker:all", response, ttl=8)
        return response
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"/api/market/ticker timeout/error (provider): {e}")
        if not _strict_zebu_only():
            try:
                items = await asyncio.wait_for(
                    market_data.get_public_ticker_data(), timeout=2.0
                )
                if items:
                    ticker_cache.set("ticker:all", {"items": items}, ttl=8)
                    return {"items": items}
            except (asyncio.TimeoutError, Exception) as fallback_err:
                logger.debug(f"Ticker fallback timeout/error: {fallback_err}")
        raise HTTPException(
            status_code=503, detail="Market ticker temporarily unavailable"
        )


@router.get("/ticker/public")
async def get_public_ticker():
    """
    Public ticker — NO auth required. SmartCache → Redis → yfinance.
    """
    mem_cached = ticker_cache.get("ticker:public")
    if mem_cached:
        return mem_cached

    try:
        from cache.redis_client import get_ticker as redis_get_ticker

        cached = await redis_get_ticker()
        if cached:
            response = {"items": cached, "source": "cache"}
            ticker_cache.set("ticker:public", response, ttl=8)
            return response
    except Exception:
        pass

    items = await market_data.get_public_ticker_data()
    response = {"items": items}
    if items:
        ticker_cache.set("ticker:public", response, ttl=8)
    return response


@router.get("/popular")
async def get_popular_stocks():
    return {"stocks": market_data.POPULAR_INDIAN_STOCKS}


@router.get("/commodities")
async def get_commodities():
    """Get live quotes for all popular commodities — public, no auth required."""
    cache_key = "commodities:all"
    mem_cached = indices_cache.get(cache_key)
    if mem_cached:
        return mem_cached

    quotes = await market_data.get_commodity_quotes()
    response = {"commodities": quotes}
    if quotes:
        indices_cache.set(cache_key, response, ttl=30)
    return response


@router.get("/commodities/list")
async def get_commodity_list():
    """Return static list of available commodities."""
    return {"commodities": market_data.POPULAR_COMMODITIES}


@router.get("/commodities/search")
async def search_commodities(q: str = Query(..., min_length=1)):
    """Search commodities by name, symbol, or category."""
    results = await market_data.search_commodities(q)
    return {"results": results}


@router.get("/batch")
async def batch_quotes(
    symbols: str = Query(..., description="Comma-separated symbols"),
    user: Optional[User] = Depends(get_current_user_optional),
):
    """
    Batch quote endpoint — OPTIMIZED to return quickly.

    Request timeout: 5 seconds (prevents hanging)
    Redis batch pipeline: Single round-trip instead of per-symbol loops
    Parallel market_data fallback: Provider + yfinance in parallel
    """
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        return {"quotes": {}}

    def _with_ns(sym: str) -> str:
        if sym.startswith("^") or sym.endswith(".NS") or sym.endswith(".BO"):
            return sym
        return f"{sym}.NS"

    def _base(sym: str) -> str:
        return sym.replace(".NS", "").replace(".BO", "")

    def _aliases(sym: str) -> set[str]:
        with_ns = _with_ns(sym)
        base = _base(with_ns)
        return {sym, with_ns, base}

    def _upsert_aliases(target: dict, sym: str, quote: dict):
        if not quote:
            return
        for alias in _aliases(sym):
            target[alias] = quote

    def _has_quote(target: dict, sym: str) -> bool:
        for alias in _aliases(sym):
            if alias in target and target[alias]:
                return True
        return False

    results = {}
    missing = []

    # OPTIMIZED: Batch Redis read instead of per-symbol loop
    try:
        from cache.redis_client import get_batch_prices

        # Fetch all symbols from Redis in one pipeline call
        redis_quotes = await get_batch_prices(symbol_list)
        for sym, quote in redis_quotes.items():
            _upsert_aliases(results, sym, quote)

        # Find what's still missing from Redis
        missing = [sym for sym in symbol_list if not _has_quote(results, sym)]
    except Exception:
        missing = symbol_list

    # Get missing quotes in parallel (provider + yfinance already parallelized)
    if missing:
        try:
            live = await asyncio.wait_for(
                market_data.get_batch_quotes(
                    missing,
                    user_id=user.id if user else None,
                ),
                timeout=3.0,  # Tight timeout for batch endpoint
            )
            for sym, quote in (live or {}).items():
                _upsert_aliases(results, sym, quote)
        except (asyncio.TimeoutError, Exception) as e:
            logger.debug(f"Batch quotes timeout/error: {e}")

    # Normalize all final quotes to standard format before returning
    final_quotes = {}
    for sym, q in results.items():
        if q:
            normalized = market_data._normalize_quote(q)
            if normalized:
                final_quotes[sym] = normalized

    return {"quotes": final_quotes}


@router.get("/provider/health")
async def provider_health(user: User = Depends(get_current_user)):
    from services.broker_session import broker_session_manager

    provider = broker_session_manager.get_session(user.id)
    if not provider:
        return {
            "status": "not_connected",
            "message": "No personal broker connected — using master session",
        }
    try:
        health = await provider.health()
        return health.to_dict()
    except Exception as e:
        return {"status": "error", "error": str(e)}
