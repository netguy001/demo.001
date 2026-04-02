import asyncio
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from models.algo import AlgoStrategy, AlgoLog, AlgoTrade
from services import market_data
import logging

logger = logging.getLogger(__name__)

# Active strategy tasks
_active_strategies: dict = {}


async def get_strategies(db: AsyncSession, user_id: str) -> list:
    """Get all algo strategies for a user."""
    result = await db.execute(
        select(AlgoStrategy).where(AlgoStrategy.user_id == user_id)
    )
    strategies = result.scalars().all()
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "description": s.description,
            "strategy_type": s.strategy_type,
            "symbol": s.symbol,
            "is_active": s.is_active,
            "parameters": s.parameters,
            "max_position_size": s.max_position_size,
            "stop_loss_percent": float(s.stop_loss_percent),
            "take_profit_percent": float(s.take_profit_percent),
            "total_trades": s.total_trades,
            "total_pnl": float(round(s.total_pnl, 2)),
            "win_rate": float(round(s.win_rate, 2)),
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in strategies
    ]


async def create_strategy(
    db: AsyncSession,
    user_id: str,
    name: str,
    strategy_type: str,
    symbol: str,
    description: str = "",
    parameters: dict = None,
    max_position_size: int = 100,
    stop_loss_percent: float = 2.0,
    take_profit_percent: float = 5.0,
) -> dict:
    """Create a new algo strategy."""
    strategy = AlgoStrategy(
        user_id=user_id,
        name=name,
        description=description,
        strategy_type=strategy_type,
        symbol=market_data._format_symbol(symbol),
        parameters=parameters or {},
        max_position_size=max_position_size,
        stop_loss_percent=stop_loss_percent,
        take_profit_percent=take_profit_percent,
    )
    db.add(strategy)
    await db.flush()

    # Add log
    log = AlgoLog(
        strategy_id=strategy.id,
        level="INFO",
        message=f"Strategy '{name}' created for {symbol}",
    )
    db.add(log)

    return {"success": True, "strategy_id": str(strategy.id)}


async def toggle_strategy(db: AsyncSession, user_id: str, strategy_id: str) -> dict:
    """Enable or disable an algo strategy. Closes open positions on deactivate."""
    result = await db.execute(
        select(AlgoStrategy).where(
            AlgoStrategy.id == strategy_id,
            AlgoStrategy.user_id == user_id,
        )
    )
    strategy = result.scalar_one_or_none()
    if not strategy:
        return {"success": False, "error": "Strategy not found"}

    strategy.is_active = not strategy.is_active
    status = "activated" if strategy.is_active else "deactivated"

    # Close any open position when deactivating
    closed_msg = ""
    if not strategy.is_active:
        from workers.algo_worker import algo_strategy_worker
        pnl = await algo_strategy_worker.close_strategy_position(strategy_id)
        if pnl is not None:
            closed_msg = f" — closed open position"

    log = AlgoLog(
        strategy_id=strategy.id,
        level="INFO",
        message=f"Strategy '{strategy.name}' {status}{closed_msg}",
    )
    db.add(log)

    return {
        "success": True,
        "is_active": strategy.is_active,
        "message": f"Strategy {status}{closed_msg}",
    }


async def delete_strategy(db: AsyncSession, user_id: str, strategy_id: str) -> dict:
    """Delete an algo strategy (must be deactivated first)."""
    result = await db.execute(
        select(AlgoStrategy).where(
            AlgoStrategy.id == strategy_id,
            AlgoStrategy.user_id == user_id,
        )
    )
    strategy = result.scalar_one_or_none()
    if not strategy:
        return {"success": False, "error": "Strategy not found"}
    if strategy.is_active:
        return {"success": False, "error": "Deactivate the strategy before deleting"}
    await db.delete(strategy)
    return {"success": True}


async def update_strategy(
    db: AsyncSession,
    user_id: str,
    strategy_id: str,
    name: str = None,
    description: str = None,
    parameters: dict = None,
    max_position_size: int = None,
    stop_loss_percent: float = None,
    take_profit_percent: float = None,
) -> dict:
    """Update an algo strategy's configuration."""
    result = await db.execute(
        select(AlgoStrategy).where(
            AlgoStrategy.id == strategy_id,
            AlgoStrategy.user_id == user_id,
        )
    )
    strategy = result.scalar_one_or_none()
    if not strategy:
        return {"success": False, "error": "Strategy not found"}

    if name is not None:
        strategy.name = name
    if description is not None:
        strategy.description = description
    if parameters is not None:
        strategy.parameters = parameters
    if max_position_size is not None:
        strategy.max_position_size = max_position_size
    if stop_loss_percent is not None:
        strategy.stop_loss_percent = stop_loss_percent
    if take_profit_percent is not None:
        strategy.take_profit_percent = take_profit_percent

    strategy.updated_at = datetime.now(timezone.utc)

    log = AlgoLog(
        strategy_id=strategy.id,
        level="INFO",
        message=f"Strategy '{strategy.name}' parameters updated",
    )
    db.add(log)
    return {"success": True}


async def get_strategy_logs(
    db: AsyncSession, strategy_id: str, limit: int = 50
) -> list:
    """Get logs for a specific strategy."""
    result = await db.execute(
        select(AlgoLog)
        .where(AlgoLog.strategy_id == strategy_id)
        .order_by(AlgoLog.created_at.desc())
        .limit(limit)
    )
    logs = result.scalars().all()
    return [
        {
            "id": str(l.id),
            "level": l.level,
            "message": l.message,
            "data": l.data,
            "created_at": l.created_at.isoformat() if l.created_at else None,
        }
        for l in logs
    ]
