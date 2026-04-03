"""
Market Data Worker — Background price streaming.

Reads prices from any available ZebuProvider session and emits
PRICE_UPDATED events via the EventBus. Downstream consumers
(WebSocket manager, Order Worker, ZeroLoss) subscribe to these events.

Per-user architecture:
    - No global provider. Worker uses broker_session_manager.get_any_session().
    - If no sessions exist, the worker idles (no data to stream).
    - When a user connects their broker, a session appears and the
      worker resumes streaming.
"""

import asyncio
import logging

from config.settings import settings
from core.event_bus import event_bus, Event, EventType
from engines.market_session import market_session, MarketState
from cache.smart_cache import quote_cache

logger = logging.getLogger(__name__)


class MarketDataWorker:
    """
    Fetches live prices from any available broker session and emits events.

    Interval adapts to market state:
    - Open:   3 seconds between sweeps
    - Closed: 60 seconds (reduced frequency)
    """

    ACTIVE_INTERVAL = 3  # seconds between full sweeps
    IDLE_INTERVAL = 60  # seconds when market closed
    NO_SESSION_INTERVAL = 10  # seconds when no broker sessions
    BATCH_SIZE = 16
    BATCH_TIMEOUT_SECONDS = 2.5

    def __init__(self):
        self._running = False
        self._subscribed_symbols: set[str] = set()
        self._stats = {"sweeps": 0, "emits": 0, "no_session_waits": 0}

    def add_symbol(self, symbol: str) -> None:
        """Add a symbol to the streaming set."""
        self._subscribed_symbols.add(symbol)

    def remove_symbol(self, symbol: str) -> None:
        """Remove a symbol from the streaming set."""
        self._subscribed_symbols.discard(symbol)

    def get_stats(self) -> dict:
        """Return worker stats."""
        return {
            **self._stats,
            "symbols": list(self._subscribed_symbols),
            "symbol_count": len(self._subscribed_symbols),
        }

    @staticmethod
    def _chunked(items: list[str], size: int) -> list[list[str]]:
        return [items[i : i + size] for i in range(0, len(items), size)]

    @staticmethod
    def _build_ticker_items(quotes_by_symbol: dict[str, dict]) -> list[dict]:
        from services.market_data import (
            POPULAR_INDIAN_STOCKS,
            INDIAN_INDICES,
            POPULAR_COMMODITIES,
        )

        ticker_items: list[dict] = []

        for idx in INDIAN_INDICES:
            q = quotes_by_symbol.get(idx["symbol"])
            if q:
                item = dict(q)
                item["name"] = idx["name"]
                item["kind"] = "index"
                ticker_items.append(item)

        for stock in POPULAR_INDIAN_STOCKS:
            q = quotes_by_symbol.get(stock["symbol"])
            if q:
                item = dict(q)
                item["name"] = stock["name"]
                item["kind"] = "stock"
                ticker_items.append(item)

        for comm in POPULAR_COMMODITIES:
            q = quotes_by_symbol.get(comm["symbol"])
            if q:
                item = dict(q)
                item["name"] = comm["name"]
                item["kind"] = "commodity"
                item["exchange"] = comm["exchange"]
                item["category"] = comm["category"]
                item["unit"] = comm["unit"]
                item["lot"] = comm.get("lot", 1)
                ticker_items.append(item)

        return ticker_items

    async def _publish_quotes(
        self, quotes_by_symbol: dict[str, dict], source: str
    ) -> None:
        if not quotes_by_symbol:
            return

        self._stats["emits"] += len(quotes_by_symbol)

        try:
            from cache.redis_client import set_prices_batch

            await set_prices_batch(quotes_by_symbol)
        except Exception as _re:
            logger.debug(f"Redis batch write skipped ({source}): {_re}")

        for symbol, normalized in quotes_by_symbol.items():
            quote_cache.set(f"q:{symbol}", normalized, ttl=5)
            await event_bus.emit(
                Event(
                    type=EventType.PRICE_UPDATED,
                    data={"symbol": symbol, "quote": normalized},
                    source=source,
                )
            )

    async def run(self) -> None:
        """Main loop — started via asyncio.create_task in lifespan."""
        self._running = True
        logger.info("Market Data Worker started (per-user architecture)")

        # Auto-subscribe popular symbols + MCX commodities
        from services.market_data import (
            POPULAR_INDIAN_STOCKS,
            INDIAN_INDICES,
            POPULAR_COMMODITIES,
        )

        for s in POPULAR_INDIAN_STOCKS:
            self._subscribed_symbols.add(s["symbol"])
        for i in INDIAN_INDICES:
            self._subscribed_symbols.add(i["symbol"])
        for c in POPULAR_COMMODITIES:
            self._subscribed_symbols.add(c["symbol"])

        while self._running:
            try:
                # CHECK MARKET STATE — adapt polling frequency
                actual_state = market_session.get_current_state()
                market_closed = actual_state in (
                    MarketState.WEEKEND,
                    MarketState.HOLIDAY,
                    MarketState.CLOSED,
                )

                # NOTE: We no longer skip data generation when market is closed.
                # Demo users still need price data (previous close / yfinance).
                # We just reduce polling frequency.

                # Get any available provider session
                from services.broker_session import broker_session_manager

                provider = broker_session_manager.get_any_session()

                if provider is None:
                    # No broker sessions — optionally use yfinance fallback for demo mode
                    self._stats["no_session_waits"] += 1
                    if self._stats["no_session_waits"] % 30 == 1:
                        logger.debug(
                            "MarketDataWorker: No broker sessions, "
                            "waiting for live provider session"
                        )
                    # Emit yfinance prices every 3 cycles (~30s, matches cache TTL)
                    if (not settings.STRICT_ZEBU_MARKET_DATA) and self._stats[
                        "no_session_waits"
                    ] % 3 == 1:
                        try:
                            from services.market_data import get_public_ticker_data

                            items = await get_public_ticker_data()
                            quotes_by_symbol = {
                                item.get("symbol"): item
                                for item in items
                                if item.get("symbol")
                            }
                            await self._publish_quotes(
                                quotes_by_symbol, source="market_data_worker_yf"
                            )
                        except Exception as e:
                            logger.debug(f"yfinance fallback emit failed: {e}")
                    await asyncio.sleep(self.NO_SESSION_INTERVAL)
                    continue

                # Sweep all subscribed symbols
                symbols = list(self._subscribed_symbols)
                sweep_quotes: dict[str, dict] = {}

                if symbols:
                    for batch in self._chunked(symbols, self.BATCH_SIZE):
                        if not self._running:
                            break

                        try:
                            quotes = await asyncio.wait_for(
                                provider.get_batch_quotes(batch),
                                timeout=self.BATCH_TIMEOUT_SECONDS,
                            )
                        except asyncio.TimeoutError:
                            logger.debug(
                                f"MarketDataWorker batch timeout ({len(batch)} symbols)"
                            )
                            continue
                        except Exception as e:
                            logger.debug(f"MarketDataWorker batch fetch failed: {e}")
                            continue

                        if quotes:
                            sweep_quotes.update(quotes)
                            await self._publish_quotes(
                                quotes, source="market_data_worker"
                            )

                self._stats["sweeps"] += 1

                # After each full sweep, refresh the ticker cache in Redis
                # so all API calls to /ticker immediately get fresh data
                try:
                    from cache.redis_client import (
                        set_ticker,
                        set_indices,
                    )

                    ticker_items = self._build_ticker_items(sweep_quotes)
                    if ticker_items:
                        await set_ticker(ticker_items)
                        await set_indices(
                            [i for i in ticker_items if i.get("kind") == "index"]
                        )
                except Exception as _te:
                    logger.debug(f"Ticker cache refresh failed: {_te}")

                # Adapt polling frequency: 3s when market open, 60s when closed
                interval = self.IDLE_INTERVAL if market_closed else self.ACTIVE_INTERVAL
                await asyncio.sleep(interval)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Market Data Worker error: {e}", exc_info=True)
                await asyncio.sleep(5)

        logger.info("Market Data Worker stopped")

    async def stop(self) -> None:
        """Gracefully stop the worker."""
        self._running = False


# ── Singleton ──────────────────────────────────────────────────────
market_data_worker = MarketDataWorker()
