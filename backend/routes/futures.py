"""
Futures Router — Read-only derivatives analytics endpoints.

Provides contract metadata, quotes, and history for NSE futures (stocks and indices).
No order entry, no buy/sell, no paper trading integration.

Endpoints:
    GET /api/futures/contracts/{symbol} — List futures contracts for a symbol
    GET /api/futures/quote/{contract_symbol} — Live quote for a contract
    GET /api/futures/history/{contract_symbol} — OHLCV history for sparkline
    GET /api/futures/spot/{symbol} — Underlying spot price (for basis calculation)
"""

import logging
from datetime import datetime
from typing import Optional

try:
    from fastapi import APIRouter, Query, HTTPException, Depends
except ImportError:
    raise ImportError("FastAPI is required. Install with: pip install fastapi")

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from database.connection import get_db
from routes.auth import get_current_user_optional, get_current_user
from models.user import User
from engines.market_session import market_session
from services import futures_service
from services.market_data import get_system_quote_safe
from services.futures_trading_service import (
    place_futures_order,
    cancel_futures_order,
    get_futures_positions,
)

router = APIRouter(prefix="/api/futures", tags=["Futures"])
logger = logging.getLogger(__name__)


@router.get("/contracts/{symbol}")
async def list_contracts(
    symbol: str,
    user: Optional[User] = Depends(get_current_user_optional),
):
    """
    List all active futures contracts for a symbol.

    Query Parameters:
        symbol: Canonical symbol (e.g., RELIANCE, NIFTY)

    Response:
        List of contracts sorted by expiry date (nearest first).
        Each contract includes:
            - contract_symbol: Zebu trading symbol (e.g., RELIANCE25MAR2026FUT)
            - expiry_date: ISO format (2026-03-25)
            - expiry_label: Near / Mid / Far
            - lot_size: Minimum order quantity
            - tick_size: Minimum price movement
            - instrument_type: FUTIDX or FUTSTK
            - exchange: NSE

    Example:
        GET /api/futures/contracts/RELIANCE
        Returns:
            [
                {
                    "contract_symbol": "RELIANCE25MAR2026FUT",
                    "expiry_date": "2026-03-25",
                    "expiry_label": "Near",
                    "lot_size": 250,
                    "tick_size": 0.05,
                    "instrument_type": "FUTSTK"
                },
                ...
            ]
    """
    try:
        symbol = symbol.upper().strip().replace(".NS", "").replace(".BO", "")
    except Exception:
        return {"contracts": [], "symbol": symbol, "found": False}

    # Get contracts from service
    try:
        contracts = futures_service.get_contracts(symbol)
    except Exception as e:
        logger.error(f"Error fetching contracts for {symbol}: {e}")
        return {"contracts": [], "symbol": symbol, "found": False, "error": str(e)}

    if not contracts:
        return {"contracts": [], "symbol": symbol, "found": False, "market_open": market_session.is_open()}

    # Assign expiry labels based on position
    results = []
    labels = ["Near", "Mid", "Far"]

    for idx, contract in enumerate(contracts):
        label = labels[min(idx, len(labels) - 1)]

        # Calculate days to expiry
        try:
            expiry_dt = datetime.strptime(contract.get("expiry_date", ""), "%Y-%m-%d")
            days_to_expiry = max(0, (expiry_dt.date() - datetime.now().date()).days)
        except (ValueError, TypeError, AttributeError):
            days_to_expiry = 0

        results.append(
            {
                "contract_symbol": contract.get("contract_symbol", ""),
                "token": contract.get("token", ""),
                "exchange": contract.get("exchange", "NSE"),
                "expiry_date": contract.get("expiry_date", ""),
                "expiry_label": label,
                "days_to_expiry": days_to_expiry,
                "lot_size": int(contract.get("lot_size", 1)),
                "tick_size": float(contract.get("tick_size", 0.05)),
                "instrument_type": contract.get("instrument_type", "FUTSTK"),
            }
        )

    return {
        "contracts": results,
        "symbol": symbol,
        "found": True,
        "market_open": market_session.is_open(),
    }


