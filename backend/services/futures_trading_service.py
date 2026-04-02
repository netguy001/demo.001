"""
Futures Trading Service — Simulated futures order placement and execution.
All orders stored in local DB only. NEVER sends orders to broker.
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from models.futures_order import FuturesOrder, FuturesPosition
from models.portfolio import Portfolio
from models.user import User
from services import market_data
from core.event_bus import event_bus, Event, EventType
from cache.smart_cache import portfolio_cache
import logging

logger = logging.getLogger(__name__)


def _to_decimal(value) -> Decimal:
    """Convert any value to Decimal."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _invalidate_futures_cache(user_id: str) -> None:
    """Clear cached portfolio data after a futures trade."""
    portfolio_cache.invalidate_prefix(f"summary:{user_id}")


async def place_futures_order(
    db: AsyncSession,
    user_id: str,
    contract_symbol: str,
    side: str,
    order_type: str,
    quantity: int,
    price: Optional[float] = None,
    trigger_price: Optional[float] = None,
    client_price: Optional[float] = None,
    tag: Optional[str] = None,
) -> dict:
    """
    Place a simulated futures order (local DB only, never to broker).

    Returns:
        {
            "success": bool,
            "error": str (if not success),
            "order_id": UUID (if success),
            "status": str
        }
    """

    if side not in ("BUY", "SELL"):
        return {"success": False, "error": "Side must be BUY or SELL"}

    if quantity <= 0:
        return {"success": False, "error": "Quantity must be positive"}

    # Get current market price from Zebu
    quote = await market_data.get_quote_safe(contract_symbol, user_id)
    if not quote or not quote.get("price"):
        if client_price and client_price > 0:
            logger.info(
                f"Using client-provided price {client_price} for {contract_symbol}"
            )
            current_price = _to_decimal(client_price)
        else:
            return {
                "success": False,
                "error": "Unable to fetch market price for this contract",
            }
    else:
        current_price = _to_decimal(quote["price"])

    # Get portfolio
    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user_id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        return {"success": False, "error": "Portfolio not found"}

    if portfolio.available_capital is None:
        portfolio.available_capital = Decimal("0")

    # Determine execution price
    if order_type == "MARKET":
        execution_price = current_price
    elif order_type == "LIMIT":
        if price is None:
            return {"success": False, "error": "Limit price required for LIMIT orders"}
        execution_price = _to_decimal(price)
    elif order_type in ("STOP_LOSS", "STOP_LOSS_LIMIT"):
        if trigger_price is None:
            return {
                "success": False,
                "error": "Trigger price required for stop-loss orders",
            }
        execution_price = _to_decimal(price) if price else current_price
    else:
        return {"success": False, "error": f"Invalid order type: {order_type}"}

    # Calculate total cost (notional value — futures use margin, not full notional)
    # For futures, typically only 5-10% margin is required
    # We'll use a 10% margin requirement for simplicity
    margin_required = (execution_price * quantity) / Decimal("10")

    # Capital check
    available_capital = _to_decimal(portfolio.available_capital or 0)
    if margin_required > available_capital:
        return {
            "success": False,
            "error": f"Insufficient margin. Required: ₹{margin_required:,.2f}, Available: ₹{available_capital:,.2f}",
        }

    # Create order
    order = FuturesOrder(
        user_id=user_id,
        contract_symbol=contract_symbol,
        order_type=order_type,
        side=side,
        quantity=quantity,
        price=price,
        trigger_price=trigger_price,
        tag=tag,
    )
    db.add(order)

    # Execute MARKET orders immediately
    if order_type == "MARKET":
        order.status = "FILLED"
        order.filled_quantity = quantity
        order.filled_price = execution_price
        order.executed_at = datetime.now(timezone.utc)

        # Update position
        await _update_futures_position_on_fill(
            db,
            user_id,
            contract_symbol,
            side,
            quantity,
            execution_price,
            portfolio,
        )

        await db.commit()

        # Emit event
        event_bus.emit(
            EventType.FUTURES_ORDER_FILLED,
            Event(
                type=EventType.FUTURES_ORDER_FILLED,
                user_id=user_id,
                data={
                    "order_id": str(order.id),
                    "contract_symbol": contract_symbol,
                    "side": side,
                    "quantity": quantity,
                    "filled_price": float(execution_price),
                    "status": "FILLED",
                },
            ),
        )

        _invalidate_futures_cache(user_id)

        return {
            "success": True,
            "order_id": str(order.id),
            "status": "FILLED",
            "filled_price": float(execution_price),
        }

    else:
        # LIMIT / STOP_LOSS orders stay OPEN for evaluation
        order.status = "OPEN"
        await db.commit()

        # Emit event
        event_bus.emit(
            EventType.FUTURES_ORDER_PLACED,
            Event(
                type=EventType.FUTURES_ORDER_PLACED,
                user_id=user_id,
                data={
                    "order_id": str(order.id),
                    "contract_symbol": contract_symbol,
                    "side": side,
                    "quantity": quantity,
                    "price": float(execution_price) if price else None,
                    "trigger_price": float(trigger_price) if trigger_price else None,
                    "status": "OPEN",
                },
            ),
        )

        return {
            "success": True,
            "order_id": str(order.id),
            "status": "OPEN",
        }


