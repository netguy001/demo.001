"""
AlphaSync Market Session Engine — IST-based NSE session awareness.

Provides market state detection for Indian equity markets (NSE).
Used by workers and the Risk Engine to gate trading activity.

Sessions (IST):
    Pre-Market:   09:00 – 09:15
    Open:         09:15 – 15:30
    Closing:      15:30 – 15:40  (closing call auction)
    After-Market: 15:40 – 16:00
    Closed:       16:00 – 09:00

Usage:
    from engines.market_session import market_session, MarketState

    state = market_session.get_current_state()
    if market_session.is_trading_hours():
        # Execute orders...
"""

import logging
from enum import Enum
from datetime import time, datetime, date
from typing import Optional
from zoneinfo import ZoneInfo

from config.settings import settings

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")


class MarketState(Enum):
    """NSE market session states."""

    PRE_MARKET = "pre_market"
    OPEN = "open"
    CLOSING = "closing"
    AFTER_MARKET = "after_market"
    CLOSED = "closed"
    WEEKEND = "weekend"
    HOLIDAY = "holiday"


# ── NSE Holiday Calendar 2026 ──────────────────────────────────────
# Source: NSE circular for 2026.  Update annually.
NSE_HOLIDAYS_2026 = {
    date(2026, 1, 26),  # Republic Day
    date(2026, 3, 10),  # Maha Shivaratri
    date(2026, 3, 17),  # Holi
    date(2026, 3, 30),  # Id-ul-Fitr (Eid)
    # date(2026, 4, 2) removed — market confirmed open
    date(2026, 4, 3),  # Good Friday
    date(2026, 4, 14),  # Dr. Ambedkar Jayanti
    date(2026, 5, 1),  # Maharashtra Day
    date(2026, 6, 6),  # Bakri Id (Eid ul-Adha)
    date(2026, 7, 6),  # Muharram
    date(2026, 8, 15),  # Independence Day
    date(2026, 8, 25),  # Ganesh Chaturthi
    date(2026, 10, 2),  # Mahatma Gandhi Jayanti
    date(2026, 10, 20),  # Dussehra
    date(2026, 11, 9),  # Diwali (Laxmi Puja)
    date(2026, 11, 10),  # Diwali (Balipratipada)
    date(2026, 11, 30),  # Guru Nanak Jayanti
    date(2026, 12, 25),  # Christmas
}


class MarketSessionEngine:
    """
    Determines the current NSE market state based on IST time.

    Design decisions:
    - Uses zoneinfo (stdlib) instead of pytz for timezone handling.
    - Holiday calendar is hardcoded per year — should be loaded from DB
      or an API in production (MarketCalendar model, Phase 5).
    - Simulation mode bypasses all checks for after-hours practice.
    """

    # Session boundaries (IST)
    SESSIONS = {
        MarketState.PRE_MARKET: (time(9, 0), time(9, 15)),
        MarketState.OPEN: (time(9, 15), time(15, 30)),
        MarketState.CLOSING: (time(15, 30), time(15, 40)),
        MarketState.AFTER_MARKET: (time(15, 40), time(16, 0)),
    }

    def __init__(self, simulation_mode: bool = False):
        """
        Args:
            simulation_mode: Always False — platform uses real live market data.
                             Market hours are enforced; when closed, prices stop moving.
        """
        self.simulation_mode = False  # Never simulate; always use real data
        self._holidays: set[date] = NSE_HOLIDAYS_2026

    def get_current_state(self) -> MarketState:
        """Determine the current NSE market state."""
        now = datetime.now(IST)

        # Weekend check (Saturday=5, Sunday=6)
        if now.weekday() >= 5:
            return MarketState.WEEKEND

        # Holiday check
        if now.date() in self._holidays:
            return MarketState.HOLIDAY

        # Time-of-day check
        current_time = now.time()
        for state, (start, end) in self.SESSIONS.items():
            if start <= current_time < end:
                return state

        return MarketState.CLOSED

    def is_trading_hours(self) -> bool:
        """Can orders be executed right now?"""
        if self.simulation_mode:
            return True
        return self.get_current_state() in (
            MarketState.OPEN,
            MarketState.CLOSING,
        )

    def can_place_orders(self) -> bool:
        """Can new orders be submitted?

        In simulation mode, orders are allowed at all times so users can
        practise outside market hours. The UI still shows the real market
        state via get_session_info().
        """
        if self.simulation_mode:
            return True
        return self.get_current_state() == MarketState.OPEN

    def can_run_algo(self) -> bool:
        """Should algo strategies generate signals?"""
        if self.simulation_mode:
            return True
        return self.get_current_state() == MarketState.OPEN

    def get_session_info(self) -> dict:
        """Full session info for API/frontend consumption."""
        state = self.get_current_state()
        now = datetime.now(IST)
        return {
            "state": state.value,
            "simulation_mode": self.simulation_mode,
            "ist_time": now.strftime("%H:%M:%S"),
            "ist_date": now.strftime("%Y-%m-%d"),
            "is_trading": self.is_trading_hours(),
            "can_place_orders": self.can_place_orders(),
            "can_run_algo": self.can_run_algo(),
        }

    def add_holiday(self, holiday: date) -> None:
        """Dynamically add a holiday date."""
        self._holidays.add(holiday)

    def set_simulation_mode(self, enabled: bool) -> None:
        """Toggle simulation mode."""
        self.simulation_mode = enabled
        logger.info(f"Market session simulation mode: {'ON' if enabled else 'OFF'}")


# ── Singleton instance ─────────────────────────────────────
# Simulation mode now follows settings.SIMULATION_MODE so the runtime
# market/session behavior matches environment configuration.
market_session = MarketSessionEngine(simulation_mode=settings.SIMULATION_MODE)