@router.get("/quote/{contract_symbol}")
async def get_contract_quote(
    contract_symbol: str,
    user: Optional[User] = Depends(get_current_user_optional),
):
    """
    Get live quote for a futures contract.

    Sources (in order):
        1. Redis cache (if fresh)
        2. Existing market_data service (Zebu or yfinance)

    Parameters:
        contract_symbol: Zebu futures symbol (e.g., RELIANCE25MAR2026FUT)

    Response:
        {
            "contract_symbol": str,
            "ltp": float,              # Last traded price
            "open": float,
            "high": float,
            "low": float,
            "close": float,
            "volume": int,             # Total trades volume
            "oi": int,                 # Open interest
            "oi_change": int | null,   # OI change since yesterday
            "bid": float | null,
            "ask": float | null,
            "vwap": float | null,
            "timestamp": int,          # Unix timestamp (seconds)
            "market_open": bool,
            "bid_depth": int | null,   # Bid side depth (volume)
            "ask_depth": int | null,   # Ask side depth (volume)
        }
    """
    contract_symbol = contract_symbol.upper().strip()

    # Try cache first
    cached = await futures_service.get_cache_quote(contract_symbol)
    if cached:
        return cached

    # Fetch from market data service
    quote = await futures_service.get_quote(contract_symbol)

    if not quote:
        # Return unavailable response with proper structure
        return {
            "contract_symbol": contract_symbol,
            "ltp": None,
            "open": None,
            "high": None,
            "low": None,
            "close": None,
            "volume": 0,
            "oi": 0,
            "oi_change": None,
            "bid": None,
            "ask": None,
            "vwap": None,
            "timestamp": int(datetime.now().timestamp()),
            "market_open": market_session.is_open(),
            "bid_depth": None,
            "ask_depth": None,
            "available": False,
        }

    # Cache the retrieved quote
    await futures_service.set_cache_quote(contract_symbol, quote)

    # Normalize quote response
    return {
        "contract_symbol": contract_symbol,
        "ltp": quote.get("ltp") or quote.get("price") or quote.get("lp"),
        "open": quote.get("open") or quote.get("o"),
        "high": quote.get("high") or quote.get("h"),
        "low": quote.get("low") or quote.get("l"),
        "close": quote.get("close") or quote.get("c"),
        "volume": quote.get("volume") or quote.get("v") or 0,
        "oi": quote.get("oi") or 0,
        "oi_change": quote.get("oi_change"),
        "bid": quote.get("bid") or quote.get("b"),
        "ask": quote.get("ask") or quote.get("a"),
        "vwap": quote.get("vwap"),
        "timestamp": int(
            quote.get("timestamp", datetime.now().timestamp())
        ),
        "market_open": market_session.is_open(),
        "bid_depth": quote.get("bid_depth"),
        "ask_depth": quote.get("ask_depth"),
        "available": True,
    }


@router.get("/history/{contract_symbol}")
async def get_contract_history(
    contract_symbol: str,
    interval: str = Query("5m", regex="^(1m|5m|15m|1h|1d)$"),
    limit: int = Query(30, ge=1, le=500),
    user: Optional[User] = Depends(get_current_user_optional),
):
    """
    Get OHLCV candles for a futures contract (for sparkline visualization).

    Parameters:
        contract_symbol: Zebu futures symbol
        interval: Candle interval (1m, 5m, 15m, 1h, 1d)
        limit: Number of candles (1–500, default 30)

    Response:
        List of OHLCV candles: [
            {
                "timestamp": "2026-04-02T10:00:00Z",
                "open": float,
                "high": float,
                "low": float,
                "close": float,
                "volume": int,
            },
            ...
        ]
    """
    contract_symbol = contract_symbol.upper().strip()

    history = await futures_service.get_history(
        contract_symbol, interval=interval, limit=limit
    )

    return {
        "contract_symbol": contract_symbol,
        "interval": interval,
        "candles": history,
        "market_open": market_session.is_open(),
    }


