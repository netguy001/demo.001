from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional
from database.connection import get_db
from models.user import User
from routes.auth import get_current_user
from services.algo_engine import (
    get_strategies,
    create_strategy,
    toggle_strategy,
    get_strategy_logs,
    delete_strategy,
    update_strategy,
)

router = APIRouter(prefix="/api/algo", tags=["Algo Trading"])


class CreateStrategyRequest(BaseModel):
    name: str
    strategy_type: str
    symbol: str
    description: str = ""
    parameters: Optional[dict] = None
    max_position_size: int = 100
    stop_loss_percent: float = 2.0
    take_profit_percent: float = 5.0


@router.get("/strategies")
async def list_strategies(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    strategies = await get_strategies(db, user.id)
    return {"strategies": strategies}


@router.post("/strategies")
async def new_strategy(
    req: CreateStrategyRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await create_strategy(
        db=db,
        user_id=user.id,
        name=req.name,
        strategy_type=req.strategy_type,
        symbol=req.symbol,
        description=req.description,
        parameters=req.parameters,
        max_position_size=req.max_position_size,
        stop_loss_percent=req.stop_loss_percent,
        take_profit_percent=req.take_profit_percent,
    )
    return result


@router.put("/strategies/{strategy_id}/toggle")
async def toggle(
    strategy_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await toggle_strategy(db, user.id, strategy_id)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


class UpdateStrategyRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    parameters: Optional[dict] = None
    max_position_size: Optional[int] = None
    stop_loss_percent: Optional[float] = None
    take_profit_percent: Optional[float] = None


@router.put("/strategies/{strategy_id}")
async def update(
    strategy_id: str,
    req: UpdateStrategyRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await update_strategy(
        db=db,
        user_id=user.id,
        strategy_id=strategy_id,
        name=req.name,
        description=req.description,
        parameters=req.parameters,
        max_position_size=req.max_position_size,
        stop_loss_percent=req.stop_loss_percent,
        take_profit_percent=req.take_profit_percent,
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.delete("/strategies/{strategy_id}")
async def delete(
    strategy_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await delete_strategy(db, user.id, strategy_id)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/strategies/{strategy_id}/logs")
async def strategy_logs(
    strategy_id: str,
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    logs = await get_strategy_logs(db, strategy_id, limit)
    return {"logs": logs}
