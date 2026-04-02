"""
Futures Order Execution Worker — Background LIMIT/STOP_LOSS order evaluator for futures.

Periodically scans ALL open futures orders across all users and evaluates them
against current market prices. Fills orders that meet their conditions.
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
from models.futures_order import FuturesOrder, FuturesPosition
from models.portfolio import Portfolio
from services import market_data

logger = logging.getLogger(__name__)

# Orders older than this are expired automatically
ORDER_EXPIRY_DAYS = 7


def _to_decimal(value) -> Decimal | None:
    try:
        if value is None:
            return None
        if isinstance(value, Decimal):
            return value
        return Decimal(str(value))
    except Exception:
        return None


class FuturesOrderExecutionWorker:
    """
    Continuously evaluates OPEN futures orders against live prices.

    Fills orders when their conditions are met (LIMIT price hit, STOP triggered).
    """

    EVAL_INTERVAL = 5  # seconds between sweeps

    def __init__(self):
        self._running = False
        self._stats = {"sweeps": 0, "fills": 0, "expired": 0, "errors": 0}

    async def run(self) -> None:
        """Main loop — started via asyncio.create_task in lifespan."""
        self._running = True
        logger.info("Futures Order Execution Worker started")

        while self._running:
            try:
                # Evaluate during all hours for paper trading
                await self._sweep()
                self._stats["sweeps"] += 1
                await asyncio.sleep(self.EVAL_INTERVAL)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.exception(f"Worker sweep error: {e}")
                self._stats["errors"] += 1
                await asyncio.sleep(self.EVAL_INTERVAL)

        logger.info(f"Futures Order Execution Worker stopped. Stats: {self._stats}")

    async def stop(self) -> None:
        """Stop the worker gracefully."""
        self._running = False

    async def _sweep(self) -> None:
        """Scan all open orders and evaluate them."""
        async with async_session_factory() as db:
            try:
                # Get all OPEN orders
                result = await db.execute(
                    select(FuturesOrder).where(FuturesOrder.status == "OPEN")
                )
                orders = result.scalars().all()

                for order in orders:
                    await self._evaluate_order(db, order)

                await db.commit()

            except Exception as e:
                logger.exception(f"Sweep error: {e}")
                await db.rollback()

    async def _evaluate_order(self, db: AsyncSession, order: FuturesOrder) -> None:
        """Evaluate a single order against current market price."""

        # Skip if order is too old
        if order.created_at:
            age = (datetime.now(timezone.utc) - order.created_at).days
            if age > ORDER_EXPIRY_DAYS:
                order.status = "EXPIRED"
                order.updated_at = datetime.now(timezone.utc)
                self._stats["expired"] += 1
                event_bus.emit(
                    EventType.FUTURES_ORDER_EXPIRED,
                    Event(
                        type=EventType.FUTURES_ORDER_EXPIRED,
                        user_id=order.user_id,
                        data={"order_id": str(order.id)},
                    ),
                )
                return

        try:
            # Get current price
            quote = await market_data.get_quote_safe(order.contract_symbol, order.user_id)
            if not quote or not quote.get("price"):
                return

            current_price = _to_decimal(quote.get("price"))
            if not current_price:
                return

            should_fill = False

            # LIMIT order: BUY at price <= limit, SELL at price >= limit
            if order.order_type == "LIMIT":
                limit_price = _to_decimal(order.price)
                if order.side == "BUY" and current_price <= limit_price:
                    should_fill = True
                elif order.side == "SELL" and current_price >= limit_price:
                    should_fill = True

            # STOP_LOSS order: BUY at price >= trigger, SELL at price <= trigger
            elif order.order_type == "STOP_LOSS":
                trigger = _to_decimal(order.trigger_price)
                if order.side == "BUY" and current_price >= trigger:
                    should_fill = True
                elif order.side == "SELL" and current_price <= trigger:
                    should_fill = True

            # STOP_LOSS_LIMIT: trigger hit, then execute at limit price
            elif order.order_type == "STOP_LOSS_LIMIT":
                trigger = _to_decimal(order.trigger_price)
                limit_price = _to_decimal(order.price)
                if order.side == "BUY":
                    if current_price >= trigger and current_price <= limit_price:
                        should_fill = True
                else:  # SELL
                    if current_price <= trigger and current_price >= limit_price:
                        should_fill = True

            if should_fill:
                # Execute the order
                order.status = "FILLED"
                order.filled_quantity = order.quantity
                order.filled_price = current_price
                order.executed_at = datetime.now(timezone.utc)

                # Update position
                await self._update_position_on_fill(
                    db, order.user_id, order.contract_symbol, order.side, order.quantity, current_price
                )

                self._stats["fills"] += 1

                # Emit event
                event_bus.emit(
                    EventType.FUTURES_ORDER_FILLED,
                    Event(
                        type=EventType.FUTURES_ORDER_FILLED,
                        user_id=order.user_id,
                        data={
                            "order_id": str(order.id),
                            "contract_symbol": order.contract_symbol,
                            "side": order.side,
                            "quantity": order.quantity,
                            "filled_price": float(current_price),
                        },
                    ),
                )

        except Exception as e:
            logger.exception(f"Error evaluating order {order.id}: {e}")

    async def _update_position_on_fill(
        self,
        db: AsyncSession,
        user_id: str,
        contract_symbol: str,
        side: str,
        quantity: int,
        filled_price: Decimal,
    ) -> None:
        """Update position after order fill (simplified version)."""
        try:
            # Get portfolio
            result = await db.execute(
                select(Portfolio).where(Portfolio.user_id == user_id)
            )
            portfolio = result.scalar_one_or_none()
            if not portfolio:
                return

            # Get position
            result = await db.execute(
                select(FuturesPosition).where(
                    and_(
                        FuturesPosition.user_id == user_id,
                        FuturesPosition.contract_symbol == contract_symbol,
                    )
                )
            )
            position = result.scalar_one_or_none()

            margin_requirement = (filled_price * quantity) / Decimal("10")

            if not position:
                # New position
                position = FuturesPosition(
                    user_id=user_id,
                    contract_symbol=contract_symbol,
                    quantity=quantity if side == "BUY" else -quantity,
                    avg_entry_price=filled_price,
                    current_price=filled_price,
                )
                db.add(position)
                portfolio.available_capital = (portfolio.available_capital or Decimal("0")) - margin_requirement
            else:
                # Update position
                old_qty = position.quantity
                new_qty = old_qty + (quantity if side == "BUY" else -quantity)

                if new_qty == 0:
                    position.quantity = 0
                    portfolio.available_capital = (portfolio.available_capital or Decimal("0")) + margin_requirement
                else:
                    if (old_qty > 0 and side == "BUY") or (old_qty < 0 and side == "SELL"):
                        new_avg = (abs(old_qty) * position.avg_entry_price + quantity * filled_price) / abs(new_qty)
                        position.avg_entry_price = new_avg
                        portfolio.available_capital = (portfolio.available_capital or Decimal("0")) - margin_requirement
                    else:
                        pnl = (filled_price - position.avg_entry_price) * quantity
                        if side == "SELL":
                            pnl = -pnl
                        position.realized_pnl = (position.realized_pnl or Decimal("0")) + pnl
                        portfolio.available_capital = (portfolio.available_capital or Decimal("0")) + margin_requirement

                    position.quantity = new_qty

                position.updated_at = datetime.now(timezone.utc)

        except Exception as e:
            logger.exception(f"Error updating position: {e}")


# Global worker instance
futures_order_worker = FuturesOrderExecutionWorker()