@router.get("/spot/{symbol}")
async def get_underlying_spot(
    symbol: str,
    user: Optional[User] = Depends(get_current_user_optional),
):
    """
    Get spot price for an underlying equity or index.

    Used for basis calculation (futures LTP - spot LTP) and cost of carry.

    Parameters:
        symbol: Canonical symbol (e.g., RELIANCE, ^NSEI)

    Response:
        {
            "symbol": str,
            "ltp": float,
            "change": float,              # Rs change
            "change_pct": float,          # % change
            "timestamp": int,             # Unix timestamp
            "market_open": bool,
        }
    """
    symbol = symbol.upper().strip()

    # Append .NS for equities if not an index (^NSEI, ^NSEBANK, etc.)
    if not symbol.startswith("^"):
        if not symbol.endswith((".NS", ".BO")):
            symbol = f"{symbol}.NS"

    quote = await get_system_quote_safe(symbol)

    if not quote:
        return {
            "symbol": symbol,
            "ltp": None,
            "change": 0,
            "change_pct": 0,
            "timestamp": int(datetime.now().timestamp()),
            "market_open": market_session.is_open(),
            "available": False,
        }

    return {
        "symbol": symbol,
        "ltp": quote.get("ltp") or quote.get("price") or quote.get("lp"),
        "open": quote.get("open") or quote.get("o"),
        "high": quote.get("high") or quote.get("h"),
        "low": quote.get("low") or quote.get("l"),
        "close": quote.get("close") or quote.get("c"),
        "change": quote.get("change") or 0,
        "change_pct": quote.get("change_pct") or 0,
        "volume": quote.get("volume") or 0,
        "timestamp": int(
            quote.get("timestamp", datetime.now().timestamp())
        ),
        "market_open": market_session.is_open(),
        "available": True,
    }


# ━━━ TRADING ENDPOINTS (Simulated, Local DB Only) ━━━

class PlaceFuturesOrderRequest(BaseModel):
    """Place a simulated futures order (NEVER sent to broker)."""

    contract_symbol: str  # e.g., "RELIANCE25MAR2026FUT"
    side: str  # BUY or SELL
    order_type: str = "MARKET"  # MARKET, LIMIT, STOP_LOSS, STOP_LOSS_LIMIT
    quantity: int
    price: Optional[float] = None  # For LIMIT orders
    trigger_price: Optional[float] = None  # For STOP_LOSS orders
    client_price: Optional[float] = None  # Fallback price from client
    tag: Optional[str] = None  # Optional label


@router.post("/orders/place")
async def place_order(
    req: PlaceFuturesOrderRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Place a simulated futures order (stored in local DB only, NEVER sent to broker).

    Request body:
        {
            "contract_symbol": "RELIANCE25MAR2026FUT",
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": 1,
            "price": null,
            "trigger_price": null,
            "tag": "My trade"
        }

    Response:
        {
            "success": true,
            "order_id": "uuid",
            "status": "FILLED" | "OPEN"
        }
    """
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="Side must be BUY or SELL")

    if req.quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")

    result = await place_futures_order(
        db=db,
        user_id=user.id,
        contract_symbol=req.contract_symbol,
        side=req.side,
        order_type=req.order_type,
        quantity=req.quantity,
        price=req.price,
        trigger_price=req.trigger_price,
        client_price=req.client_price,
        tag=req.tag,
    )

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Order failed"))

    return result


@router.get("/orders")
async def get_orders(
    status_filter: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get simulated futures orders for the user."""
    from sqlalchemy import select
    from models.futures_order import FuturesOrder

    query = select(FuturesOrder).where(FuturesOrder.user_id == user.id)

    if status_filter:
        query = query.where(FuturesOrder.status == status_filter)

    query = query.order_by(FuturesOrder.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    orders = result.scalars().all()

    return {
        "orders": [
            {
                "id": str(o.id),
                "contract_symbol": o.contract_symbol,
                "order_type": o.order_type,
                "side": o.side,
                "quantity": o.quantity,
                "price": float(o.price) if o.price else None,
                "trigger_price": float(o.trigger_price) if o.trigger_price else None,
                "filled_quantity": o.filled_quantity,
                "filled_price": float(o.filled_price) if o.filled_price else None,
                "status": o.status,
                "tag": o.tag,
                "created_at": o.created_at.isoformat() if o.created_at else None,
                "executed_at": o.executed_at.isoformat() if o.executed_at else None,
            }
            for o in orders
        ],
        "pagination": {"limit": limit, "offset": offset, "count": len(orders)},
    }


@router.delete("/orders/{order_id}")
async def cancel_order(
    order_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel an open simulated futures order."""
    result = await cancel_futures_order(db=db, user_id=user.id, order_id=order_id)

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Cancel failed"))

    return result


@router.get("/positions")
async def get_positions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get all open positions in simulated futures contracts."""
    positions = await get_futures_positions(db=db, user_id=user.id)
    return {"positions": positions}
