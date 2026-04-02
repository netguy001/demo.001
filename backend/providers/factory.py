"""
Provider Factory — Utility functions for creating ZebuProvider instances.

No global singleton. Each user gets their own provider instance,
managed by BrokerSessionManager.

Usage:
    from providers.factory import create_zebu_provider

    provider = await create_zebu_provider(user_id, session_token)
    await provider.start()
"""

import logging
from typing import Optional

from providers.base import MarketProvider

logger = logging.getLogger(__name__)


async def create_zebu_provider(
    user_id: str,
    session_token: str,
    api_key: str = "",
) -> MarketProvider:
    """
    Create a new ZebuProvider instance with the given credentials.

    Each user gets their own instance — no global state.
    """
    from config.settings import settings
    from providers.zebu_provider import ZebuProvider
    from cache.redis_client import get_redis

    redis_cache = await get_redis(settings.REDIS_URL)

    provider = ZebuProvider(
        ws_url=settings.ZEBU_WS_URL,
        user_id=user_id,
        api_key=api_key or settings.ZEBU_API_SECRET or settings.ZEBU_API_KEY,
        session_token=session_token,
        redis_client=redis_cache,
    )

    logger.info(
        f"Created ZebuProvider for user {str(user_id)[:8] if user_id else '?'}..."
    )
    return provider
