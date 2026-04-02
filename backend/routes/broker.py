"""
Broker Routes — OAuth connect / callback / disconnect / status.

Endpoints:
    GET    /api/broker/zebu/connect      → Redirect URL for Zebu login
    POST   /api/broker/zebu/callback     → Exchange auth code for token
    DELETE /api/broker/zebu/disconnect    → Revoke broker connection
    GET    /api/broker/status             → Current connection status
    POST   /api/broker/zebu/manual-token  → Manually set session token (dev)
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional

from database.connection import get_db
from routes.auth import get_current_user
from models.user import User
from services.broker_auth import broker_auth_service
from services.broker_session import broker_session_manager

router = APIRouter(prefix="/api/broker", tags=["Broker"])


# ── Schemas ─────────────────────────────────────────────────────────


class CallbackRequest(BaseModel):
    auth_code: str
    state: str
    # Zebu redirect flow sends the token directly in URL params
    susertoken: Optional[str] = ""
    uid: Optional[str] = ""
    actid: Optional[str] = ""


class ManualTokenRequest(BaseModel):
    """Dev/testing: manually inject a session token."""

    session_token: str
    broker_user_id: Optional[str] = ""
    uid: Optional[str] = ""


class DirectLoginRequest(BaseModel):
    """Direct login to Zebu via QuickAuth API (no vendor SSO needed)."""

    zebu_user_id: str
    password: str
    factor2: Optional[str] = ""  # DOB (DD-MM-YYYY) or TOTP depending on account
    api_key: Optional[str] = (
        ""  # API Key from MYNT portal (required if not configured server-side)
    )
    vendor_code: Optional[str] = ""  # Vendor code (defaults to user ID)


# ── Routes ──────────────────────────────────────────────────────────


@router.get("/zebu/connect")
async def broker_connect(
    user: User = Depends(get_current_user),
):
    """
    Generate Zebu OAuth redirect URL for the current user.

    Frontend should redirect the browser to the returned URL.
    """
    try:
        result = await broker_auth_service.generate_connect_url(
            user_id=user.id, broker="zebu"
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/zebu/callback")
async def broker_callback(
    body: CallbackRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Exchange Zebu auth code for an access token.

    Stores the encrypted token and activates the broker connection.
    """
    try:
        result = await broker_auth_service.handle_callback(
            db=db,
            broker="zebu",
            auth_code=body.auth_code,
            state=body.state,
            susertoken=body.susertoken or "",
            uid=body.uid or "",
            actid=body.actid or "",
        )
        # Notify session manager so ZebuProvider picks up the new token
        if result.get("success"):
            await db.commit()
            await broker_session_manager.create_session(user_id=user.id)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/zebu/disconnect")
async def broker_disconnect(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Disconnect the user's Zebu broker connection.

    Wipes encrypted tokens and deactivates the account.
    """
    disconnected = await broker_auth_service.disconnect(
        db=db, user_id=user.id, broker="zebu"
    )
    if not disconnected:
        raise HTTPException(status_code=404, detail="No Zebu broker connection found")
    # Notify session manager to tear down the user's provider
    await db.commit()
    await broker_session_manager.destroy_session(user_id=user.id)
    return {"success": True, "message": "Zebu broker disconnected"}


@router.post("/zebu/login")
async def broker_direct_login(
    body: DirectLoginRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Direct Zebu login via QuickAuth API.

    Use this when vendor SSO redirect is unavailable. The user provides
    their Zebu credentials (User ID, Password, optional TOTP) and we
    authenticate server-side.
    """
    try:
        result = await broker_auth_service.direct_login(
            db=db,
            user_id=user.id,
            zebu_uid=body.zebu_user_id,
            password=body.password,
            totp=body.factor2 or "",
            api_key=body.api_key or "",
            vendor_code=body.vendor_code or "",
        )
        if result.get("success"):
            await db.commit()
            await broker_session_manager.create_session(user_id=user.id)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/status")
async def broker_status(
    broker: str = Query(default="zebu"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current broker connection status for the user."""
    return await broker_auth_service.get_status(db=db, user_id=user.id, broker=broker)


@router.post("/zebu/manual-token")
async def broker_manual_token(
    body: ManualTokenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Dev endpoint: manually set a Zebu session token.

    Use this when you have a valid susertoken from an external
    login (e.g. Zebu desktop app, curl, etc.) and want to inject it
    directly without going through OAuth redirect.
    """
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select, and_
    from models.broker import BrokerAccount
    from services.broker_crypto import encrypt_token, encrypt_json

    extra = {"uid": body.uid or "", "actid": body.broker_user_id or "", "manual": True}

    result = await db.execute(
        select(BrokerAccount).where(
            and_(
                BrokerAccount.user_id == user.id,
                BrokerAccount.broker == "zebu",
            )
        )
    )
    account = result.scalar_one_or_none()

    if account:
        account.access_token_enc = encrypt_token(body.session_token)
        account.broker_user_id = body.broker_user_id or account.broker_user_id
        account.extra_data_enc = encrypt_json(extra)
        account.is_active = True
        account.token_expiry = datetime.now(timezone.utc) + timedelta(hours=8)
        account.last_used_at = datetime.now(timezone.utc)
    else:
        account = BrokerAccount(
            user_id=user.id,
            broker="zebu",
            broker_user_id=body.broker_user_id or "",
            access_token_enc=encrypt_token(body.session_token),
            extra_data_enc=encrypt_json(extra),
            is_active=True,
            token_expiry=datetime.now(timezone.utc) + timedelta(hours=8),
            connected_at=datetime.now(timezone.utc),
            last_used_at=datetime.now(timezone.utc),
        )
        db.add(account)

    await db.flush()
    await db.commit()

    # Create a live provider session for this user
    await broker_session_manager.create_session(user_id=user.id)

    return {
        "success": True,
        "message": "Session token stored (manual) — broker session activated",
        "broker_user_id": body.broker_user_id,
    }


@router.get("/master-status")
async def broker_master_status():
    """
    Check if the master Zebu account is connected and available.

    Returns:
        {
            "connected": bool,
            "error": str or null,  # Human-readable error if not connected
            "details": {...}  # Additional info about the master session
        }

    Used by frontend to detect if live market data is available.
    If not connected, shows user why (missing .env vars, auth failed, etc).
    """
    from services.master_session import master_session_service

    status = master_session_service.get_status()
    if not status["active"]:
        if status["missing"]:
            error_reason = (
                "Master Zebu not fully configured. Missing: "
                + ", ".join(status["missing"])
                + ". Set these in .env / deployment secrets."
            )
        elif status.get("last_error"):
            error_reason = f"Master Zebu connection failed: {status['last_error']}"
        else:
            error_reason = "Master Zebu connection is inactive. Check backend logs."

        return {
            "connected": False,
            "error": error_reason,
            "details": {
                "configured": status["configured"],
                "user_id": status["user_id"],
                "missing": status["missing"],
                "last_error": status.get("last_error"),
            },
        }

    return {
        "connected": True,
        "error": None,
        "details": {
            "configured": status["configured"],
            "user_id": status["user_id"],
            "message": "Live NSE market data is available for all users",
        },
    }
