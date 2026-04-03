"""
Redis Price Cache — Low-latency price storage for real-time data.

Redis Key Schema:
──────────────────────────────────────────────────────────────────
    alphasync:price:{symbol}            → JSON hash of latest quote
    alphasync:price:{symbol}:ts         → Unix timestamp of last update
    alphasync:subscriptions             → SET of currently subscribed symbols
    alphasync:provider:status           → JSON hash with provider health
    alphasync:price:all                 → HASH of symbol -> JSON quote (batch reads)

Key TTLs:
    Price data:    120 seconds (auto-expire stale data)
    Subscriptions: No TTL (managed explicitly)
    Provider info: 60 seconds

Design decisions:
    - Uses redis.asyncio for non-blocking I/O within the FastAPI event loop.
    - Every write sets a TTL so stale data is auto-evicted.
    - PriceCache wraps all Redis ops with error handling — callers never
      need to catch Redis exceptions.
    - Falls back gracefully if Redis is unavailable (logged warning, returns None).
"""

import json
import logging
import time
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

# ── Key prefix ──────────────────────────────────────────────────────
PREFIX = "alphasync"

# ── TTLs ────────────────────────────────────────────────────────────
PRICE_TTL = 120  # seconds — price keys auto-expire
PROVIDER_STATUS_TTL = 60  # seconds


def _key(kind: str, *parts: str) -> str:
    """Build a namespaced Redis key."""
    segments = [PREFIX, kind] + list(parts)
    return ":".join(segments)