async def _update_futures_position_on_fill(
    db: AsyncSession,
    user_id: str,
    contract_symbol: str,
    side: str,
    quantity: int,
    filled_price: Decimal,
    portfolio: Portfolio,
) -> None:
    """Update position and margin after order fill."""

    # Get or create position
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
            unrealized_pnl=Decimal("0"),
        )
        db.add(position)
        # Deduct margin from portfolio
        portfolio.available_capital -= margin_requirement
    else:
        # Existing position - average up/down
        old_qty = position.quantity
        new_qty = old_qty + (quantity if side == "BUY" else -quantity)

        if new_qty == 0:
            # Position closed - calculate realized P&L
            pnl = (filled_price - position.avg_entry_price) * abs(old_qty)
            if side == "SELL":
                pnl = -pnl
            position.realized_pnl += pnl
            position.quantity = 0
            # Return margin
            portfolio.available_capital += margin_requirement
        else:
            # Position adjusted
            if (old_qty > 0 and side == "BUY") or (old_qty < 0 and side == "SELL"):
                # Adding to position
                new_avg_price = (
                    abs(old_qty) * position.avg_entry_price + quantity * filled_price
                ) / abs(new_qty)
                position.avg_entry_price = new_avg_price
                # Additional margin
                portfolio.available_capital -= margin_requirement
            else:
                # Reducing position
                pnl = (filled_price - position.avg_entry_price) * quantity
                if side == "SELL":
                    pnl = -pnl
                position.realized_pnl += pnl
                # Return margin
                portfolio.available_capital += margin_requirement

            position.quantity = new_qty

        position.current_price = filled_price
        position.updated_at = datetime.now(timezone.utc)

    # Update portfolio
    await db.commit()


async def cancel_futures_order(
    db: AsyncSession, user_id: str, order_id: str
) -> dict:
    """Cancel an open futures order."""

    try:
        order_uuid = uuid.UUID(order_id)
    except ValueError:
        return {"success": False, "error": "Invalid order ID"}

    result = await db.execute(
        select(FuturesOrder).where(
            and_(
                FuturesOrder.id == order_uuid,
                FuturesOrder.user_id == user_id,
            )
        )
    )
    order = result.scalar_one_or_none()

    if not order:
        return {"success": False, "error": "Order not found"}

    if order.status not in ("PENDING", "OPEN"):
        return {
            "success": False,
            "error": f"Cannot cancel order with status {order.status}",
        }

    order.status = "CANCELLED"
    order.updated_at = datetime.now(timezone.utc)
    await db.commit()

    # Emit event
    event_bus.emit(
        EventType.FUTURES_ORDER_CANCELLED,
        Event(
            type=EventType.FUTURES_ORDER_CANCELLED,
            user_id=user_id,
            data={"order_id": str(order.id), "contract_symbol": order.contract_symbol},
        ),
    )

    _invalidate_futures_cache(user_id)

    return {"success": True, "order_id": str(order.id)}


async def get_futures_positions(db: AsyncSession, user_id: str) -> list:
    """Get all open positions for a user."""
    result = await db.execute(
        select(FuturesPosition).where(
            and_(
                FuturesPosition.user_id == user_id,
                FuturesPosition.quantity != 0,  # Only open positions
            )
        )
    )
    positions = result.scalars().all()

    return [
        {
            "id": str(p.id),
            "contract_symbol": p.contract_symbol,
            "quantity": p.quantity,
            "avg_entry_price": float(p.avg_entry_price),
            "current_price": float(p.current_price),
            "unrealized_pnl": float(p.unrealized_pnl),
            "realized_pnl": float(p.realized_pnl),
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in positions
    ]
