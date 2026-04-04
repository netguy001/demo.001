"""
Options routes — Real NSE option chain data.

All data sourced live from NSE India public API.
No simulated or synthetic data is returned by these endpoints.
"""

import logging
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from services.nse_options_service import get_option_chain, get_expiry_dates, get_filtered_chain

router = APIRouter(prefix="/api/options", tags=["Options"])
logger = logging.getLogger(__name__)

# Supported index underlyings
_SUPPORTED_INDICES = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]


@router.get("/chain/{symbol}")
async def option_chain(
    symbol: str,
    expiry: Optional[str] = Query(None, description="Expiry date (e.g. 27-Mar-2025). Defaults to nearest."),
    strikes: int = Query(20, ge=5, le=50, description="Number of strikes above/below ATM to return."),
):
    """
    Live option chain for an index or stock.

    Returns calls and puts for each strike around ATM for the selected expiry.
    Data sourced directly from NSE India — refreshed every 60 seconds.

    Example: GET /api/options/chain/NIFTY?expiry=27-Mar-2025&strikes=15
    """
    sym = symbol.upper().strip()
    result = await get_filtered_chain(sym, expiry=expiry, strikes_around_atm=strikes)

    if not result:
        raise HTTPException(
            status_code=503,
            detail=f"Option chain data unavailable for {sym}. NSE API may be offline or market is closed.",
        )

    return result


@router.get("/expiry/{symbol}")
async def expiry_dates(symbol: str):
    """
    Available option expiry dates for a symbol, sorted nearest-first.

    Example: GET /api/options/expiry/NIFTY
    """
    sym = symbol.upper().strip()
    dates = await get_expiry_dates(sym)

    if not dates:
        raise HTTPException(
            status_code=503,
            detail=f"No expiry dates available for {sym}.",
        )

    return {"symbol": sym, "expiry_dates": dates}


@router.get("/underlyings")
async def supported_underlyings():
    """
    List of index underlyings with live option chains available.
    """
    return {
        "underlyings": [
            {"symbol": "NIFTY",      "name": "Nifty 50",         "exchange": "NSE"},
            {"symbol": "BANKNIFTY",  "name": "Bank Nifty",       "exchange": "NSE"},
            {"symbol": "FINNIFTY",   "name": "Fin Nifty",        "exchange": "NSE"},
            {"symbol": "MIDCPNIFTY", "name": "Midcap Nifty",     "exchange": "NSE"},
            {"symbol": "SENSEX",     "name": "BSE Sensex",       "exchange": "BSE"},
            {"symbol": "NIFTYNXT50", "name": "Nifty Next 50",    "exchange": "NSE"},
        ]
    }
