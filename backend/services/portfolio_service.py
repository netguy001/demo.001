"""
Portfolio Service — Holdings and P&L with batch quote optimization.

Fixes the N+1 query pattern: instead of fetching quotes one-by-one per holding,
we batch-fetch all symbols in a single call, then apply to each holding.
Results are cached in the SmartCache to avoid redundant DB + quote lookups
on rapid-fire frontend polling.
"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from models.portfolio import Portfolio, Holding
from models.user import User
from services import market_data
from cache.smart_cache import portfolio_cache, holdings_cache, quote_cache
import logging
from decimal import Decimal

logger = logging.getLogger(__name__)


def _to_decimal(value) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def invalidate_user_portfolio_cache(user_id: str) -> None:
    portfolio_cache.invalidate_prefix(f"summary:{user_id}")
    holdings_cache.invalidate_prefix(f"holdings:{user_id}")


async def _batch_fetch_quotes(symbols: list[str], user_id: str) -> dict[str, dict]:
    """Fetch quotes for all symbols in one batch call instead of N individual calls.

    Uses a three-tier lookup:
        1. SmartCache (in-memory, <1μs)
        2. Batch provider/yfinance call (network)
    """
    if not symbols:
        return {}

    quotes = {}
    missing = []

    # Tier 1: Check in-memory quote cache
    for sym in symbols:
        cached = quote_cache.get(f"q:{sym}")
        if cached:
            quotes[sym] = cached
        else:
            missing.append(sym)

    # Tier 2: Batch fetch missing symbols
    if missing:
        try:
            batch = await market_data.get_batch_quotes(missing, user_id=user_id)
            for sym, q in batch.items():
                if q:
                    quotes[sym] = q
                    quote_cache.set(f"q:{sym}", q, ttl=5)
        except Exception:
            pass

        # Tier 3: Individual fallback for still-missing symbols
        still_missing = [s for s in missing if s not in quotes]
        for sym in still_missing:
            try:
                q = await market_data.get_quote_safe(sym, user_id)
                if q:
                    quotes[sym] = q
                    quote_cache.set(f"q:{sym}", q, ttl=5)
            except Exception:
                pass

    return quotes


def _apply_quote_to_holding(
    holding, quote: dict, quantity: Decimal, invested_value: Decimal
):
    """Apply a live quote to a holding's computed fields."""
    if quote and quote.get("price"):
        live_price = _to_decimal(quote["price"])
        holding.current_price = live_price
        holding.current_value = live_price * quantity
        holding.pnl = holding.current_value - invested_value
        abs_invested = abs(invested_value)
        holding.pnl_percent = (
            (holding.pnl / abs_invested * 100) if abs_invested else Decimal("0")
        )


