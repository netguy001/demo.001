from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from database.connection import get_db
from models.user import User
from models.order import Order
from models.portfolio import Portfolio, Holding, Transaction
from routes.auth import get_current_user
from services.portfolio_service import (
    get_portfolio_summary,
    get_holdings,
    invalidate_user_portfolio_cache,
)
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/portfolio", tags=["Portfolio"])

DEFAULT_CAPITAL = Decimal("1000000.00")  # 10 Lakh


@router.get("")
async def get_portfolio(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    summary = await get_portfolio_summary(db, user.id)
    return summary


@router.get("/holdings")
async def get_user_holdings(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    holdings = await get_holdings(db, user.id)
    return {"holdings": holdings}


@router.get("/summary")
async def get_summary(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    summary = await get_portfolio_summary(db, user.id)
    holdings = await get_holdings(db, user.id)
    return {
        "summary": summary,
        "holdings": holdings,
    }


# ── Capital Management ─────────────────────────────────────────────────────


class AddCapitalRequest(BaseModel):
    amount: float  # Amount in rupees to add


class SetCapitalRequest(BaseModel):
    amount: float  # New total capital amount


@router.post("/add-capital")
async def add_capital(
    req: AddCapitalRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add additional capital to the portfolio."""
    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")
    if req.amount > 100_000_000:  # 10 crore max
        raise HTTPException(
            status_code=400, detail="Maximum single addition is 10 crore"
        )

    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user.id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    amount = Decimal(str(req.amount))
    portfolio.available_capital = Decimal(str(portfolio.available_capital or 0))
    user.virtual_capital = Decimal(str(user.virtual_capital or 0))
    portfolio.available_capital += amount
    user.virtual_capital += amount
    await db.commit()
    invalidate_user_portfolio_cache(str(user.id))

    logger.info(f"[Capital] User {str(user.id)[:8]} added ₹{amount:,.2f}")
    return {
        "success": True,
        "available_capital": float(portfolio.available_capital),
        "message": f"Added ₹{amount:,.2f} to your portfolio",
    }


@router.post("/reset-capital")
async def reset_capital(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset capital back to default (10 Lakh) without affecting positions."""
    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user.id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    portfolio.available_capital = DEFAULT_CAPITAL
    portfolio.total_pnl = Decimal("0")
    portfolio.total_pnl_percent = Decimal("0")
    user.virtual_capital = DEFAULT_CAPITAL
    await db.commit()
    invalidate_user_portfolio_cache(str(user.id))

    logger.info(
        f"[Capital] User {str(user.id)[:8]} reset capital to ₹{DEFAULT_CAPITAL:,.2f}"
    )
    return {
        "success": True,
        "available_capital": float(portfolio.available_capital),
        "message": f"Capital reset to ₹{DEFAULT_CAPITAL:,.2f}",
    }


@router.post("/set-capital")
async def set_capital(
    req: SetCapitalRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set available capital to a custom amount."""
    if req.amount < 0:
        raise HTTPException(status_code=400, detail="Amount cannot be negative")
    if req.amount > 1_000_000_000:  # 100 crore max
        raise HTTPException(status_code=400, detail="Maximum capital is 100 crore")

    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user.id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    amount = Decimal(str(req.amount))
    portfolio.available_capital = amount
    user.virtual_capital = amount
    await db.commit()
    invalidate_user_portfolio_cache(str(user.id))

    logger.info(f"[Capital] User {str(user.id)[:8]} set capital to ₹{req.amount:,.2f}")
    return {
        "success": True,
        "available_capital": float(portfolio.available_capital),
        "message": f"Capital set to ₹{req.amount:,.2f}",
    }


@router.post("/reset-account")
async def reset_account(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full account reset — clears all positions, orders, and resets capital to 10L."""
    result = await db.execute(select(Portfolio).where(Portfolio.user_id == user.id))
    portfolio = result.scalar_one_or_none()
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    # Delete all holdings
    await db.execute(delete(Holding).where(Holding.portfolio_id == portfolio.id))

    # Delete all orders
    await db.execute(delete(Order).where(Order.user_id == user.id))

    # Delete all transactions
    try:
        await db.execute(delete(Transaction).where(Transaction.user_id == user.id))
    except Exception:
        pass  # Transaction table may not exist

    # Reset portfolio
    portfolio.available_capital = DEFAULT_CAPITAL
    portfolio.total_invested = Decimal("0")
    portfolio.current_value = Decimal("0")
    portfolio.total_pnl = Decimal("0")
    portfolio.total_pnl_percent = Decimal("0")
    user.virtual_capital = DEFAULT_CAPITAL

    await db.commit()
    invalidate_user_portfolio_cache(str(user.id))

    logger.info(f"[Account] User {str(user.id)[:8]} full account reset")
    return {
        "success": True,
        "message": "Account reset complete. Capital restored to ₹10,00,000. All positions and orders cleared.",
    }
