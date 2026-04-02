"""
ZebuProvider — Real-time market data via Zebu WebSocket feed.

Architecture:
    - Single global WebSocket connection to Zebu's streaming API
    - Token-based subscription management
    - Incoming ticks are parsed, normalized to canonical Quote format,
      and stored in Redis for low-latency reads
    - Emits nothing on its own — MarketDataWorker reads from this provider
    - Auto-reconnect with exponential backoff
    - Heartbeat monitoring to detect dead connections

Zebu WebSocket Protocol (NorenOMS):
    - Connect to: wss://ws1.zebull.in/NorenWS/
    - Auth via connection request with jKey (session token)
    - Subscribe with exchange|token pairs
    - Tick data arrives as JSON with lp (last price), v (volume), etc.

IMPORTANT: This provider is for MARKET DATA ONLY.
    - No broker credentials stored
    - No demat account access
    - No real order placement
    - Single read-only data feed
"""

import asyncio
import calendar
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import websockets
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    InvalidStatusCode,
)

from providers.base import (
    MarketProvider,
    ProviderHealth,
    ProviderStatus,
)
from providers.symbol_mapper import (
    canonical_to_zebu,
    zebu_token_to_canonical,
    load_zebu_contracts,
    is_mcx_symbol,
)
from services.broker_safety import is_safe_websocket_message

logger = logging.getLogger(__name__)


