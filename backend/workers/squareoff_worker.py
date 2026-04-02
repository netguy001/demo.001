"""
Auto Square-Off Worker — Closes all MIS (intraday) positions at 3:20 PM IST.

Real brokers (Zerodha, Groww, etc.) auto square-off intraday positions
before market close. This worker replicates that behavior.

Runs every 30 seconds, checks if it's past 15:20 IST, and closes all
holdings that haven't been manually closed.
"""

import asyncio
import logging
from datetime import datetime, time, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import select, and_

from database.connection import async_session_factory
from models.order import Order
from models.portfolio import Portfolio, Holding
from services import market_data
from services.trading_engine import _update_portfolio_on_fill, _to_decimal

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
SQUAREOFF_TIME = time(15, 20)  # 3:20 PM IST


class AutoSquareOffWorker:
    """Closes all open positions at 3:20 PM IST daily."""

    def __init__(self):
        self._running = False
        self._squared_off_today = False
        self._last_date = None

    async def run(self):
        """Main loop — checks every 30s if square-off time has been reached."""
        self._running = True
        logger.info("Auto Square-Off Worker started (trigger: 15:20 IST)")

        while self._running:
            try:
                now = datetime.now(IST)
                today = now.date()

                # Reset flag on new day
                if self._last_date != today:
                    self._squared_off_today = False
                    self._last_date = today

                # Check if it's time to square off (weekdays only)
                if (
                    not self._squared_off_today
                    and now.weekday() < 5  # Mon-Fri
                    and now.time() >= SQUAREOFF_TIME
                ):
                    await self._square_off_all()
                    self._squared_off_today = True

            except Exception as e:
                logger.error(f"Square-off worker error: {e}", exc_info=True)

            await asyncio.sleep(30)

    async def _square_off_all(self):
        """Close all holdings across all portfolios."""
        logger.info("[SquareOff] 3:20 PM IST — Auto square-off triggered")

        async with async_session_factory() as db:
            try:
                # Get all portfolios
                result = await db.execute(select(Portfolio))
                portfolios = result.scalars().all()

                total_closed = 0

                for portfolio in portfolios:
                    result = await db.execute(
                        select(Holding).where(
                            and_(
                                Holding.portfolio_id == portfolio.id,
                                Holding.quantity != 0,
                            )
                        )
                    )
                    holdings = result.scalars().all()

                    if not holdings:
                        continue

                    for holding in holdings:
                        try:
                            qty = abs(holding.quantity)
                            side = "SELL" if holding.quantity > 0 else "BUY"

                            # Get close price
                            quote = await market_data.get_system_quote_safe(holding.symbol)
                            close_price = _to_decimal(
                                quote["price"] if quote and quote.get("price")
                                else float(holding.current_price or holding.avg_price)
                            )

                            # Create filled order
                            order = Order(
                                user_id=portfolio.user_id,
                                symbol=holding.symbol,
                                exchange="NSE",
                                order_type="MARKET",
                                side=side,
                                product_type="MIS",
                                quantity=qty,
                                status="FILLED",
                                filled_quantity=qty,
                                filled_price=close_price,
                                executed_at=datetime.now(timezone.utc),
                            )
                            db.add(order)
                            await db.flush()

                            await _update_portfolio_on_fill(
                                db, portfolio, holding.symbol, side, qty,
                                close_price, order.id, portfolio.user_id,
                                company_name=holding.company_name or "",
                                product_type="MIS",
                            )

                            total_closed += 1
                            logger.info(
                                f"[SquareOff] Closed {side} {qty}x {holding.symbol} "
                                f"@ ₹{close_price} for user {str(portfolio.user_id)[:8]}"
                            )
                        except Exception as e:
                            logger.error(
                                f"[SquareOff] Failed to close {holding.symbol}: {e}"
                            )

                await db.commit()
                logger.info(f"[SquareOff] Complete — {total_closed} positions closed")

            except Exception as e:
                await db.rollback()
                logger.error(f"[SquareOff] Transaction failed: {e}", exc_info=True)

    async def stop(self):
        self._running = False

    def get_stats(self):
        return {
            "squared_off_today": self._squared_off_today,
            "squareoff_time": str(SQUAREOFF_TIME),
        }


# Singleton
auto_squareoff_worker = AutoSquareOffWorker()
