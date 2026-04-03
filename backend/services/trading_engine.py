import uuid
from datetime import datetime, timezone
from typing import Optional
from decimal import Decimal
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from models.order import Order
from models.portfolio import Portfolio, Holding, Transaction
from models.user import User
from services import market_data
from providers.symbol_mapper import is_mcx_symbol
from core.event_bus import event_bus, Event, EventType
from engines.risk_engine import risk_engine
from cache.smart_cache import portfolio_cache, holdings_cache
import logging

logger = logging.getLogger(__name__)


def _invalidate_portfolio_cache(user_id: str) -> None:
    """Clear cached portfolio data after a trade so the next fetch is fresh."""
    portfolio_cache.invalidate_prefix(f"summary:{user_id}")
    holdings_cache.invalidate_prefix(f"holdings:{user_id}")


def _normalize_available_capital(available_capital: Decimal, net_equity: Decimal, holdings_count: int) -> Decimal:
    if holdings_count <= 0:
        return net_equity
    if available_capital > net_equity:
        return net_equity
    return available_capital


def _to_decimal(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


async def place_order(
    db: AsyncSession,
    user_id: str,
    symbol: str,
    side: str,
    order_type: str,
    quantity: int,
    price: Optional[float] = None,
    trigger_price: Optional[float] = None,
    client_price: Optional[float] = None,
    product_type: str = "CNC",
    tag: Optional[str] = None,
) -> dict:
    """Place and potentially execute a simulated order."""

    symbol = market_data._format_symbol(symbol)

    # Get current market price — try broker first, fall back to client-provided price
    quote = await market_data.get_quote_safe(symbol, user_id)
    if not quote or not quote.get("price"):
        # Fallback: use the price the frontend already has from chart data
        if client_price and client_price > 0:
            logger.info(
                f"Using client-provided price {client_price} for {symbol} (broker quote unavailable)"
            )
            quote = {
                "price": client_price,
                "name": (
                    symbol.replace(".NS", "") if not is_mcx_symbol(symbol) else symbol
                ),
            }
        else:
            return {
                "success": False,
                "error": "Unable to fetch market price for this symbol",
            }

    current_price = _to_decimal(quote["price"])

    # Get portfolio
    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user_id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        return {"success": False, "error": "Portfolio not found"}

    # Ensure available_capital is not None before comparisons
    if portfolio.available_capital is None:
        portfolio.available_capital = Decimal("0")

    # Validate order
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

    total_cost = execution_price * quantity

    # ── Risk Engine pre-trade validation ────────────────────────
    risk_result = await risk_engine.validate_order(
        db=db,
        user_id=user_id,
        symbol=symbol,
        side=side,
        order_type=order_type,
        quantity=quantity,
        price=float(execution_price),
        is_algo=False,
    )
    if not risk_result.passed:
        return {
            "success": False,
            "error": f"Risk check failed ({risk_result.check_name}): {risk_result.reason}",
        }

    # Check capital for BUY orders
    # MIS (intraday) gets 5x leverage — only 1/5 margin required (like real brokers)
    if side == "BUY":
        required_capital = (
            total_cost / Decimal("5") if product_type == "MIS" else total_cost
        )
        available_capital = _to_decimal(portfolio.available_capital or 0)
        if required_capital > available_capital:
            return {
                "success": False,
                "error": f"Insufficient capital. Required: ₹{required_capital:,.2f}, Available: ₹{available_capital:,.2f}",
            }

    # Check holdings for SELL orders — only CNC (delivery) requires holdings.
    # MIS (intraday) and NRML allow short selling.
    if side == "SELL" and product_type == "CNC":
        result = await db.execute(
            select(Holding).where(
                and_(Holding.portfolio_id == portfolio.id, Holding.symbol == symbol)
            )
        )
        holding = result.scalar_one_or_none()
        if not holding or holding.quantity < quantity:
            available = holding.quantity if holding else 0
            return {
                "success": False,
                "error": f"Insufficient holdings for CNC sell. Available: {available}, Requested: {quantity}. Use MIS for short selling.",
            }

    # For MIS/NRML short sell, ensure sufficient margin (require capital for the position)
    if side == "SELL" and product_type != "CNC":
        # Check if user has existing holdings to sell
        result = await db.execute(
            select(Holding).where(
                and_(Holding.portfolio_id == portfolio.id, Holding.symbol == symbol)
            )
        )
        holding = result.scalar_one_or_none()
        has_holdings = holding and holding.quantity >= quantity
        # If no holdings, this is a short sell — require margin capital
        if not has_holdings:
            margin_required = (
                total_cost / Decimal("5") if product_type == "MIS" else total_cost
            )
            available_capital = _to_decimal(portfolio.available_capital or 0)
            if margin_required > available_capital:
                return {
                    "success": False,
                    "error": f"Insufficient margin for short sell. Required: ₹{margin_required:,.2f}, Available: ₹{available_capital:,.2f}",
                }

    # Create order
    exchange = "MCX" if is_mcx_symbol(symbol) else "NSE"
    order = Order(
        user_id=user_id,
        symbol=symbol,
        exchange=exchange,
        order_type=order_type,
        side=side,
        product_type=product_type,
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
        order.filled_price = current_price
        order.executed_at = datetime.now(timezone.utc)

        # Update portfolio
        await _update_portfolio_on_fill(
            db,
            portfolio,
            symbol,
            side,
            quantity,
            current_price,
            order.id,
            user_id,
            quote.get("name", symbol),
            product_type=product_type,
        )
    elif order_type == "LIMIT":
        # If LIMIT is already marketable, fill instantly.
        should_fill_now = (side == "BUY" and execution_price >= current_price) or (
            side == "SELL" and execution_price <= current_price
        )

        if should_fill_now:
            order.status = "FILLED"
            order.filled_quantity = quantity
            order.filled_price = current_price
            order.executed_at = datetime.now(timezone.utc)

            await _update_portfolio_on_fill(
                db,
                portfolio,
                symbol,
                side,
                quantity,
                current_price,
                order.id,
                user_id,
                quote.get("name", symbol),
                product_type=product_type,
            )
        else:
            order.status = "OPEN"
    else:
        # STOP_LOSS / STOP_LOSS_LIMIT stay OPEN until trigger
        order.status = "OPEN"

    await db.flush()

    # ── Emit events for downstream consumers ────────────────────
    if order.status == "FILLED":
        event_bus.emit_nowait(
            Event(
                type=EventType.ORDER_FILLED,
                data={
                    "order_id": str(order.id),
                    "user_id": user_id,
                    "symbol": symbol,
                    "side": side,
                    "quantity": quantity,
                    "filled_price": (
                        float(order.filled_price) if order.filled_price else None
                    ),
                },
                user_id=user_id,
                source="trading_engine",
            )
        )
    else:
        event_bus.emit_nowait(
            Event(
                type=EventType.ORDER_PLACED,
                data={
                    "order_id": str(order.id),
                    "user_id": user_id,
                    "symbol": symbol,
                    "side": side,
                    "order_type": order_type,
                    "quantity": quantity,
                    "price": price,
                    "trigger_price": trigger_price,
                    "status": order.status,
                },
                user_id=user_id,
                source="trading_engine",
            )
        )

    return {
        "success": True,
        "order": {
            "id": str(order.id),
            "symbol": order.symbol,
            "side": order.side,
            "order_type": order.order_type,
            "product_type": order.product_type,
            "quantity": order.quantity,
            "price": float(order.price) if order.price is not None else None,
            "filled_price": (
                float(order.filled_price) if order.filled_price is not None else None
            ),
            "status": order.status,
            "created_at": order.created_at.isoformat() if order.created_at else None,
        },
    }


async def _update_portfolio_on_fill(
    db: AsyncSession,
    portfolio: Portfolio,
    symbol: str,
    side: str,
    quantity: int,
    price,
    order_id: str,
    user_id: str,
    company_name: str = "",
    product_type: str = "CNC",
):
    """Update portfolio holdings after order fill."""
    price = _to_decimal(price)
    total_value = price * quantity

    # Ensure all portfolio fields are Decimal before arithmetic
    portfolio.available_capital = _to_decimal(portfolio.available_capital or 0)
    portfolio.total_invested = _to_decimal(portfolio.total_invested or 0)
    portfolio.total_pnl = _to_decimal(portfolio.total_pnl or 0)

    if side == "BUY":
        # Update or create holding
        result = await db.execute(
            select(Holding).where(
                and_(Holding.portfolio_id == portfolio.id, Holding.symbol == symbol)
            )
        )
        holding = result.scalar_one_or_none()

        # Normalize holding numeric fields to Decimal to avoid None/float mixing
        if holding:
            holding.avg_price = _to_decimal(holding.avg_price or 0)
            holding.invested_value = _to_decimal(holding.invested_value or 0)
            holding.current_price = _to_decimal(holding.current_price or 0)
            holding.current_value = _to_decimal(holding.current_value or 0)

        if holding and holding.quantity < 0:
            # Closing (or reducing) a SHORT position — buy back shares
            close_qty = min(quantity, abs(holding.quantity))
            # P&L for short: sold high (avg_price), buying back at current price
            holding_avg_price = _to_decimal(holding.avg_price or 0)
            short_pnl = (holding_avg_price - price) * close_qty
            # Release the margin that was blocked when opening the short,
            # then apply the P&L (profit or loss from the short trade)
            margin_per_share = (
                holding_avg_price / Decimal("5")
                if product_type == "MIS"
                else holding_avg_price
            )
            portfolio.available_capital += (margin_per_share * close_qty) + short_pnl
            portfolio.total_pnl += short_pnl

            remaining_short = abs(holding.quantity) - close_qty
            if remaining_short <= 0:
                db.delete(holding)
            else:
                holding.quantity = -remaining_short
                holding.invested_value = -(holding_avg_price * remaining_short)
                holding.current_price = price
                holding.current_value = -(price * remaining_short)
                holding.pnl = holding.invested_value - holding.current_value
                holding.pnl_percent = (
                    (holding.pnl / abs(holding.invested_value) * 100)
                    if holding.invested_value
                    else 0
                )

            # If buying more than the short, create a long position with the remainder
            leftover = quantity - close_qty
            if leftover > 0:
                portfolio.available_capital -= price * leftover
                portfolio.total_invested += price * leftover
                long_holding = Holding(
                    portfolio_id=portfolio.id,
                    symbol=symbol,
                    company_name=company_name,
                    quantity=leftover,
                    avg_price=price,
                    current_price=price,
                    invested_value=price * leftover,
                    current_value=price * leftover,
                )
                db.add(long_holding)
        elif holding and holding.quantity > 0:
            # Adding to existing LONG position — average out
            holding_avg_price = _to_decimal(holding.avg_price or 0)
            portfolio.available_capital -= total_value
            portfolio.total_invested += total_value
            total_qty = holding.quantity + quantity
            holding.avg_price = (
                (holding_avg_price * holding.quantity) + (price * quantity)
            ) / total_qty
            holding.quantity = total_qty
            holding.invested_value = holding.avg_price * holding.quantity
            holding.current_price = price
            holding.current_value = price * holding.quantity
            holding.pnl = holding.current_value - holding.invested_value
            holding.pnl_percent = (
                (holding.pnl / holding.invested_value * 100)
                if holding.invested_value
                else 0
            )
        else:
            # Brand new long position
            portfolio.available_capital -= total_value
            portfolio.total_invested += total_value
            holding = Holding(
                portfolio_id=portfolio.id,
                symbol=symbol,
                company_name=company_name,
                quantity=quantity,
                avg_price=price,
                current_price=price,
                invested_value=total_value,
                current_value=total_value,
            )
            db.add(holding)

    elif side == "SELL":
        result = await db.execute(
            select(Holding).where(
                and_(Holding.portfolio_id == portfolio.id, Holding.symbol == symbol)
            )
        )
        holding = result.scalar_one_or_none()

        # Normalize holding numeric fields to Decimal to avoid None/float mixing
        if holding:
            holding.avg_price = _to_decimal(holding.avg_price or 0)
            holding.invested_value = _to_decimal(holding.invested_value or 0)
            holding.current_price = _to_decimal(holding.current_price or 0)
            holding.current_value = _to_decimal(holding.current_value or 0)

        if holding and holding.quantity >= quantity:
            # Normal sell — selling existing holdings
            holding_avg_price = _to_decimal(holding.avg_price or 0)
            sell_pnl = (price - holding_avg_price) * quantity
            portfolio.available_capital += total_value
            portfolio.total_invested -= holding_avg_price * quantity
            portfolio.total_pnl += sell_pnl

            holding.quantity -= quantity
            if holding.quantity <= 0:
                db.delete(holding)
            else:
                holding.invested_value = holding_avg_price * holding.quantity
                holding.current_price = price
                holding.current_value = price * holding.quantity
                holding.pnl = holding.current_value - holding.invested_value
                holding.pnl_percent = (
                    (holding.pnl / holding.invested_value * 100)
                    if holding.invested_value
                    else 0
                )
        else:
            # Short sell — no holdings or partial. Create short position.
            # For short: we receive cash now, owe shares. Track as negative holding.
            short_qty = quantity - (holding.quantity if holding else 0)

            # Close out any existing long position first
            if holding and holding.quantity > 0:
                close_qty = holding.quantity
                holding_avg_price = _to_decimal(holding.avg_price or 0)
                sell_pnl = (price - holding_avg_price) * close_qty
                portfolio.available_capital += price * close_qty
                portfolio.total_invested -= holding_avg_price * close_qty
                portfolio.total_pnl += sell_pnl
                db.delete(holding)
                holding = None

            # Create short position — block margin from available capital
            # MIS gets 5x leverage, so only 1/5 margin is blocked
            margin_blocked = (
                (price * short_qty) / Decimal("5")
                if product_type == "MIS"
                else price * short_qty
            )
            portfolio.available_capital -= margin_blocked

            short_holding = Holding(
                portfolio_id=portfolio.id,
                symbol=symbol,
                company_name=company_name,
                quantity=-short_qty,  # Negative = short position
                avg_price=price,
                current_price=price,
                invested_value=-(price * short_qty),
                current_value=-(price * short_qty),
            )
            db.add(short_holding)

    # Create transaction record
    txn = Transaction(
        user_id=user_id,
        order_id=order_id,
        symbol=symbol,
        transaction_type=side,
        quantity=quantity,
        price=price,
        total_value=total_value,
    )
    db.add(txn)

    # Recalculate portfolio totals
    await _recalculate_portfolio(db, portfolio)

    # Invalidate cached portfolio data so the next API fetch is fresh
    _invalidate_portfolio_cache(str(user_id))


async def _recalculate_portfolio(db: AsyncSession, portfolio: Portfolio):
    """Recalculate portfolio current value and P&L."""
    result = await db.execute(
        select(Holding).where(Holding.portfolio_id == portfolio.id)
    )
    holdings = result.scalars().all()

    total_invested = sum(_to_decimal(h.invested_value or 0) for h in holdings)
    current_value = sum(_to_decimal(h.current_value or 0) for h in holdings)

    portfolio.total_invested = total_invested
    portfolio.current_value = current_value
    unrealized_pnl = current_value - total_invested
    # total_pnl already tracks realized P&L from sells; don't overwrite
    total_pnl = _to_decimal(portfolio.total_pnl or 0)
    user_result = await db.execute(
        select(User.virtual_capital).where(User.id == portfolio.user_id)
    )
    base_capital = _to_decimal(user_result.scalar_one_or_none() or 0)
    abs_total_invested = abs(total_invested) if total_invested else 0
    pnl_denominator = abs(base_capital) if base_capital else abs_total_invested
    net_equity = base_capital + total_pnl + unrealized_pnl
    portfolio.available_capital = _normalize_available_capital(
        _to_decimal(portfolio.available_capital or 0),
        net_equity,
        len(holdings),
    )
    portfolio.total_pnl_percent = (
        ((total_pnl + unrealized_pnl) / pnl_denominator * 100) if pnl_denominator else 0
    )


async def cancel_order(db: AsyncSession, user_id: str, order_id: str) -> dict:
    """Cancel an open order."""
    result = await db.execute(
        select(Order).where(and_(Order.id == order_id, Order.user_id == user_id))
    )
    order = result.scalar_one_or_none()

    if not order:
        return {"success": False, "error": "Order not found"}
    if order.status not in ("OPEN", "PENDING"):
        return {
            "success": False,
            "error": f"Cannot cancel order with status: {order.status}",
        }

    order.status = "CANCELLED"
    order.updated_at = datetime.now(timezone.utc)

    await db.commit()

    event_bus.emit_nowait(
        Event(
            type=EventType.ORDER_CANCELLED,
            data={
                "order_id": str(order.id),
                "symbol": order.symbol,
                "side": order.side,
                "quantity": order.quantity,
            },
            user_id=user_id,
            source="trading_engine",
        )
    )

    return {"success": True, "message": "Order cancelled successfully"}


async def check_pending_orders(db: AsyncSession, user_id: str):
    """Check and execute pending limit/stop-loss orders against current prices."""
    result = await db.execute(
        select(Order).where(and_(Order.user_id == user_id, Order.status == "OPEN"))
    )
    open_orders = result.scalars().all()

    for order in open_orders:
        quote = await market_data.get_quote_safe(order.symbol, user_id)
        if not quote:
            continue

        current_price = _to_decimal(quote["price"])
        should_execute = False

        if order.order_type == "LIMIT":
            if order.side == "BUY" and current_price <= order.price:
                should_execute = True
            elif order.side == "SELL" and current_price >= order.price:
                should_execute = True
        elif order.order_type in ("STOP_LOSS", "STOP_LOSS_LIMIT"):
            if order.side == "SELL" and current_price <= order.trigger_price:
                should_execute = True
            elif order.side == "BUY" and current_price >= order.trigger_price:
                should_execute = True

        if should_execute:
            portfolio_result = await db.execute(
                select(Portfolio).where(Portfolio.user_id == user_id)
            )
            portfolio = portfolio_result.scalar_one_or_none()
            if portfolio:
                order.status = "FILLED"
                order.filled_quantity = order.quantity
                order.filled_price = current_price
                order.executed_at = datetime.now(timezone.utc)
                await _update_portfolio_on_fill(
                    db,
                    portfolio,
                    order.symbol,
                    order.side,
                    order.quantity,
                    current_price,
                    order.id,
                    user_id,
                    product_type=order.product_type or "CNC",
                )
