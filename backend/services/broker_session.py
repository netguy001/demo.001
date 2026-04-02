"""
Broker Session Manager — Per-user ZebuProvider registry.

Architecture (redesigned):
    - Each authenticated user gets their OWN ZebuProvider instance.
    - Providers are created ONLY after successful Zebu OAuth.
    - No global provider at app startup.
    - Market data flows exclusively through user-scoped sessions.
    - Workers / routes look up a specific user's provider (or any
      available provider for system-level tasks like ZeroLoss).

Lifecycle:
    1. User completes Zebu OAuth → routes/broker.py calls
       manager.create_session(user_id)
    2. Session manager decrypts the token, creates a ZebuProvider,
       starts it, auto-subscribes popular symbols.
    3. Routes call manager.get_session(user_id) to fetch quotes.
    4. Workers call manager.get_any_session() for background tasks.
    5. User disconnects → manager.destroy_session(user_id).
    6. Health loop monitors all sessions for token expiry.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, and_

from database.connection import async_session_factory
from models.broker import BrokerAccount
from services.broker_crypto import decrypt_token, decrypt_json

logger = logging.getLogger(__name__)

MASTER_SESSION_ID = "__master__"


class BrokerSessionManager:
    """Per-user ZebuProvider registry — no global provider."""

    def __init__(self):
        # user_id → ZebuProvider instance
        self._sessions: dict[str, object] = {}
        self._health_task: Optional[asyncio.Task] = None
        self._running = False

    # ── Session CRUD ────────────────────────────────────────────────

    async def create_session(self, user_id: str) -> bool:
        """
        Create and start a ZebuProvider for a user from their stored
        broker credentials.

        Returns True if the session was created successfully.
        """
        # Avoid duplicate sessions
        if user_id in self._sessions:
            logger.info(
                f"Session already exists for user {str(user_id)[:8]}..., refreshing"
            )
            await self.destroy_session(user_id)

        creds = await self._load_credentials(user_id)
        if not creds:
            logger.warning(
                f"No active broker credentials for user {str(user_id)[:8]}..."
            )
            return False

        provider = await self._create_provider(creds)
        if not provider:
            return False

        await provider.start()
        self._sessions[user_id] = provider

        # Auto-subscribe popular symbols
        await self._auto_subscribe(provider)

        logger.info(
            f"Broker session CREATED for user {str(user_id)[:8]}... "
            f"(total sessions: {len(self._sessions)})"
        )
        return True

    def get_session(self, user_id: str) -> Optional[object]:
        """Return user's ZebuProvider or None if not connected."""
        return self._sessions.get(user_id)

    def get_any_session(self) -> Optional[object]:
        """
        Return ANY active provider — for system-level tasks
        (ZeroLoss, MarketDataWorker) where any user's data feed
        gives correct NSE prices.

        Returns None if no sessions exist.
        """
        if not self._sessions:
            return None

        # Always prefer the shared master session when available.
        master = self._sessions.get(MASTER_SESSION_ID)
        if master is not None:
            return master

        # Otherwise return the first available user session.
        for user_id, provider in self._sessions.items():
            if user_id == MASTER_SESSION_ID:
                continue
            if provider is not None:
                return provider
        return None

    def get_all_sessions(self) -> dict[str, object]:
        """Return all active sessions (for MarketDataWorker iteration)."""
        return dict(self._sessions)

    async def destroy_session(self, user_id: str) -> bool:
        """Stop and remove a user's provider."""
        provider = self._sessions.pop(user_id, None)
        if provider:
            try:
                await provider.stop()
            except Exception as e:
                logger.error(
                    f"Error stopping provider for user {str(user_id)[:8]}...: {e}"
                )
            logger.info(
                f"Broker session DESTROYED for user {str(user_id)[:8]}... "
                f"(remaining: {len(self._sessions)})"
            )
            return True
        return False

    def register_session(self, user_id: str, provider) -> None:
        """
        Register a pre-authenticated provider under a given user_id.
        Used by master_session_service to inject the shared Zebu session.
        The master session uses MASTER_SESSION_ID = '__master__' as user_id.
        """
        self._sessions[str(user_id)] = provider
        logger.info(f"BrokerSessionManager: session registered for user_id={user_id}")

    def has_session(self, user_id: str) -> bool:
        """Check if user has an active provider session."""
        return user_id in self._sessions

    def session_count(self) -> int:
        """Number of active sessions."""
        return len(self._sessions)

    def _is_token_expired(self, token_expiry: Optional[datetime]) -> bool:
        if not token_expiry:
            return False

        if token_expiry.tzinfo is None:
            token_expiry = token_expiry.replace(tzinfo=timezone.utc)

        return token_expiry < datetime.now(timezone.utc)

    # ── Startup: restore sessions from DB ───────────────────────────

    async def restore_sessions(self) -> int:
        """
        Called during app startup. Scans broker_accounts for any active
        tokens and creates sessions for them.

        Returns number of sessions restored.
        """
        session = async_session_factory()
        try:
            result = await session.execute(
                select(BrokerAccount).where(
                    and_(
                        BrokerAccount.broker == "zebu",
                        BrokerAccount.is_active == True,  # noqa: E712
                        BrokerAccount.access_token_enc.isnot(None),
                    )
                )
            )
            accounts = result.scalars().all()

            restored = 0
            for account in accounts:
                if self._is_token_expired(account.token_expiry):
                    continue
                try:
                    created = await self.create_session(account.user_id)
                    if created:
                        restored += 1
                except Exception as e:
                    logger.error(
                        f"Failed to restore session for user "
                        f"{str(account.user_id)[:8]}...: {e}"
                    )

            logger.info(f"Restored {restored} broker sessions from DB")
            return restored
        finally:
            await session.close()

    # ── Health monitoring ───────────────────────────────────────────

    async def start_health_check(self, interval: float = 300.0) -> None:
        """Start periodic health check for all sessions."""
        self._running = True
        self._health_task = asyncio.create_task(self._health_loop(interval))

    async def stop(self) -> None:
        """Stop all sessions and the health loop."""
        self._running = False
        if self._health_task and not self._health_task.done():
            self._health_task.cancel()

        for user_id in list(self._sessions.keys()):
            await self.destroy_session(user_id)

    async def _health_loop(self, interval: float) -> None:
        """Periodically verify all active tokens are still valid."""
        try:
            while self._running:
                await asyncio.sleep(interval)
                for user_id in list(self._sessions.keys()):
                    try:
                        await self._check_session_health(user_id)
                    except Exception as e:
                        logger.error(
                            f"Health check failed for user {str(user_id)[:8]}...: {e}"
                        )
        except asyncio.CancelledError:
            return

    async def _check_session_health(self, user_id: str) -> None:
        """Check if a single user's token is still valid."""
        session = async_session_factory()
        try:
            result = await session.execute(
                select(BrokerAccount).where(
                    and_(
                        BrokerAccount.user_id == user_id,
                        BrokerAccount.broker == "zebu",
                        BrokerAccount.is_active == True,  # noqa: E712
                    )
                )
            )
            account = result.scalar_one_or_none()

            if not account:
                logger.warning(
                    f"Broker account disappeared for user {str(user_id)[:8]}..., "
                    "destroying session"
                )
                await self.destroy_session(user_id)
                return

            if self._is_token_expired(account.token_expiry):
                logger.warning(
                    f"Token expired for user {str(user_id)[:8]}..., destroying session"
                )
                account.is_active = False
                await session.commit()
                await self.destroy_session(user_id)
        finally:
            await session.close()

    # ── Internal helpers ────────────────────────────────────────────

    async def _load_credentials(self, user_id: str) -> Optional[dict]:
        """Load and decrypt broker credentials for a user."""
        session = async_session_factory()
        try:
            result = await session.execute(
                select(BrokerAccount).where(
                    and_(
                        BrokerAccount.user_id == user_id,
                        BrokerAccount.broker == "zebu",
                        BrokerAccount.is_active == True,  # noqa: E712
                        BrokerAccount.access_token_enc.isnot(None),
                    )
                )
            )
            account = result.scalar_one_or_none()
            if not account:
                return None

            if self._is_token_expired(account.token_expiry):
                return None

            session_token = decrypt_token(account.access_token_enc)
            extra = (
                decrypt_json(account.extra_data_enc) if account.extra_data_enc else {}
            )
            return {
                "alphasync_user_id": account.user_id,
                "user_id": extra.get("uid", account.broker_user_id),
                "session_token": session_token,
                "broker_user_id": account.broker_user_id,
            }
        except Exception as e:
            logger.error(
                f"Failed to load credentials for user {str(user_id)[:8]}...: {e}"
            )
            return None
        finally:
            await session.close()

    async def _create_provider(self, creds: dict) -> Optional[object]:
        """Create a ZebuProvider instance from credentials."""
        try:
            from config.settings import settings
            from providers.zebu_provider import ZebuProvider
            from cache.redis_client import get_redis

            redis_cache = await get_redis(settings.REDIS_URL)

            provider = ZebuProvider(
                ws_url=settings.ZEBU_WS_URL,
                user_id=creds["user_id"],
                api_key=settings.ZEBU_API_SECRET or settings.ZEBU_API_KEY,
                session_token=creds["session_token"],
                redis_client=redis_cache,
                api_url=settings.ZEBU_API_URL,
            )
            return provider
        except Exception as e:
            logger.error(f"Failed to create ZebuProvider: {e}")
            return None

    async def _auto_subscribe(self, provider) -> None:
        """Subscribe popular symbols on a newly created provider."""
        from services.market_data import POPULAR_INDIAN_STOCKS, INDIAN_INDICES

        symbols = [s["symbol"] for s in POPULAR_INDIAN_STOCKS] + [
            i["symbol"] for i in INDIAN_INDICES
        ]
        try:
            await provider.subscribe(symbols)
            logger.info(f"Auto-subscribed {len(symbols)} symbols on new session")
        except Exception as e:
            logger.error(f"Auto-subscribe failed: {e}")

    # ── Status ──────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """Return session manager status for health endpoint."""
        return {
            "active_sessions": len(self._sessions),
            "user_ids": [str(uid)[:8] + "..." for uid in self._sessions.keys()],
            "running": self._running,
        }


# ── Module-level singleton ──────────────────────────────────────────
broker_session_manager = BrokerSessionManager()