class PriceCache:
    """
    Async Redis wrapper for the price cache layer.

    Usage:
        cache = PriceCache(redis_url="redis://localhost:6379/0")
        await cache.connect()
        await cache.set_price("RELIANCE.NS", {"price": 2513.45, ...})
        quote = await cache.get_price("RELIANCE.NS")
        await cache.close()
    """

    def __init__(self, redis_url: str = "redis://localhost:6379/0"):
        self._url = redis_url
        self._redis: Optional[aioredis.Redis] = None

    async def connect(self) -> None:
        """Establish Redis connection pool."""
        try:
            self._redis = aioredis.from_url(
                self._url,
                decode_responses=True,
                max_connections=20,
                socket_timeout=5.0,
                socket_connect_timeout=5.0,
                retry_on_timeout=True,
            )
            # Verify connectivity
            await self._redis.ping()
            logger.info(f"Redis connected: {self._url}")
        except Exception as e:
            logger.error(f"Redis connection failed: {e}")
            self._redis = None

    async def close(self) -> None:
        """Close Redis connection pool."""
        if self._redis:
            await self._redis.close()
            self._redis = None
            logger.info("Redis connection closed")

    @property
    def is_connected(self) -> bool:
        return self._redis is not None

    # ── Price operations ────────────────────────────────────────────

    async def set_price(self, symbol: str, quote: dict) -> bool:
        """
        Store a quote in Redis.

        Returns True on success, False on failure.
        """
        if not self._redis:
            return False

        try:
            key = _key("price", symbol)
            ts_key = _key("price", symbol, "ts")
            pipe = self._redis.pipeline()
            payload = json.dumps(quote, separators=(",", ":"))
            pipe.set(key, payload, ex=PRICE_TTL)
            pipe.set(ts_key, str(time.time()), ex=PRICE_TTL)
            # Also update the batch hash for bulk reads
            pipe.hset(_key("price", "all"), symbol, payload)
            await pipe.execute()
            return True
        except Exception as e:
            logger.warning(f"Redis set_price failed for {symbol}: {e}")
            return False

    async def set_prices_batch(self, quotes: dict[str, dict]) -> bool:
        """Store multiple quotes in Redis using a single pipeline round-trip."""
        if not self._redis or not quotes:
            return False

        try:
            batch_key = _key("price", "all")
            now = str(time.time())
            pipe = self._redis.pipeline()
            for symbol, quote in quotes.items():
                payload = json.dumps(quote, separators=(",", ":"))
                pipe.set(_key("price", symbol), payload, ex=PRICE_TTL)
                pipe.set(_key("price", symbol, "ts"), now, ex=PRICE_TTL)
                pipe.hset(batch_key, symbol, payload)
            await pipe.execute()
            return True
        except Exception as e:
            logger.warning(
                f"Redis set_prices_batch failed ({len(quotes)} symbols): {e}"
            )
            return False

    async def get_price(self, symbol: str) -> Optional[dict]:
        """
        Fetch latest quote for a symbol from Redis.

        Returns None if key doesn't exist or Redis is unavailable.
        """
        if not self._redis:
            return None

        try:
            raw = await self._redis.get(_key("price", symbol))
            if raw:
                return json.loads(raw)
            return None
        except Exception as e:
            logger.warning(f"Redis get_price failed for {symbol}: {e}")
            return None

    async def get_batch_prices(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch quotes for multiple symbols in a single round-trip."""
        if not self._redis or not symbols:
            return {}

        try:
            pipe = self._redis.pipeline()
            for s in symbols:
                pipe.get(_key("price", s))
            results = await pipe.execute()

            quotes = {}
            for sym, raw in zip(symbols, results):
                if raw:
                    quotes[sym] = json.loads(raw)
            return quotes
        except Exception as e:
            logger.warning(f"Redis get_batch_prices failed: {e}")
            return {}

    async def get_all_prices(self) -> dict[str, dict]:
        """Fetch all cached prices from the batch hash."""
        if not self._redis:
            return {}

        try:
            raw_map = await self._redis.hgetall(_key("price", "all"))
            return {sym: json.loads(data) for sym, data in raw_map.items()}
        except Exception as e:
            logger.warning(f"Redis get_all_prices failed: {e}")
            return {}

    async def delete_price(self, symbol: str) -> None:
        """Remove a symbol's price data from Redis."""
        if not self._redis:
            return

        try:
            pipe = self._redis.pipeline()
            pipe.delete(_key("price", symbol))
            pipe.delete(_key("price", symbol, "ts"))
            pipe.hdel(_key("price", "all"), symbol)
            await pipe.execute()
        except Exception as e:
            logger.warning(f"Redis delete_price failed for {symbol}: {e}")

    # ── Subscription tracking ───────────────────────────────────────

    async def set_subscriptions(self, symbols: set[str]) -> None:
        """Store the current subscription set in Redis."""
        if not self._redis:
            return

        try:
            key = _key("subscriptions")
            pipe = self._redis.pipeline()
            pipe.delete(key)
            if symbols:
                pipe.sadd(key, *symbols)
            await pipe.execute()
        except Exception as e:
            logger.warning(f"Redis set_subscriptions failed: {e}")

    async def get_subscriptions(self) -> set[str]:
        """Retrieve the active subscription set."""
        if not self._redis:
            return set()

        try:
            members = await self._redis.smembers(_key("subscriptions"))
            return set(members)
        except Exception as e:
            logger.warning(f"Redis get_subscriptions failed: {e}")
            return set()

    # ── Provider status ─────────────────────────────────────────────

    async def set_provider_status(self, status: dict) -> None:
        """Store provider health info for monitoring dashboards."""
        if not self._redis:
            return

        try:
            await self._redis.set(
                _key("provider", "status"),
                json.dumps(status),
                ex=PROVIDER_STATUS_TTL,
            )
        except Exception as e:
            logger.warning(f"Redis set_provider_status failed: {e}")

    async def get_provider_status(self) -> Optional[dict]:
        """Retrieve provider health info."""
        if not self._redis:
            return None

        try:
            raw = await self._redis.get(_key("provider", "status"))
            return json.loads(raw) if raw else None
        except Exception as e:
            logger.warning(f"Redis get_provider_status failed: {e}")
            return None

    # ── Ticker bar cache (indices + popular stocks) ──────────────────

    async def set_ticker(self, items: list) -> None:
        """Cache the full ticker bar payload (indices + stocks)."""
        if not self._redis:
            return
        try:
            await self._redis.setex(_key("ticker", "all"), 10, json.dumps(items))
        except Exception as e:
            logger.debug(f"Redis set_ticker failed: {e}")

    async def get_ticker(self) -> Optional[list]:
        """Get cached ticker bar payload."""
        if not self._redis:
            return None
        try:
            raw = await self._redis.get(_key("ticker", "all"))
            return json.loads(raw) if raw else None
        except Exception as e:
            logger.debug(f"Redis get_ticker failed: {e}")
            return None

    # ── Indices cache ───────────────────────────────────────────────

    async def set_indices(self, items: list) -> None:
        """Cache the indices (NIFTY, SENSEX, etc.)."""
        if not self._redis:
            return
        try:
            await self._redis.setex(_key("indices", "all"), 10, json.dumps(items))
        except Exception as e:
            logger.debug(f"Redis set_indices failed: {e}")

    async def get_indices(self) -> Optional[list]:
        """Get cached indices."""
        if not self._redis:
            return None
        try:
            raw = await self._redis.get(_key("indices", "all"))
            return json.loads(raw) if raw else None
        except Exception as e:
            logger.debug(f"Redis get_indices failed: {e}")
            return None

    # ── Historical OHLCV cache ──────────────────────────────────────

    async def set_history(
        self, symbol: str, period: str, interval: str, candles: list
    ) -> None:
        """Cache OHLCV candles for a symbol."""
        if not self._redis:
            return
        try:
            await self._redis.setex(
                _key("history", symbol, period, interval),
                300,  # 5 min TTL for candles
                json.dumps(candles),
            )
        except Exception as e:
            logger.debug(f"Redis set_history({symbol}) failed: {e}")

    async def get_history(
        self, symbol: str, period: str, interval: str
    ) -> Optional[list]:
        """Get cached candles for a symbol."""
        if not self._redis:
            return None
        try:
            raw = await self._redis.get(_key("history", symbol, period, interval))
            return json.loads(raw) if raw else None
        except Exception as e:
            logger.debug(f"Redis get_history({symbol}) failed: {e}")
            return None

    # ── Health check ────────────────────────────────────────────────

    async def ping(self) -> bool:
        """Check Redis connectivity."""
        if not self._redis:
            return False
        try:
            return await self._redis.ping()
        except Exception:
            return False


# ── Module-level singleton ──────────────────────────────────────────
_price_cache: Optional[PriceCache] = None
_DEFAULT_REDIS_URL = "redis://localhost:6379/0"
_last_reconnect_attempt: float = 0.0
_RECONNECT_INTERVAL = 30.0  # seconds between reconnect attempts


def _get_redis_url(redis_url: Optional[str] = None) -> str:
    """Resolve Redis URL: explicit arg → settings → hardcoded default."""
    if redis_url:
        return redis_url
    try:
        from config.settings import settings

        url = getattr(settings, "REDIS_URL", None)
        if url:
            return url
    except Exception:
        pass
    return _DEFAULT_REDIS_URL


async def get_redis(redis_url: Optional[str] = None) -> PriceCache:
    """Get or create the global PriceCache singleton, with reconnect on disconnect."""
    global _price_cache, _last_reconnect_attempt
    now = time.time()

    if _price_cache is None:
        _price_cache = PriceCache(_get_redis_url(redis_url))
        await _price_cache.connect()
    elif (
        not _price_cache.is_connected
        and (now - _last_reconnect_attempt) > _RECONNECT_INTERVAL
    ):
        # Redis was down at startup or dropped — try to reconnect periodically.
        _last_reconnect_attempt = now
        await _price_cache.connect()

    return _price_cache


async def close_redis() -> None:
    """Close the global PriceCache."""
    global _price_cache
    if _price_cache:
        await _price_cache.close()
        _price_cache = None


# ── Convenience module-level functions ──────────────────────────────────────


async def set_price(symbol: str, quote: dict) -> None:
    """Write a price/quote to Redis."""
    cache = await get_redis()
    await cache.set_price(symbol, quote)


async def set_prices_batch(quotes: dict[str, dict]) -> bool:
    """Write multiple prices to Redis in one pipeline."""
    cache = await get_redis()
    return await cache.set_prices_batch(quotes)


async def get_price(symbol: str) -> Optional[dict]:
    """Read a cached price/quote."""
    cache = await get_redis()
    return await cache.get_price(symbol)


async def get_batch_prices(symbols: list[str]) -> dict[str, dict]:
    """Read multiple cached prices in one Redis pipeline round-trip."""
    cache = await get_redis()
    return await cache.get_batch_prices(symbols)


async def set_ticker(items: list) -> None:
    """Cache the ticker bar."""
    cache = await get_redis()
    await cache.set_ticker(items)


async def get_ticker() -> Optional[list]:
    """Get cached ticker."""
    cache = await get_redis()
    return await cache.get_ticker()


async def set_indices(items: list) -> None:
    """Cache indices."""
    cache = await get_redis()
    await cache.set_indices(items)


async def get_indices() -> Optional[list]:
    """Get cached indices."""
    cache = await get_redis()
    return await cache.get_indices()


async def set_history(symbol: str, period: str, interval: str, candles: list) -> None:
    """Cache historical candles."""
    cache = await get_redis()
    await cache.set_history(symbol, period, interval, candles)


async def get_history(symbol: str, period: str, interval: str) -> Optional[list]:
    """Get cached candles."""
    cache = await get_redis()
    return await cache.get_history(symbol, period, interval)


async def is_available() -> bool:
    """Check if Redis is available."""
    cache = await get_redis()
    return await cache.ping()