async def get_portfolio_summary(db: AsyncSession, user_id: str) -> dict:
    """Get complete portfolio summary with real-time P&L.

    Uses batch quote fetching and in-memory caching to minimize latency.
    """
    # Check in-memory cache first
    cache_key = f"summary:{user_id}"
    cached = portfolio_cache.get(cache_key)
    if cached is not None:
        return cached

    user_result = await db.execute(select(User).where(User.id == user_id))
    db_user = user_result.scalar_one_or_none()
    base_capital = _to_decimal(
        db_user.virtual_capital
        if db_user and db_user.virtual_capital is not None
        else Decimal("1000000")
    )

    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user_id))
    portfolio = result.scalar_one_or_none()

    if not portfolio:
        empty = {
            "total_invested": 0,
            "current_value": 0,
            "available_capital": float(round(base_capital, 2)),
            "base_capital": float(round(base_capital, 2)),
            "net_equity": float(round(base_capital, 2)),
            "total_pnl": 0,
            "total_pnl_percent": 0,
            "realized_pnl": 0,
            "unrealized_pnl": 0,
            "day_pnl": 0,
            "holdings_count": 0,
        }
        portfolio_cache.set(cache_key, empty, ttl=5)
        return empty

    result = await db.execute(
        select(Holding).where(Holding.portfolio_id == portfolio.id, Holding.quantity != 0)
    )
    holdings = result.scalars().all()

    # Batch fetch all quotes at once (fixes N+1 query)
    symbols = [h.symbol for h in holdings if h.symbol]
    quotes = await _batch_fetch_quotes(symbols, user_id)

    total_invested_signed = Decimal("0")
    current_value_signed = Decimal("0")
    total_invested_gross = Decimal("0")
    current_value_gross = Decimal("0")

    for holding in holdings:
        quantity = _to_decimal(holding.quantity or 0)
        avg_price = _to_decimal(holding.avg_price or 0)
        invested_value = avg_price * quantity

        # Deterministic baseline
        holding.invested_value = invested_value
        holding.current_price = avg_price
        holding.current_value = invested_value
        holding.pnl = Decimal("0")
        holding.pnl_percent = Decimal("0")

        # Apply live quote from batch result
        _apply_quote_to_holding(
            holding, quotes.get(holding.symbol), quantity, invested_value
        )

        holding_current_value = _to_decimal(holding.current_value or 0)
        total_invested_signed += invested_value
        current_value_signed += holding_current_value
        total_invested_gross += abs(invested_value)
        current_value_gross += abs(holding_current_value)

    portfolio.total_invested = total_invested_signed
    portfolio.current_value = current_value_signed
    unrealized_pnl = current_value_signed - total_invested_signed
    realized_pnl = _to_decimal(portfolio.total_pnl or 0)
    total_pnl = realized_pnl + unrealized_pnl

    pnl_denominator = abs(base_capital) if base_capital else abs(total_invested_gross)
    total_pnl_percent = (total_pnl / pnl_denominator * 100) if pnl_denominator else 0
    net_equity = base_capital + total_pnl

    available_capital = _to_decimal(portfolio.available_capital)

    summary = {
        "total_invested": float(round(total_invested_gross, 2)),
        "current_value": float(round(current_value_gross, 2)),
        "available_capital": float(round(available_capital, 2)),
        "base_capital": float(round(base_capital, 2)),
        "net_equity": float(round(net_equity, 2)),
        "total_pnl": float(round(total_pnl, 2)),
        "total_pnl_percent": float(round(total_pnl_percent, 2)),
        "realized_pnl": float(round(realized_pnl, 2)),
        "unrealized_pnl": float(round(unrealized_pnl, 2)),
        "holdings_count": len(holdings),
    }

    portfolio_cache.set(cache_key, summary, ttl=3)
    return summary


async def get_holdings(db: AsyncSession, user_id: str) -> list:
    """Get all holdings with live prices (batch-optimized)."""
    # Check in-memory cache first
    cache_key = f"holdings:{user_id}"
    cached = holdings_cache.get(cache_key)
    if cached is not None:
        return cached

    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user_id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        return []

    result = await db.execute(
        select(Holding).where(Holding.portfolio_id == portfolio.id, Holding.quantity != 0)
    )
    holdings = result.scalars().all()

    # Batch fetch all quotes at once (fixes N+1 query)
    symbols = [h.symbol for h in holdings if h.symbol]
    quotes = await _batch_fetch_quotes(symbols, user_id)

    holdings_list = []
    for h in holdings:
        quantity = _to_decimal(h.quantity or 0)
        avg_price = _to_decimal(h.avg_price or 0)
        invested_value = avg_price * quantity

        # Deterministic baseline
        h.invested_value = invested_value
        h.current_price = avg_price
        h.current_value = invested_value
        h.pnl = Decimal("0")
        h.pnl_percent = Decimal("0")

        # Apply live quote from batch result
        _apply_quote_to_holding(h, quotes.get(h.symbol), quantity, invested_value)

        holdings_list.append(
            {
                "id": str(h.id),
                "symbol": h.symbol,
                "company_name": h.company_name
                or (h.symbol.replace(".NS", "") if h.symbol else ""),
                "exchange": h.exchange,
                "quantity": int(quantity),
                "avg_price": float(round(avg_price, 2)),
                "current_price": float(round(h.current_price, 2)),
                "invested_value": float(round(h.invested_value, 2)),
                "current_value": float(round(h.current_value, 2)),
                "pnl": float(round(h.pnl, 2)),
                "pnl_percent": float(round(h.pnl_percent, 2)),
            }
        )

    holdings_cache.set(cache_key, holdings_list, ttl=3)
    return holdings_list
