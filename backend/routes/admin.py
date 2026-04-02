"""
Admin Panel API — Complete user account management + admin hierarchy.

Security layers:
  1. Firebase token (Bearer header) → identity verification
  2. role='admin' check → restricts to admins
  3. TOTP 2FA → X-Admin-Session header with short-lived token
  4. Admin level → root / manage / view_only permission checks
  5. Audit logging → every action recorded

Admin levels:
  - root:      Full access. Can create/manage/revoke other admins.
  - manage:    Can approve/deactivate/reactivate users.
  - view_only: Read-only dashboard access.

All endpoints under /api/admin/*
"""

import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field
from typing import Optional

from database.connection import get_db
from models.user import User
from dependencies.admin import (
    get_admin_user,
    require_2fa_session,
    require_root_admin,
    require_manage_level,
    get_effective_admin_level,
)
from services import admin_service, admin_2fa_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["Admin"])


def _normalize_user_id(user_id: str) -> UUID:
    """Validate and return UUID object for DB-safe comparisons."""
    try:
        return UUID(str(user_id).strip())
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid user ID format")


# ── Schemas ──────────────────────────────────────────────────────────


class Setup2FAResponse(BaseModel):
    secret: str
    uri: str


class Verify2FARequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=8, pattern=r"^\d{6,8}$")


class ApproveUserRequest(BaseModel):
    duration_days: int = Field(default=30, ge=1, le=365)


class DeactivateUserRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=500)
    totp_code: str = Field(..., min_length=6, max_length=8, pattern=r"^\d{6,8}$")


class ReactivateUserRequest(BaseModel):
    duration_days: int = Field(default=30, ge=1, le=365)


class SetDurationRequest(BaseModel):
    duration_days: int = Field(..., ge=1, le=365)


class PromoteAdminRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    admin_level: str = Field(default="manage", pattern=r"^(manage|view_only)$")


class UpdateAdminLevelRequest(BaseModel):
    admin_level: str = Field(..., pattern=r"^(manage|view_only)$")


# ── 2FA Auth Endpoints (require admin role, NOT 2FA session) ─────────