class ZebuProvider(MarketProvider):
    """
    Zebu WebSocket-based market data provider.

    Per-user instances created by BrokerSessionManager after OAuth.
    Each instance connects with the user's own session token.
    """

    # ── Reconnect strategy ──────────────────────────────────────────
    RECONNECT_BASE_DELAY = 1.0  # seconds
    RECONNECT_MAX_DELAY = 60.0  # cap backoff at 60s
    RECONNECT_BACKOFF_FACTOR = 2.0
    MAX_RECONNECT_ATTEMPTS = 50  # give up after this many consecutive failures

    # ── Heartbeat ───────────────────────────────────────────────────
    HEARTBEAT_INTERVAL = 30.0  # send ping every 30s
    HEARTBEAT_TIMEOUT = 10.0  # expect pong within 10s

    def __init__(
        self,
        ws_url: str,
        user_id: str = "",
        api_key: str = "",
        session_token: str = "",
        redis_client=None,  # Optional: cache/redis_client.PriceCache
        api_url: str = "",  # REST API base URL (e.g. https://go.mynt.in/NorenWClientTP)
    ):
        self._ws_url = ws_url
        self._user_id = user_id
        self._api_key = api_key
        self._session_token = session_token
        self._redis: Optional[object] = redis_client
        self._api_url = api_url.rstrip("/") if api_url else ""

        # Connection state
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._status = ProviderStatus.DISCONNECTED
        self._started_at: Optional[float] = None
        self._last_tick_at: Optional[float] = None
        self._reconnect_count = 0
        self._consecutive_failures = 0

        # Subscription tracking
        self._subscribed_symbols: set[str] = set()  # canonical symbols
        self._pending_subscribe: set[str] = set()  # queued while disconnected

        # In-memory latest prices (always available even without Redis)
        self._price_cache: dict[str, dict] = {}

        # Background tasks
        self._recv_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._running = False

        # Lock for credential updates (prevent race during reconnect)
        self._credential_lock = asyncio.Lock()

    def _ws_is_closed(self) -> bool:
        """Check if WebSocket is closed — compatible with websockets v10-v14+."""
        if not self._ws:
            return True
        try:
            return self._ws.closed  # websockets < 14
        except AttributeError:
            return self._ws.close_code is not None  # websockets 14+

    # ── Lifecycle ───────────────────────────────────────────────────

    async def start(self) -> None:
        """Connect to Zebu WebSocket and start receiving data."""
        self._running = True
        self._started_at = time.time()
        logger.info(
            f"ZebuProvider.start() | ws_url={self._ws_url} | "
            f"user_id={'*' * 4 + self._user_id[-4:] if self._user_id else 'NONE'} | "
            f"has_token={bool(self._session_token)}"
        )

        if not self.has_credentials():
            logger.warning(
                "ZebuProvider started without credentials — "
                "waiting for broker session manager to inject them."
            )
            self._status = ProviderStatus.DISCONNECTED
            return

        await self._connect()

    async def stop(self) -> None:
        """Gracefully disconnect."""
        self._running = False

        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()

        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

        self._status = ProviderStatus.DISCONNECTED
        logger.info("ZebuProvider stopped")

    # ── Dynamic credential update ───────────────────────────────────

    async def update_credentials(self, user_id: str, session_token: str) -> None:
        """
        Hot-swap the authentication credentials and reconnect.

        Called by BrokerSessionManager when the active token changes
        (e.g. user connect/disconnect/token rotation).

        This triggers a clean disconnect + reconnect cycle so the
        WebSocket re-authenticates with the new token.
        """
        async with self._credential_lock:
            old_user = self._user_id
            self._user_id = user_id
            self._session_token = session_token

            logger.info(
                f"ZebuProvider credentials updated: "
                f"{str(old_user)[:8] if old_user else 'none'}... → "
                f"{str(user_id)[:8] if user_id else 'none'}..."
            )

            if not session_token:
                # No token — disconnect but keep running for later reconnect
                if self._ws and not self._ws_is_closed():
                    try:
                        await self._ws.close()
                    except Exception:
                        pass
                self._status = ProviderStatus.DISCONNECTED
                return

            # Reconnect with new credentials
            if self._running:
                # Stop current recv/heartbeat tasks
                if self._heartbeat_task and not self._heartbeat_task.done():
                    self._heartbeat_task.cancel()
                if self._recv_task and not self._recv_task.done():
                    self._recv_task.cancel()
                if self._ws and not self._ws_is_closed():
                    try:
                        await self._ws.close()
                    except Exception:
                        pass

                self._consecutive_failures = 0
                await self._connect()

    def has_credentials(self) -> bool:
        """Check if valid credentials are configured."""
        return bool(self._user_id and self._session_token)

    # ── Connection management ───────────────────────────────────────

    async def _connect(self) -> None:
        """Establish WebSocket connection and authenticate."""
        self._status = ProviderStatus.CONNECTING
        logger.debug(
            f"ZebuProvider._connect() | url={self._ws_url} | "
            f"subscribed_symbols={len(self._subscribed_symbols)} | "
            f"reconnect_count={self._reconnect_count}"
        )

        try:
            self._ws = await websockets.connect(
                self._ws_url,
                ping_interval=None,  # we handle heartbeats ourselves
                ping_timeout=None,
                close_timeout=10,
                max_size=2**20,  # 1 MB max message
            )

            # ── Authenticate ────────────────────────────────────────
            auth_msg = {
                "t": "c",  # connection type
                "uid": self._user_id,
                "actid": self._user_id,
                "susertoken": self._session_token,
                "source": "API",
            }
            if not is_safe_websocket_message(auth_msg):
                logger.error(
                    "Safety guard blocked auth message — this should never happen"
                )
                self._status = ProviderStatus.ERROR
                return

            await self._ws.send(json.dumps(auth_msg))

            # Wait for auth response
            raw = await asyncio.wait_for(self._ws.recv(), timeout=10.0)
            resp = json.loads(raw)

            if resp.get("s") != "OK":
                error_msg = resp.get("emsg", "Unknown auth error")
                logger.error(f"ZebuProvider auth failed: {error_msg}")
                self._status = ProviderStatus.ERROR
                return

            self._status = ProviderStatus.CONNECTED
            self._consecutive_failures = 0
            logger.info(
                f"ZebuProvider connected and authenticated | "
                f"user={str(self._user_id)[:8] if self._user_id else '?'}... | "
                f"pending_resubscribe={len(self._subscribed_symbols)}"
            )

            # Re-subscribe symbols that were active before reconnect
            if self._subscribed_symbols:
                await self._send_subscribe(self._subscribed_symbols)

            # Subscribe any symbols queued while disconnected
            if self._pending_subscribe:
                await self._send_subscribe(self._pending_subscribe)
                self._subscribed_symbols.update(self._pending_subscribe)
                self._pending_subscribe.clear()

            # Start background receivers
            self._recv_task = asyncio.create_task(self._receive_loop())
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        except Exception as e:
            logger.error(f"ZebuProvider connection failed: {e}")
            self._status = ProviderStatus.ERROR
            if self._running:
                asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        """Reconnect with exponential backoff."""
        if not self._running:
            return

        self._consecutive_failures += 1
        if self._consecutive_failures > self.MAX_RECONNECT_ATTEMPTS:
            logger.error(
                f"ZebuProvider: Max reconnect attempts ({self.MAX_RECONNECT_ATTEMPTS}) reached. Giving up."
            )
            self._status = ProviderStatus.ERROR
            return

        delay = min(
            self.RECONNECT_BASE_DELAY
            * (self.RECONNECT_BACKOFF_FACTOR ** (self._consecutive_failures - 1)),
            self.RECONNECT_MAX_DELAY,
        )
        self._status = ProviderStatus.RECONNECTING
        self._reconnect_count += 1

        logger.warning(
            f"ZebuProvider reconnecting in {delay:.1f}s "
            f"(attempt {self._consecutive_failures}/{self.MAX_RECONNECT_ATTEMPTS})"
        )
        await asyncio.sleep(delay)

        if self._running:
            await self._connect()

    # ── Data receiving ──────────────────────────────────────────────

    async def _receive_loop(self) -> None:
        """Main loop that reads messages from Zebu WebSocket."""
        try:
            async for raw_message in self._ws:
                if not self._running:
                    break

                try:
                    data = json.loads(raw_message)
                    msg_type = data.get("t")

                    if msg_type == "tk" or msg_type == "tf":
                        # Touchline / tick data
                        await self._handle_tick(data)
                    elif msg_type == "dk" or msg_type == "df":
                        # Depth data (order book) — log but don't process yet
                        logger.debug(f"Zebu depth data: {data.get('tk', 'unknown')}")
                    elif msg_type == "om":
                        # Order update — ignore (we don't place real orders)
                        pass
                    elif msg_type == "hb":
                        # Heartbeat response
                        logger.debug("Zebu heartbeat received")
                    else:
                        logger.debug(f"Zebu unknown message type: {msg_type}")

                except json.JSONDecodeError:
                    logger.warning(f"Zebu non-JSON message: {raw_message[:100]}")
                except Exception as e:
                    logger.error(f"Zebu tick processing error: {e}", exc_info=True)

        except ConnectionClosed as e:
            logger.warning(
                f"ZebuProvider WebSocket closed: code={e.code} reason={e.reason}"
            )
        except ConnectionClosedError as e:
            logger.warning(f"ZebuProvider connection closed with error: {e}")
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error(f"ZebuProvider receive loop error: {e}", exc_info=True)

        # Connection lost — reconnect
        if self._running:
            self._status = ProviderStatus.RECONNECTING
            asyncio.create_task(self._reconnect())

    async def _handle_tick(self, data: dict) -> None:
        """
        Parse Zebu tick data and update price cache + Redis.

        Zebu tick format (touchline):
            {
                "t": "tk",          # touchline acknowledgement / "tf" for update
                "e": "NSE",         # exchange
                "tk": "2885",       # token
                "ts": "RELIANCE-EQ",# trading symbol
                "lp": "2513.45",   # last traded price
                "pc": "1.25",      # percent change
                "v": "1234567",    # volume
                "o": "2498.00",    # open
                "h": "2525.00",    # high
                "l": "2490.00",    # low
                "c": "2482.10",    # close (previous)
                "ap": "2505.00",   # average price
                "bp1": "2513.00",  # best buy price
                "sp1": "2513.50",  # best sell price
                "ft": "1709123456",# feed timestamp
            }

        NOTE: "tf" (update) ticks often omit fields that haven't changed
        (e.g., "c" prev_close is only in the initial "tk" ack). We must
        merge with the previous tick to preserve values like prev_close.
        """
        token = data.get("tk", "")
        canonical = zebu_token_to_canonical(token)

        if not canonical:
            # Unknown token — might be a new symbol not in our map
            logger.debug(f"Zebu tick for unmapped token: {token}")
            return

        self._last_tick_at = time.time()

        # Parse fields safely (Zebu sends strings)
        lp = self._safe_float(data.get("lp"))
        if lp is None or lp <= 0:
            return  # No valid price

        # For "tf" updates, Zebu often omits unchanged fields.
        # Merge with previous cache entry to preserve prev_close, open, etc.
        prev_cache = self._price_cache.get(canonical, {})

        # prev_close: use current tick's "c" if present, else fall back to cached value
        prev_close_raw = data.get("c")
        if prev_close_raw is not None:
            prev_close = self._safe_float(prev_close_raw) or 0
        else:
            prev_close = prev_cache.get("prev_close", 0)

        change = (lp - prev_close) if prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0

        # Same merge logic for OHLV fields — use tick value if present, else cached
        tick_open = self._safe_float(data.get("o"))
        tick_high = self._safe_float(data.get("h"))
        tick_low = self._safe_float(data.get("l"))
        tick_vol = self._safe_float(data.get("v"))

        # Parse bid/ask/OI (may be absent in "tf" updates)
        tick_bp1 = self._safe_float(data.get("bp1"))
        tick_sp1 = self._safe_float(data.get("sp1"))
        tick_bq1 = self._safe_float(data.get("bq1"))
        tick_sq1 = self._safe_float(data.get("sq1"))
        tick_oi = self._safe_float(data.get("oi"))
        tick_ltt = data.get("ltt") or data.get("ft")  # last trade time / feed time

        quote = {
            "symbol": canonical,
            "name": data.get("ts", prev_cache.get("name", canonical)).replace(
                "-EQ", ""
            ),
            "price": lp,
            "change": round(change, 2),
            "change_percent": round(change_pct, 2),
            "open": tick_open if tick_open else prev_cache.get("open", 0),
            "high": tick_high if tick_high else prev_cache.get("high", 0),
            "low": tick_low if tick_low else prev_cache.get("low", 0),
            "close": prev_close,
            "prev_close": prev_close,
            "volume": int(tick_vol or 0) if tick_vol else prev_cache.get("volume", 0),
            "bid_price": tick_bp1 if tick_bp1 else prev_cache.get("bid_price", 0),
            "ask_price": tick_sp1 if tick_sp1 else prev_cache.get("ask_price", 0),
            "bid_qty": int(tick_bq1 or 0) if tick_bq1 else prev_cache.get("bid_qty", 0),
            "ask_qty": int(tick_sq1 or 0) if tick_sq1 else prev_cache.get("ask_qty", 0),
            "oi": int(tick_oi or 0) if tick_oi else prev_cache.get("oi", 0),
            "market_cap": 0,
            "exchange": data.get("e", prev_cache.get("exchange", "NSE")),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "last_trade_time": tick_ltt or prev_cache.get("last_trade_time"),
        }

        # Update in-memory cache
        self._price_cache[canonical] = quote

        # Update Redis (non-blocking, fire-and-forget)
        if self._redis:
            try:
                await self._redis.set_price(canonical, quote)
            except Exception as e:
                logger.warning(f"Redis write failed for {canonical}: {e}")

    # ── Heartbeat ───────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeats to keep the connection alive."""
        try:
            while self._running and self._ws and not self._ws_is_closed():
                try:
                    hb_msg = json.dumps({"t": "h"})
                    await self._ws.send(hb_msg)
                    logger.debug("Zebu heartbeat sent")
                except Exception as e:
                    logger.warning(f"Zebu heartbeat send failed: {e}")
                    break

                await asyncio.sleep(self.HEARTBEAT_INTERVAL)
        except asyncio.CancelledError:
            return

    # ── Subscriptions ───────────────────────────────────────────────

    async def subscribe(self, symbols: list[str]) -> None:
        """Subscribe to price updates for canonical symbols."""
        new_symbols = set()
        for s in symbols:
            fmt = self._fmt(s)
            if fmt not in self._subscribed_symbols:
                # Resolve unknown symbols before subscribing
                if not canonical_to_zebu(fmt):
                    await self._resolve_symbol(fmt)
                new_symbols.add(fmt)

        if not new_symbols:
            return

        if self._status == ProviderStatus.CONNECTED and self._ws:
            await self._send_subscribe(new_symbols)
            self._subscribed_symbols.update(new_symbols)
        else:
            # Queue for when connection is established
            self._pending_subscribe.update(new_symbols)
            self._subscribed_symbols.update(new_symbols)
            logger.debug(
                f"Zebu: queued {len(new_symbols)} symbols for subscription (not connected)"
            )

    async def unsubscribe(self, symbols: list[str]) -> None:
        """Unsubscribe from price updates."""
        remove_symbols = set()
        for s in symbols:
            fmt = self._fmt(s)
            if fmt in self._subscribed_symbols:
                remove_symbols.add(fmt)

        if not remove_symbols:
            return

        self._subscribed_symbols -= remove_symbols
        self._pending_subscribe -= remove_symbols

        if self._status == ProviderStatus.CONNECTED and self._ws:
            await self._send_unsubscribe(remove_symbols)

    async def _send_subscribe(self, symbols: set[str]) -> None:
        """Send subscription request to Zebu for the given canonical symbols."""
        scrip_list = self._build_scrip_list(symbols)
        if not scrip_list:
            return

        msg = json.dumps(
            {
                "t": "t",  # touchline subscribe
                "k": scrip_list,
            }
        )
        try:
            if not is_safe_websocket_message({"t": "t"}):
                return
            await self._ws.send(msg)
            logger.info(f"Zebu subscribed: {scrip_list}")
        except Exception as e:
            logger.error(f"Zebu subscribe send failed: {e}")

    async def _send_unsubscribe(self, symbols: set[str]) -> None:
        """Send unsubscribe request to Zebu."""
        scrip_list = self._build_scrip_list(symbols)
        if not scrip_list:
            return

        msg = json.dumps(
            {
                "t": "u",  # touchline unsubscribe
                "k": scrip_list,
            }
        )
        try:
            if not is_safe_websocket_message({"t": "u"}):
                return
            await self._ws.send(msg)
            logger.info(f"Zebu unsubscribed: {scrip_list}")
        except Exception as e:
            logger.error(f"Zebu unsubscribe send failed: {e}")

    def get_subscribed_symbols(self) -> set[str]:
        return self._subscribed_symbols.copy()

    # ── Quote access + REST API ────────────────────────────────────

    async def get_batch_quotes(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch quotes for multiple symbols in parallel."""
        async def _fetch_one(sym: str):
            try:
                q = await self.get_quote(sym)
                return (self._fmt(sym), q)
            except Exception:
                return (self._fmt(sym), None)

        pairs = await asyncio.gather(*[_fetch_one(s) for s in symbols])
        return {sym: q for sym, q in pairs if q}

    # ── REST API helpers ────────────────────────────────────────────

    async def _rest_post(
        self,
        route: str,
        payload: dict,
        content_type: str = "application/x-www-form-urlencoded",
    ):
        """
        Send a jData-encoded POST to the Zebu/MYNT REST API.
        Returns parsed JSON (dict or list) on success, None on failure.
        """
        if not self._api_url:
            logger.warning("ZebuProvider REST call skipped — no api_url configured")
            return None
        if not self._session_token:
            logger.warning("ZebuProvider REST call skipped — no session token")
            return None

        url = f"{self._api_url}{route}"
        payload["uid"] = self._user_id
        payload["actid"] = self._user_id
        jdata = "jData=" + json.dumps(payload) + f"&jKey={self._session_token}"

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    url,
                    data=jdata,
                    headers={"Content-Type": content_type},
                )
                if resp.status_code != 200:
                    logger.warning(
                        f"Zebu REST {route} HTTP {resp.status_code}: {resp.text[:200]}"
                    )
                    return None

                # Handle encoding — Zebu may return non-UTF-8 data
                raw = resp.content
                if not raw or not raw.strip():
                    logger.warning(f"Zebu REST {route} empty response")
                    return None

                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = raw.decode("latin-1", errors="replace")

                if not text.strip():
                    logger.warning(f"Zebu REST {route} blank response after decode")
                    return None

                result = json.loads(text)
                logger.debug(
                    f"Zebu REST {route} → {type(result).__name__} "
                    f"len={len(result) if isinstance(result, list) else 'dict'}"
                )
                return result
        except json.JSONDecodeError as e:
            logger.error(
                f"Zebu REST {route} JSON parse failed: {e} body={text[:200] if 'text' in dir() else '?'}"
            )
            return None
        except Exception as e:
            logger.error(f"Zebu REST {route} failed ({type(e).__name__}): {e}")
            return None

    async def _resolve_symbol(self, canonical: str) -> Optional[dict]:
        """
        Dynamically resolve a canonical symbol to its Zebu token via SearchScrip.
        Result is registered in the global symbol map for future calls.
        Returns the mapping dict or None if not found.

        Tries MCX exchange first for known commodity symbols, else NSE.
        """
        # Determine exchange and base symbol
        if is_mcx_symbol(canonical):
            base = canonical.upper()
            exchange = "MCX"
        else:
            base = canonical.split(".")[0].upper()
            exchange = "NSE"

        try:
            data = await self._rest_post("/SearchScrip", {"exch": exchange, "stext": base})
            if not data or data.get("stat") != "Ok":
                return None

            for item in data.get("values", []):
                tsym = item.get("tsym", "")
                token = item.get("token", "")

                if exchange == "MCX":
                    # MCX: match the base symbol (e.g. "GOLD", "CRUDEOIL")
                    # Prefer exact match, then shortest match (active near-month contract)
                    if tsym.upper() == base and token:
                        load_zebu_contracts([{
                            "symbol": base, "token": token,
                            "exchange": "MCX", "trading_symbol": tsym,
                        }])
                        logger.info(f"Dynamically resolved MCX {canonical} → token={token} tsym={tsym}")
                        return canonical_to_zebu(canonical)
                else:
                    # NSE: match exact EQ variant
                    if tsym == f"{base}-EQ" and token:
                        load_zebu_contracts([{"symbol": base, "token": token, "exchange": "NSE"}])
                        logger.info(f"Dynamically resolved {canonical} → token={token}")
                        return canonical_to_zebu(canonical)

            # MCX fallback: if exact match not found, take the first result with a token
            if exchange == "MCX":
                for item in data.get("values", []):
                    tsym = item.get("tsym", "")
                    token = item.get("token", "")
                    if token and base in tsym.upper():
                        load_zebu_contracts([{
                            "symbol": base, "token": token,
                            "exchange": "MCX", "trading_symbol": tsym,
                        }])
                        logger.info(f"Dynamically resolved MCX {canonical} → token={token} tsym={tsym} (fuzzy)")
                        return canonical_to_zebu(canonical)

        except Exception as e:
            logger.warning(f"SearchScrip resolve failed for {canonical}: {e}")
        return None

    async def get_rest_quote(self, symbol: str) -> Optional[dict]:
        """
        Fetch a single quote via Zebu REST /GetQuotes endpoint.
        Falls back to this when WebSocket cache has no data yet.
        """
        symbol = self._fmt(symbol)
        mapping = canonical_to_zebu(symbol)
        if not mapping:
            mapping = await self._resolve_symbol(symbol)
        if not mapping:
            logger.warning(f"No Zebu mapping for REST quote: {symbol}")
            return None

        data = await self._rest_post(
            "/GetQuotes",
            {
                "exch": mapping["exchange"],
                "token": mapping["token"],
            },
        )
        if not data or data.get("stat") != "Ok":
            return None

        lp = self._safe_float(data.get("lp"))
        if lp is None or lp <= 0:
            return None

        prev_close = self._safe_float(data.get("c", 0))
        change = (lp - prev_close) if prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0

        quote = {
            "symbol": symbol,
            "name": data.get("tsym", symbol).replace("-EQ", ""),
            "price": lp,
            "change": round(change, 2),
            "change_percent": round(change_pct, 2),
            "open": self._safe_float(data.get("o", 0)),
            "high": self._safe_float(data.get("h", 0)),
            "low": self._safe_float(data.get("l", 0)),
            "close": prev_close,
            "prev_close": prev_close,
            "volume": int(self._safe_float(data.get("v", 0)) or 0),
            "bid_price": self._safe_float(data.get("bp1", 0)),
            "ask_price": self._safe_float(data.get("sp1", 0)),
            "bid_qty": int(self._safe_float(data.get("bq1", 0)) or 0),
            "ask_qty": int(self._safe_float(data.get("sq1", 0)) or 0),
            "oi": int(self._safe_float(data.get("oi", 0)) or 0),
            "market_cap": 0,
            "exchange": mapping["exchange"],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "last_trade_time": data.get("ltt") or data.get("ft"),
        }

        # Update local cache so future get_quote() calls return this
        self._price_cache[symbol] = quote
        return quote

    async def get_quote(self, symbol: str) -> Optional[dict]:
        """
        Get latest quote — WebSocket cache first, then REST fallback.
        Also auto-subscribes the symbol to the WS feed if not already tracked.
        """
        symbol = self._fmt(symbol)

        # 1. In-memory cache (fastest — populated by WS ticks)
        if symbol in self._price_cache:
            return self._price_cache[symbol]

        # 2. Redis fallback
        if self._redis:
            try:
                cached = await self._redis.get_price(symbol)
                if cached:
                    self._price_cache[symbol] = cached
                    return cached
            except Exception as e:
                logger.warning(f"Redis read failed for {symbol}: {e}")

        # 3. REST API fallback (slower but works without active WS subscription)
        quote = await self.get_rest_quote(symbol)

        # 4. Auto-subscribe to WS so future quotes arrive via ticks
        if symbol not in self._subscribed_symbols and canonical_to_zebu(symbol):
            asyncio.create_task(self.subscribe([symbol]))

        return quote

    # ── Historical data (Zebu REST) ─────────────────────────────────

    # Map yfinance-style intervals to Zebu TPSeries intervals (minutes)
    # TPSeries only supports: 1, 3, 5, 10, 15, 30, 60, 120, 240
    # Daily data uses EODChartData endpoint instead
    _INTERVAL_MAP = {
        "1m": "1",
        "3m": "3",
        "5m": "5",
        "10m": "10",
        "15m": "15",
        "30m": "30",
        "1h": "60",
        "2h": "120",
        "4h": "240",
        "1d": "D",  # sentinel — routes to EODChartData
        "1wk": "D",  # sentinel — routes to EODChartData
        "1mo": "D",  # sentinel — routes to EODChartData
    }

    # Map yfinance-style period to number of calendar days
    _PERIOD_DAYS = {
        "1d": 1,
        "5d": 5,
        "1mo": 30,
        "3mo": 90,
        "6mo": 180,
        "1y": 365,
        "2y": 730,
        "3y": 1095,
        "5y": 1825,
        "max": 3650,
    }

    async def get_historical_data(
        self, symbol: str, period: str = "1mo", interval: str = "1d"
    ) -> list:
        """
        Fetch historical OHLCV candle data from Zebu REST API.

        Uses /TPSeries for intraday intervals and /EODChartData for daily+.
        Returns list of dicts: [{time, open, high, low, close, volume}, ...]
        """
        symbol = self._fmt(symbol)
        mapping = canonical_to_zebu(symbol)
        if not mapping:
            mapping = await self._resolve_symbol(symbol)
        if not mapping:
            logger.warning(f"No Zebu mapping for history: {symbol}")
            return []

        # Calculate time range
        days = self._PERIOD_DAYS.get(period, 30)
        end_time = datetime.now()
        start_time = end_time - timedelta(days=days)
        st_epoch = int(start_time.timestamp())
        et_epoch = int(end_time.timestamp())

        zebu_interval = self._INTERVAL_MAP.get(interval, "D")

        logger.info(
            f"Zebu history: {symbol} exch={mapping['exchange']} token={mapping['token']} "
            f"interval={zebu_interval} period={period} days={days} "
            f"st={st_epoch} et={et_epoch}"
        )

        if zebu_interval == "D":
            # Use EODChartData for daily data — needs trading_symbol
            candles = await self._fetch_eod_data(
                mapping["exchange"], mapping["trading_symbol"], st_epoch, et_epoch
            )
        else:
            # Use TPSeries for intraday data — needs token
            candles = await self._fetch_tp_series(
                mapping["exchange"], mapping["token"], st_epoch, et_epoch, zebu_interval
            )

        logger.info(f"Zebu history: {symbol} → {len(candles)} candles")
        return candles

    async def _fetch_tp_series(
        self, exchange: str, token: str, st_epoch: int, et_epoch: int, interval: str
    ) -> list:
        """
        Fetch intraday candles from Zebu /TPSeries endpoint.

        interval: minutes as string — valid: 1, 3, 5, 10, 15, 30, 60, 120, 240
        """
        payload = {
            "ordersource": "API",
            "exch": exchange,
            "token": token,
            "st": str(st_epoch),
            "et": str(et_epoch),
            "intrv": interval,
        }
        logger.info(
            f"Zebu TPSeries request: exch={payload['exch']} token={payload['token']} intrv={interval}"
        )
        data = await self._rest_post("/TPSeries", payload)

        if not data:
            logger.warning("Zebu TPSeries returned None/empty")
            return []

        logger.debug(
            f"Zebu TPSeries response type={type(data).__name__} "
            f"len={len(data) if isinstance(data, list) else 1} "
            f"sample={str(data[:1] if isinstance(data, list) else data)[:300]}"
        )

        # TPSeries returns a list of candle dicts directly
        if isinstance(data, list):
            return self._parse_candles(data)

        # Single dict — could be an error or a single candle
        if isinstance(data, dict):
            if data.get("stat") == "Not_Ok":
                logger.warning(f"Zebu TPSeries error: {data.get('emsg', 'unknown')}")
                return []
            return self._parse_candles([data])

        return []

    async def _fetch_eod_data(
        self, exchange: str, trading_symbol: str, st_epoch: int, et_epoch: int
    ) -> list:
        """
        Fetch daily candles from Zebu /EODChartData endpoint.

        Uses sym=EXCHANGE:TRADING_SYMBOL, from=epoch, to=epoch format.
        """
        sym_str = f"{exchange}:{trading_symbol}"
        payload = {
            "sym": sym_str,
            "from": str(st_epoch),
            "to": str(et_epoch),
        }
        logger.info(f"Zebu EODChartData request: sym={sym_str}")
        data = await self._rest_post(
            "/EODChartData", payload, content_type="application/x-www-form-urlencoded"
        )

        if not data:
            logger.warning("Zebu EODChartData returned None/empty")
            return []

        # EODChartData returns a list of JSON *strings*, not dicts.
        # Each element like: '{"time":"02-MAR-2026", "into":"1375.50", ...}'
        if isinstance(data, list):
            parsed = []
            for item in data:
                if isinstance(item, str):
                    try:
                        parsed.append(json.loads(item))
                    except json.JSONDecodeError:
                        continue
                elif isinstance(item, dict):
                    parsed.append(item)
            logger.debug(
                f"Zebu EODChartData parsed {len(parsed)} candle dicts from {len(data)} items"
            )
            return self._parse_candles(parsed)

        if isinstance(data, dict):
            if data.get("stat") == "Not_Ok":
                logger.warning(
                    f"Zebu EODChartData error: {data.get('emsg', 'unknown')}"
                )
                return []
            return self._parse_candles([data])

        return []

    def _parse_candles(self, raw_candles: list) -> list:
        """
        Parse Zebu candle data into lightweight-charts format.

        Zebu TPSeries response per candle:
            {"stat":"Ok","time":"14-02-2025 09:15:00","into":"1290.00",
             "inth":"1295.00","intl":"1285.00","intc":"1292.00","intv":"12345",
             "intvwap":"1290.50","oi":"0","ssboe":"1739506500","v":"123456"}
        Also supports EOD format with slightly different keys.
        """
        candles = []
        for c in raw_candles:
            if not isinstance(c, dict):
                continue

            # Parse timestamp — Zebu sends multiple formats:
            #   TPSeries:  "DD-MM-YYYY HH:MM:SS" or epoch in ssboe
            #   EODChart:  "DD-MMM-YYYY" e.g. "02-MAR-2026"
            # lightweight-charts interprets Unix timestamps as UTC.
            # Zebu times are IST (UTC+5:30). We add the IST offset so
            # the chart axis displays correct Indian market hours.
            IST_OFFSET = 19800  # 5 hours 30 minutes in seconds
            ts = None
            if "ssboe" in c:
                try:
                    ts = int(c["ssboe"]) + IST_OFFSET
                except (ValueError, TypeError):
                    pass
            if ts is None and "time" in c:
                for fmt in ("%d-%m-%Y %H:%M:%S", "%d-%b-%Y", "%d-%m-%Y"):
                    try:
                        dt = datetime.strptime(c["time"], fmt)
                        # calendar.timegm treats the naive struct as UTC,
                        # producing a "display epoch" that lightweight-charts
                        # renders as the original IST wall-clock time.
                        ts = calendar.timegm(dt.timetuple())
                        break
                    except (ValueError, TypeError):
                        continue

            if ts is None:
                continue

            # Parse OHLCV — Zebu uses into/inth/intl/intc/intv for intraday
            # NOTE: Use explicit key checks — Python's `or` chain treats 0, "",
            # and 0.0 as falsy, which incorrectly skips valid zero values and
            # falls through to cumulative fields (e.g. intv=0 → uses cum. vol v).
            o = self._safe_float(c["into"] if "into" in c else c.get("o"))
            h = self._safe_float(c["inth"] if "inth" in c else c.get("h"))
            l = self._safe_float(c["intl"] if "intl" in c else c.get("l"))
            cl = self._safe_float(c["intc"] if "intc" in c else c.get("c"))

            # Volume: prefer intv (interval volume) for intraday, then v (daily),
            # then oi (open interest) as last resort.
            if "intv" in c:
                v = int(self._safe_float(c["intv"]) or 0)
            elif "v" in c:
                v = int(self._safe_float(c["v"]) or 0)
            else:
                v = int(self._safe_float(c.get("oi", 0)) or 0)

            if o is None or h is None or l is None or cl is None:
                continue

            candles.append(
                {
                    "time": ts,
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": cl,
                    "volume": v,
                }
            )

        # Sort by time ascending (lightweight-charts requires sorted data)
        candles.sort(key=lambda x: x["time"])
        return candles

    async def health(self) -> ProviderHealth:
        uptime = (time.time() - self._started_at) if self._started_at else 0
        last_tick = (
            datetime.utcfromtimestamp(self._last_tick_at).isoformat()
            if self._last_tick_at
            else None
        )
        return ProviderHealth(
            status=self._status,
            provider_name="zebu",
            subscribed_symbols=len(self._subscribed_symbols),
            last_tick_at=last_tick,
            uptime_seconds=uptime,
            reconnect_count=self._reconnect_count,
        )

    # ── Helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _fmt(symbol: str) -> str:
        """Normalise symbol to canonical form.

        NSE equities get .NS suffix.
        MCX commodities (GOLD, SILVER, etc.) are left as-is.
        Indices (^) are left as-is.
        """
        if symbol.startswith("^") or symbol.endswith((".NS", ".BO")):
            return symbol
        if is_mcx_symbol(symbol):
            return symbol.upper()
        return f"{symbol}.NS"

    @staticmethod
    def _safe_float(val) -> Optional[float]:
        """Safely parse a float from string or number."""
        if val is None:
            return None
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _build_scrip_list(symbols: set[str]) -> str:
        """
        Build Zebu scrip list string from canonical symbols.

        Format: "NSE|2885#NSE|11536"  (exchange|token pairs joined by #)
        """
        parts = []
        for sym in symbols:
            mapping = canonical_to_zebu(sym)
            if mapping:
                parts.append(f"{mapping['exchange']}|{mapping['token']}")
            else:
                logger.warning(f"No Zebu mapping for symbol: {sym}")
        return "#".join(parts)
