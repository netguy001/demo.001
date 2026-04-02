"""
Order Execution Worker — Background LIMIT/STOP_LOSS order evaluator.

Periodically scans ALL open orders across all users and evaluates them
against current market prices. Fills orders that meet their conditions
and emits ORDER_FILLED events.

This worker solves the critical gap: check_pending_orders() in
trading_engine.py exists but is never called.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from core.event_bus import event_bus, Event, EventType
from engines.market_session import market_session
from database.connection import async_session_factory
from models.order import Order
from models.portfolio import Portfolio, Holding
from services import market_data

logger = logging.getLogger(__name__)

# Orders older than this are expired automatically
ORDER_EXPIRY_DAYS = 7


def _coerce_utc_datetime(value):
    if value is None:
        return None

    dt = value
    if isinstance(value, str):
        raw = value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            return None

    if not isinstance(dt, datetime):
        return None

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)

    return dt.astimezone(timezone.utc)


def _to_decimal(value) -> Decimal | None:
    try:
        if value is None:
            return None
        if isinstance(value, Decimal):
            return value
        return Decimal(str(value))
    except Exception:
        return None


class OrderExecutionWorker:
    """
    Continuously evaluates OPEN orders against live prices.

    Design:
    - Sweeps ALL users' open orders in a single pass (not per-user).
    - Each order is evaluated independently with its own error handling.
    - Uses its own DB session (not FastAPI's dependency injection).
    """

    EVAL_INTERVAL = 5  # seconds between sweeps

    def __init__(self):
        self._running = False
        self._stats = {"sweeps": 0, "fills": 0, "expired": 0, "errors": 0}

    async def run(self) -> None:
        """Main loop — started via asyncio.create_task in lifespan."""
        self._running = True
        logger.info("Order Execution Worker started")

        while self._running:
            try:
                # Only evaluate during trading hours
                if not market_session.is_trading_hours():
                    await asyncio.sleep(30)
                    continue

                await self._sweep()
                self._stats["sweeps"] += 1
                await asyncio.sleep(self.EVAL_INTERVAL)

            except asyncio.CancelledError:
                break
            except Exception as e:
                self._stats["errors"] += 1
                logger.error(f"Order Execution Worker error: {e}", exc_info=True)
                await asyncio.sleep(10)

        logger.info("Order Execution Worker stopped")

    async def _sweep(self) -> None:
        """Evaluate all open orders across all users."""
        async with async_session_factory() as db:
            try:
                result = await db.execute(select(Order).where(Order.status == "OPEN"))
                open_orders = result.scalars().all()

                if not open_orders:
                    return

                logger.debug(f"Evaluating {len(open_orders)} open orders")
                expiry_cutoff = datetime.now(timezone.utc) - timedelta(
                    days=ORDER_EXPIRY_DAYS
                )

                filled_events = []
                expired_events = []

                for order in open_orders:
                    try:
                        # ── Expire stale orders ─────────────────────────
                        created_at = _coerce_utc_datetime(order.created_at)
                        if created_at and created_at < expiry_cutoff:
                            order.status = "EXPIRED"
                            order.updated_at = datetime.now(timezone.utc)
                            self._stats["expired"] += 1
                            logger.info(
                                f"Order EXPIRED: {order.id} | {order.side} {order.quantity}x "
                                f"{order.symbol} (created {created_at.isoformat()})"
                            )
                            expired_events.append(
                                {
                                    "order_id": str(order.id),
                                    "user_id": str(order.user_id),
                                    "symbol": order.symbol,
                                    "side": order.side,
                                    "quantity": order.quantity,
                                }
                            )
                            continue

                        # ── Evaluate for fill ───────────────────────────
                        filled = await self._evaluate_order(db, order)
                        if filled:
                            self._stats["fills"] += 1
                            filled_events.append(
                                {
                                    "order_id": str(order.id),
                                    "user_id": str(order.user_id),
                                    "symbol": order.symbol,
                                    "side": order.side,
                                    "quantity": order.quantity,
                                    "filled_price": (
                                        float(order.filled_price)
                                        if order.filled_price
                                        else None
                                    ),
                                }
                            )
                    except Exception as e:
                        self._stats["errors"] += 1
                        logger.error(f"Error evaluating order {order.id}: {e}")

                # ── Commit DB changes BEFORE emitting events ────────────
                # This ensures portfolio_worker sees committed order state.
                await db.commit()

                # ── Now emit events after commit ────────────────────────
                for evt_data in filled_events:
                    await event_bus.emit(
                        Event(
                            type=EventType.ORDER_FILLED,
                            data=evt_data,
                            user_id=evt_data["user_id"],
                            source="order_execution_worker",
                        )
                    )
                for evt_data in expired_events:
                    await event_bus.emit(
                        Event(
                            type=EventType.ORDER_EXPIRED,
                            data=evt_data,
                            user_id=evt_data["user_id"],
                            source="order_execution_worker",
                        )
                    )

            except Exception as e:
                await db.rollback()
                raise

    async def _evaluate_order(self, db: AsyncSession, order: Order) -> bool:
        """
        Evaluate a single order against current price.
        Returns True if the order was filled.
        """
        quote = await market_data.get_quote_safe(order.symbol, str(order.user_id))
        if not quote or "price" not in quote:
            return False

        current_price = _to_decimal(quote["price"])
        if current_price is None or current_price <= 0:
            return False

        order_price = _to_decimal(order.price)
        trigger_price = _to_decimal(order.trigger_price)
        should_fill = False
        fill_price = current_price  # default fill price

        if order.order_type == "LIMIT":
            if order_price is None:
                return False
            if order.side == "BUY" and current_price <= order_price:
                should_fill = True
                fill_price = current_price  # fill at market (at or better than limit)
            elif order.side == "SELL" and current_price >= order_price:
                should_fill = True
                fill_price = current_price

        elif order.order_type == "STOP_LOSS":
            trigger = trigger_price or order_price
            if trigger is None:
                return False
            if order.side == "BUY" and current_price >= trigger:
                should_fill = True
            elif order.side == "SELL" and current_price <= trigger:
                should_fill = True

        elif order.order_type == "STOP_LOSS_LIMIT":
            # Trigger fires first; after trigger, fill at limit price (order.price) if set
            trigger = trigger_price or order_price
            if trigger is None:
                return False
            trigger_hit = (order.side == "BUY" and current_price >= trigger) or (
                order.side == "SELL" and current_price <= trigger
            )
            if trigger_hit:
                if order_price is not None:
                    # For SL-M: after trigger, fill only if current price is at or
                    # better than the limit price
                    if order.side == "BUY" and current_price <= order_price:
                        should_fill = True
                        fill_price = current_price
                    elif order.side == "SELL" and current_price >= order_price:
                        should_fill = True
                        fill_price = current_price
                    elif order.side == "BUY" and current_price > order_price:
                        # Trigger hit but price above limit — fill at limit price
                        should_fill = True
                        fill_price = order_price
                    elif order.side == "SELL" and current_price < order_price:
                        # Trigger hit but price below limit — fill at limit price
                        should_fill = True
                        fill_price = order_price
                else:
                    # No limit price set — treat as regular STOP_LOSS (fill at market)
                    should_fill = True

        if should_fill:
            # ── For CNC SELL orders: verify the holding still exists ───
            # MIS/NRML short sells are allowed without holdings.
            product_type = order.product_type or "CNC"
            if order.side == "SELL" and product_type == "CNC":
                portfolio_result = await db.execute(
                    select(Portfolio).where(Portfolio.user_id == str(order.user_id))
                )
                portfolio = portfolio_result.scalar_one_or_none()
                if portfolio:
                    holding_result = await db.execute(
                        select(Holding).where(
                            and_(
                                Holding.portfolio_id == portfolio.id,
                                Holding.symbol == order.symbol,
                            )
                        )
                    )
                    holding = holding_result.scalar_one_or_none()
                    if not holding or holding.quantity < order.quantity:
                        available = holding.quantity if holding else 0
                        logger.warning(
                            f"Order {order.id} SELL {order.quantity}x {order.symbol} — "
                            f"holding only has {available}. Cancelling."
                        )
                        order.status = "CANCELLED"
                        order.updated_at = datetime.now(timezone.utc)
                        return False

            order.status = "FILLED"
            order.filled_quantity = order.quantity
            order.filled_price = fill_price
            order.executed_at = datetime.now(timezone.utc)
            order.updated_at = datetime.now(timezone.utc)

            logger.info(
                f"Order FILLED: {order.id} | {order.side} {order.quantity}x "
                f"{order.symbol} @ ₹{float(fill_price):.2f} "
                f"(type={order.order_type} limit=₹{float(order_price) if order_price is not None else 0:.2f})"
            )
            return True

        return False

    async def stop(self) -> None:
        self._running = False

    def get_stats(self) -> dict:
        return self._stats.copy()


# ── Singleton ──────────────────────────────────────────────────────
order_execution_worker = OrderExecutionWorker()