@router.get("/auth/status")
async def get_2fa_status(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """Check if the admin has 2FA set up."""
    has_2fa = await admin_2fa_service.has_2fa_enabled(db, admin.id)
    return {"has_2fa": has_2fa, "admin_email": admin.email}


@router.post("/auth/setup-2fa")
async def setup_2fa(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a new TOTP secret. Returns QR code URI for scanning."""
    result = await admin_2fa_service.generate_totp_secret(db, admin)
    logger.info(f"2FA setup initiated for admin {admin.email}")
    return result


@router.post("/auth/enable-2fa")
async def enable_2fa(
    req: Verify2FARequest,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """Verify a TOTP code to enable 2FA. Must be called after setup."""
    success = await admin_2fa_service.enable_2fa(db, admin, req.code)
    if not success:
        raise HTTPException(
            status_code=400, detail="Invalid TOTP code. Please try again."
        )
    logger.info(f"2FA enabled for admin {admin.email}")
    return {"success": True, "message": "2FA is now enabled"}


@router.post("/auth/verify-2fa")
async def verify_2fa(
    req: Verify2FARequest,
    request: Request,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """Verify TOTP code and create an admin session token."""
    # Check if 2FA is set up
    has_2fa = await admin_2fa_service.has_2fa_enabled(db, admin.id)
    if not has_2fa:
        raise HTTPException(
            status_code=400, detail="2FA is not set up. Please set up 2FA first."
        )

    success = await admin_2fa_service.verify_totp(db, admin, req.code)
    if not success:
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    # Create admin session
    ip = request.client.host if request.client else None
    ua = request.headers.get("User-Agent", "")[:500]
    token = await admin_2fa_service.create_admin_session(db, admin, ip, ua)

    logger.info(f"Admin 2FA verified: {admin.email} from {ip}")
    return {"session_token": token}


@router.post("/auth/validate-session")
async def validate_session(
    admin: User = Depends(require_2fa_session),
):
    """Validate the current admin session is still active."""
    level = get_effective_admin_level(admin)
    return {"valid": True, "admin_email": admin.email, "admin_level": level}


# ── Dashboard ────────────────────────────────────────────────────────


@router.get("/dashboard/stats")
async def dashboard_stats(
    admin: User = Depends(require_2fa_session),
    db: AsyncSession = Depends(get_db),
):
    """Get aggregate dashboard statistics."""
    stats = await admin_service.get_dashboard_stats(db)
    level = get_effective_admin_level(admin)
    stats["admin_level"] = level
    return stats


# ── User Management (require at least 'manage' for writes) ──────────


@router.get("/users")
async def list_users(
    status: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    per_page: int = 25,
    admin: User = Depends(require_2fa_session),
    db: AsyncSession = Depends(get_db),
):
    """List all users with pagination and filtering."""
    per_page = min(per_page, 100)  # Cap page size
    return await admin_service.get_users_paginated(db, status, search, page, per_page)


@router.get("/users/{user_id}")
async def get_user_detail(
    user_id: str,
    admin: User = Depends(require_2fa_session),
    db: AsyncSession = Depends(get_db),
):
    """Get detailed user info including portfolio and orders."""
    normalized_user_id = _normalize_user_id(user_id)
    data = await admin_service.get_user_detail(db, normalized_user_id)
    if not data:
        raise HTTPException(status_code=404, detail="User not found")
    return data


@router.post("/users/{user_id}/approve")
async def approve_user(
    user_id: str,
    req: ApproveUserRequest,
    request: Request,
    admin: User = Depends(require_manage_level),
    db: AsyncSession = Depends(get_db),
):
    """Approve a pending user account with access duration."""
    normalized_user_id = _normalize_user_id(user_id)
    ip = request.client.host if request.client else None
    result = await admin_service.approve_user(
        db, admin, normalized_user_id, req.duration_days, ip
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/users/{user_id}/deactivate")
async def deactivate_user(
    user_id: str,
    req: DeactivateUserRequest,
    request: Request,
    admin: User = Depends(require_manage_level),
    db: AsyncSession = Depends(get_db),
):
    """Deactivate a user account. Requires TOTP code for confirmation."""
    normalized_user_id = _normalize_user_id(user_id)
    # Require fresh TOTP for destructive actions.
    valid = await admin_2fa_service.verify_totp(db, admin, req.totp_code)
    if not valid:
        raise HTTPException(
            status_code=401, detail="Invalid TOTP code for action confirmation"
        )

    ip = request.client.host if request.client else None
    result = await admin_service.deactivate_user(
        db, admin, normalized_user_id, req.reason, ip
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/users/{user_id}/reactivate")
async def reactivate_user(
    user_id: str,
    req: ReactivateUserRequest,
    request: Request,
    admin: User = Depends(require_manage_level),
    db: AsyncSession = Depends(get_db),
):
    """Reactivate a deactivated or expired user."""
    normalized_user_id = _normalize_user_id(user_id)
    ip = request.client.host if request.client else None
    result = await admin_service.reactivate_user(
        db, admin, normalized_user_id, req.duration_days, ip
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/users/{user_id}/set-duration")
async def set_duration(
    user_id: str,
    req: SetDurationRequest,
    request: Request,
    admin: User = Depends(require_manage_level),
    db: AsyncSession = Depends(get_db),
):
    """Set or update access duration for a user."""
    normalized_user_id = _normalize_user_id(user_id)
    ip = request.client.host if request.client else None
    result = await admin_service.set_access_duration(
        db, admin, normalized_user_id, req.duration_days, ip
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Admin Management (root only) ────────────────────────────────────


@router.get("/admins")
async def list_admins(
    admin: User = Depends(require_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """List all admin users. Root only."""
    admins = await admin_service.list_admins(db)
    return {"admins": admins}


@router.post("/admins/promote")
async def promote_to_admin(
    req: PromoteAdminRequest,
    request: Request,
    admin: User = Depends(require_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """Promote an existing user to admin. Root only."""
    ip = request.client.host if request.client else None
    result = await admin_service.promote_to_admin(
        db, admin, req.email, req.admin_level, ip
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.patch("/admins/{admin_id}/level")
async def update_admin_level(
    admin_id: str,
    req: UpdateAdminLevelRequest,
    request: Request,
    admin: User = Depends(require_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update an admin's permission level. Root only."""
    ip = request.client.host if request.client else None
    result = await admin_service.update_admin_level(
        db, admin, admin_id, req.admin_level, ip
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.delete("/admins/{admin_id}")
async def revoke_admin(
    admin_id: str,
    request: Request,
    admin: User = Depends(require_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """Revoke admin access — demote back to user. Root only."""
    ip = request.client.host if request.client else None
    result = await admin_service.revoke_admin(db, admin, admin_id, ip)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Audit Log ────────────────────────────────────────────────────────


@router.get("/audit-log")
async def get_audit_log(
    page: int = 1,
    per_page: int = 50,
    admin: User = Depends(require_2fa_session),
    db: AsyncSession = Depends(get_db),
):
    """View the admin audit trail."""
    per_page = min(per_page, 200)
    return await admin_service.get_audit_log(db, page, per_page)
