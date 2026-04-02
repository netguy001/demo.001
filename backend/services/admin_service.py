"""
Admin Service — Business logic for user account management.

All state-change actions write to the audit log within the same transaction.
Email notifications are sent as fire-and-forget background tasks.
"""

import logging
import math
from datetime import datetime, timezone, timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, case

from models.user import User, AdminAuditLog
from models.portfolio import Portfolio, Holding
from models.order import Order
from services.email_service import (
    send_account_approved_email,
    send_account_deactivated_email,
    send_access_duration_updated_email,
)
from config.settings import settings
from dependencies.admin import get_effective_admin_level, LEVEL_ROOT, LEVEL_MANAGE, LEVEL_VIEW_ONLY
from core.event_bus import event_bus, Event, EventType

logger = logging.getLogger(__name__)

_MIN_ACCESS_DAYS = 1
_MAX_ACCESS_DAYS = 365


def _is_valid_duration_days(duration_days: int) -> bool:
    return _MIN_ACCESS_DAYS <= duration_days <= _MAX_ACCESS_DAYS


def _safe_float(value, default=0.0) -> float:
    """Best-effort numeric conversion for legacy/dirty rows."""
    if value is None:
        return default
    try:
        converted = float(value)
        if not math.isfinite(converted):
            return default
        return converted
    except (TypeError, ValueError):
        return default


def _safe_iso(value) -> Optional[str]:
    """Return ISO datetime if available; pass through strings."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.isoformat()
    except Exception:
        return None


def _coerce_uuid(value) -> Optional[UUID]:
    """Parse user IDs robustly across UUID string formats."""
    if value is None:
        return None
    if isinstance(value, UUID):
        return value

    text = str(value).strip()
    if not text:
        return None

    try:
        return UUID(text)
    except (ValueError, TypeError, AttributeError):
        # Handle compact UUID strings without dashes.
        compact = text.replace("-", "")
        if len(compact) == 32:
            try:
                return UUID(compact)
            except (ValueError, TypeError, AttributeError):
                return None
        return None


async def _write_audit(
    db: AsyncSession,
    admin_user: User,
    action: str,
    target_user_id=None,
    details: dict = None,
    ip: str = None,
):
    """Write an audit log entry (same transaction as the action)."""
    log = AdminAuditLog(
        admin_user_id=admin_user.id,
        action=action,
        target_user_id=target_user_id,
        details=details or {},
        ip_address=ip,
    )
    db.add(log)


async def get_dashboard_stats(db: AsyncSession) -> dict:
    """Get aggregate stats for the admin dashboard."""
    result = await db.execute(
        select(
            func.count(User.id).label("total"),
            func.count(case((User.account_status == "pending_approval", 1))).label(
                "pending"
            ),
            func.count(case((User.account_status == "active", 1))).label("active"),
            func.count(case((User.account_status == "expired", 1))).label("expired"),
            func.count(case((User.account_status == "deactivated", 1))).label(
                "deactivated"
            ),
        ).where(User.role != "admin")
    )
    row = result.one()
    return {
        "total_users": row.total,
        "pending_approval": row.pending,
        "active": row.active,
        "expired": row.expired,
        "deactivated": row.deactivated,
    }


async def get_users_paginated(
    db: AsyncSession,
    status_filter: str = None,
    search: str = None,
    page: int = 1,
    per_page: int = 25,
) -> dict:
    """Get paginated user list with optional filtering."""
    query = select(User).where(User.role != "admin")

    if status_filter:
        query = query.where(User.account_status == status_filter)
    if search:
        like = f"%{search}%"
        query = query.where(
            (User.email.ilike(like))
            | (User.username.ilike(like))
            | (User.full_name.ilike(like))
        )

    # Count total
    count_query = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_query)).scalar() or 0

    # Paginate
    offset = (page - 1) * per_page
    query = query.order_by(User.created_at.desc()).limit(per_page).offset(offset)
    result = await db.execute(query)
    users = result.scalars().all()

    return {
        "users": [_serialize_user(u) for u in users],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": max(1, (total + per_page - 1) // per_page),
    }


async def get_user_detail(db: AsyncSession, user_id: str) -> Optional[dict]:
    """Get detailed info about a user including portfolio and recent orders."""
    target_uuid = _coerce_uuid(user_id)
    if not target_uuid:
        logger.warning("Admin get_user_detail received invalid user_id=%s", user_id)
        return None

    try:
        result = await db.execute(select(User).where(User.id == target_uuid))
        user = result.scalar_one_or_none()
        if not user:
            return None

        if user.role == "admin":
            return None

        data = _serialize_user(user)
        data["portfolio"] = None
        data["holdings"] = []
        data["recent_orders"] = []

        # Portfolio / holdings should never crash the admin panel for one bad row.
        try:
            port_result = await db.execute(
                select(Portfolio).where(Portfolio.user_id == user.id)
            )
            portfolio = port_result.scalar_one_or_none()
            if portfolio:
                data["portfolio"] = {
                    "total_invested": _safe_float(portfolio.total_invested),
                    "current_value": _safe_float(portfolio.current_value),
                    "available_capital": _safe_float(portfolio.available_capital),
                    "total_pnl": _safe_float(portfolio.total_pnl),
                    "total_pnl_percent": _safe_float(portfolio.total_pnl_percent),
                }

                hold_result = await db.execute(
                    select(Holding).where(Holding.portfolio_id == portfolio.id)
                )
                holdings = hold_result.scalars().all()
                data["holdings"] = [
                    {
                        "symbol": h.symbol,
                        "quantity": h.quantity,
                        "avg_price": _safe_float(h.avg_price),
                        "current_price": _safe_float(h.current_price),
                        "pnl": _safe_float(h.pnl),
                    }
                    for h in holdings
                ]
        except Exception:
            logger.exception(
                "Admin get_user_detail portfolio enrichment failed for user_id=%s",
                user_id,
            )

        # Recent orders (last 20)
        try:
            orders_result = await db.execute(
                select(Order)
                .where(Order.user_id == user.id)
                .order_by(Order.created_at.desc())
                .limit(20)
            )
            orders = orders_result.scalars().all()
            data["recent_orders"] = [
                {
                    "id": str(o.id),
                    "symbol": o.symbol,
                    "side": o.side,
                    "order_type": o.order_type,
                    "quantity": o.quantity,
                    "price": _safe_float(o.price, None),
                    "filled_price": _safe_float(o.filled_price, None),
                    "status": o.status,
                    "created_at": _safe_iso(o.created_at),
                }
                for o in orders
            ]
        except Exception:
            logger.exception(
                "Admin get_user_detail recent_orders enrichment failed for user_id=%s",
                user_id,
            )

        return data
    except Exception:
        logger.exception(
            "Admin get_user_detail failed for user_id=%s",
            user_id,
        )
        # Fallback to a minimal response to keep admin panel functional.
        try:
            result = await db.execute(select(User).where(User.id == target_uuid))
            user = result.scalar_one_or_none()
            if not user or user.role == "admin":
                return None
            data = _serialize_user(user)
            data["portfolio"] = None
            data["holdings"] = []
            data["recent_orders"] = []
            return data
        except Exception:
            logger.exception(
                "Admin get_user_detail fallback failed for user_id=%s",
                user_id,
            )
            return None


async def approve_user(
    db: AsyncSession,
    admin_user: User,
    target_user_id: str,
    duration_days: int = 30,
    ip: str = None,
) -> dict:
    """Approve a user account with a specified access duration."""
    target_uuid = _coerce_uuid(target_user_id)
    if not target_uuid:
        return {"success": False, "error": "Invalid user ID"}

    if not _is_valid_duration_days(duration_days):
        return {
            "success": False,
            "error": f"Duration must be between {_MIN_ACCESS_DAYS} and {_MAX_ACCESS_DAYS} days",
        }

    result = await db.execute(select(User).where(User.id == target_uuid))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": "User not found"}

    if user.role == "admin":
        return {
            "success": False,
            "error": "Cannot manage admin accounts from this panel",
        }

    if user.account_status == "active":
        return {
            "success": False,
            "error": "User is already active",
        }

    now = datetime.now(timezone.utc)
    user.account_status = "active"
    user.is_active = True
    user.access_duration_days = duration_days
    user.access_expires_at = now + timedelta(days=duration_days)
    user.approved_at = now
    user.approved_by = admin_user.id
    user.deactivation_reason = None

    await _write_audit(
        db,
        admin_user,
        "approve_user",
        target_user_id=user.id,
        details={"duration_days": duration_days},
        ip=ip,
    )

    # Send email notification (best-effort, non-blocking)
    try:
        send_account_approved_email(user, duration_days)
    except Exception:
        logger.exception("Failed to enqueue approval email for user_id=%s", user.id)

    # Emit event (best-effort)
    try:
        event_bus.emit_nowait(
            Event(
                type=EventType.USER_APPROVED,
                data={"user_id": str(user.id), "duration_days": duration_days},
                user_id=str(admin_user.id),
                source="admin",
            )
        )
    except Exception:
        logger.exception("Failed to emit USER_APPROVED event for user_id=%s", user.id)

    logger.info(
        f"Admin {admin_user.email} approved user {user.email} for {duration_days} days"
    )
    return {"success": True, "user": _serialize_user(user)}


async def deactivate_user(
    db: AsyncSession,
    admin_user: User,
    target_user_id: str,
    reason: str = None,
    ip: str = None,
) -> dict:
    """Deactivate a user account."""
    target_uuid = _coerce_uuid(target_user_id)
    if not target_uuid:
        return {"success": False, "error": "Invalid user ID"}

    result = await db.execute(select(User).where(User.id == target_uuid))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": "User not found"}

    if user.role == "admin":
        return {
            "success": False,
            "error": "Cannot manage admin accounts from this panel",
        }

    # Prevent admin from deactivating themselves
    if str(user.id) == str(admin_user.id):
        return {"success": False, "error": "Cannot deactivate your own account"}

    if user.account_status == "deactivated":
        return {
            "success": False,
            "error": "User is already deactivated",
        }

    user.account_status = "deactivated"
    user.is_active = False
    user.deactivation_reason = reason

    await _write_audit(
        db,
        admin_user,
        "deactivate_user",
        target_user_id=user.id,
        details={"reason": reason},
        ip=ip,
    )

    try:
        send_account_deactivated_email(user, reason)
    except Exception:
        logger.exception("Failed to enqueue deactivation email for user_id=%s", user.id)

    try:
        event_bus.emit_nowait(
            Event(
                type=EventType.USER_DEACTIVATED,
                data={"user_id": str(user.id), "reason": reason},
                user_id=str(admin_user.id),
                source="admin",
            )
        )
    except Exception:
        logger.exception(
            "Failed to emit USER_DEACTIVATED event for user_id=%s", user.id
        )

    logger.info(f"Admin {admin_user.email} deactivated user {user.email}: {reason}")
    return {"success": True, "user": _serialize_user(user)}


async def reactivate_user(
    db: AsyncSession,
    admin_user: User,
    target_user_id: str,
    duration_days: int = 30,
    ip: str = None,
) -> dict:
    """Reactivate a deactivated or expired user."""
    target_uuid = _coerce_uuid(target_user_id)
    if not target_uuid:
        return {"success": False, "error": "Invalid user ID"}

    if not _is_valid_duration_days(duration_days):
        return {
            "success": False,
            "error": f"Duration must be between {_MIN_ACCESS_DAYS} and {_MAX_ACCESS_DAYS} days",
        }

    result = await db.execute(select(User).where(User.id == target_uuid))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": "User not found"}

    if user.role == "admin":
        return {
            "success": False,
            "error": "Cannot manage admin accounts from this panel",
        }

    if user.account_status == "active":
        return {
            "success": False,
            "error": "User is already active",
        }

    now = datetime.now(timezone.utc)
    user.account_status = "active"
    user.is_active = True
    user.access_duration_days = duration_days
    user.access_expires_at = now + timedelta(days=duration_days)
    user.approved_at = now
    user.approved_by = admin_user.id
    user.deactivation_reason = None

    await _write_audit(
        db,
        admin_user,
        "reactivate_user",
        target_user_id=user.id,
        details={"duration_days": duration_days},
        ip=ip,
    )

    try:
        send_account_approved_email(user, duration_days)
    except Exception:
        logger.exception("Failed to enqueue reactivation email for user_id=%s", user.id)

    logger.info(
        f"Admin {admin_user.email} reactivated user {user.email} for {duration_days} days"
    )
    return {"success": True, "user": _serialize_user(user)}


async def set_access_duration(
    db: AsyncSession,
    admin_user: User,
    target_user_id: str,
    duration_days: int,
    ip: str = None,
) -> dict:
    """Update the access duration for a user."""
    target_uuid = _coerce_uuid(target_user_id)
    if not target_uuid:
        return {"success": False, "error": "Invalid user ID"}

    if not _is_valid_duration_days(duration_days):
        return {
            "success": False,
            "error": f"Duration must be between {_MIN_ACCESS_DAYS} and {_MAX_ACCESS_DAYS} days",
        }

    result = await db.execute(select(User).where(User.id == target_uuid))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": "User not found"}

    if user.role == "admin":
        return {
            "success": False,
            "error": "Cannot manage admin accounts from this panel",
        }

    now = datetime.now(timezone.utc)
    old_status = user.account_status
    old_expires = user.access_expires_at
    user.access_duration_days = duration_days
    user.access_expires_at = now + timedelta(days=duration_days)

    if user.account_status == "expired":
        user.account_status = "active"
        user.is_active = True

    await _write_audit(
        db,
        admin_user,
        "set_duration",
        target_user_id=user.id,
        details={
            "duration_days": duration_days,
            "old_status": old_status,
            "old_expires": _safe_iso(old_expires),
        },
        ip=ip,
    )

    try:
        send_access_duration_updated_email(
            user,
            duration_days=duration_days,
            access_expires_at=user.access_expires_at,
            reactivated=(old_status != "active"),
        )
    except Exception:
        logger.exception(
            "Failed to enqueue access duration update email for user_id=%s", user.id
        )

    logger.info(
        f"Admin {admin_user.email} set duration {duration_days}d for {user.email}"
    )
    return {"success": True, "user": _serialize_user(user)}


async def get_audit_log(
    db: AsyncSession,
    page: int = 1,
    per_page: int = 50,
) -> dict:
    """Get paginated audit log."""
    query = select(AdminAuditLog).order_by(AdminAuditLog.created_at.desc())

    count_query = select(func.count()).select_from(AdminAuditLog)
    total = (await db.execute(count_query)).scalar() or 0

    offset = (page - 1) * per_page
    result = await db.execute(query.limit(per_page).offset(offset))
    logs = result.scalars().all()

    # Fetch admin usernames for display
    admin_ids = {l.admin_user_id for l in logs if l.admin_user_id}
    admin_names = {}
    if admin_ids:
        users_result = await db.execute(
            select(User.id, User.email, User.full_name).where(User.id.in_(admin_ids))
        )
        for uid, email, name in users_result:
            admin_names[str(uid)] = name or email

    # Fetch target usernames
    target_ids = {l.target_user_id for l in logs if l.target_user_id}
    target_names = {}
    if target_ids:
        users_result = await db.execute(
            select(User.id, User.email, User.full_name).where(User.id.in_(target_ids))
        )
        for uid, email, name in users_result:
            target_names[str(uid)] = name or email

    return {
        "logs": [
            {
                "id": str(l.id),
                "admin_name": admin_names.get(str(l.admin_user_id), "Unknown"),
                "action": l.action,
                "target_user_name": target_names.get(str(l.target_user_id), "—"),
                "target_user_id": str(l.target_user_id) if l.target_user_id else None,
                "details": l.details,
                "ip_address": l.ip_address,
                "created_at": l.created_at.isoformat() if l.created_at else None,
            }
            for l in logs
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def _serialize_user(user: User) -> dict:
    """Serialize a User object for API responses."""
    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": user.role,
        "avatar_url": user.avatar_url,
        "is_active": user.is_active,
        "is_verified": user.is_verified,
        "account_status": user.account_status,
        "access_expires_at": _safe_iso(user.access_expires_at),
        "access_duration_days": user.access_duration_days,
        "approved_at": _safe_iso(user.approved_at),
        "deactivation_reason": user.deactivation_reason,
        "virtual_capital": _safe_float(user.virtual_capital),
        "auth_provider": user.auth_provider,
        "admin_level": user.admin_level,
        "admin_assigned_by": str(user.admin_assigned_by) if user.admin_assigned_by else None,
        "admin_assigned_at": _safe_iso(user.admin_assigned_at),
        "created_at": _safe_iso(user.created_at),
        "updated_at": _safe_iso(user.updated_at),
    }


# ── Admin Management (root only) ──────────────────────────────────────


async def list_admins(db: AsyncSession) -> list[dict]:
    """List all admin users with their levels."""
    result = await db.execute(
        select(User).where(User.role == "admin").order_by(User.created_at.asc())
    )
    admins = result.scalars().all()

    admin_list = []
    for a in admins:
        level = get_effective_admin_level(a)
        admin_list.append({
            **_serialize_user(a),
            "effective_level": level,
            "is_root": level == LEVEL_ROOT,
        })
    return admin_list


async def promote_to_admin(
    db: AsyncSession,
    root_admin: User,
    target_email: str,
    admin_level: str = LEVEL_MANAGE,
    ip: str = None,
) -> dict:
    """Promote an existing user to admin with a given permission level."""
    if admin_level not in (LEVEL_MANAGE, LEVEL_VIEW_ONLY):
        return {"success": False, "error": f"Invalid admin level: {admin_level}. Use 'manage' or 'view_only'."}

    target_email = target_email.strip().lower()

    # Cannot promote the root email (already root)
    if target_email == settings.ROOT_ADMIN_EMAIL.lower():
        return {"success": False, "error": "This account is already the root admin."}

    result = await db.execute(select(User).where(func.lower(User.email) == target_email))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": f"No user found with email: {target_email}"}

    if user.role == "admin":
        return {"success": False, "error": "This user is already an admin. Use 'Update Permissions' to change their level."}

    now = datetime.now(timezone.utc)
    user.role = "admin"
    user.admin_level = admin_level
    user.admin_assigned_by = root_admin.id
    user.admin_assigned_at = now
    # Admins should be active
    user.account_status = "active"
    user.is_active = True

    await _write_audit(
        db, root_admin, "promote_to_admin",
        target_user_id=user.id,
        details={"admin_level": admin_level, "target_email": user.email},
        ip=ip,
    )

    logger.info(f"Root admin {root_admin.email} promoted {user.email} to admin ({admin_level})")
    return {"success": True, "user": {**_serialize_user(user), "effective_level": admin_level}}


async def update_admin_level(
    db: AsyncSession,
    root_admin: User,
    target_admin_id: str,
    new_level: str,
    ip: str = None,
) -> dict:
    """Update the permission level of an existing admin."""
    if new_level not in (LEVEL_MANAGE, LEVEL_VIEW_ONLY):
        return {"success": False, "error": f"Invalid admin level: {new_level}"}

    target_uuid = _coerce_uuid(target_admin_id)
    if not target_uuid:
        return {"success": False, "error": "Invalid admin ID"}

    result = await db.execute(select(User).where(User.id == target_uuid))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": "Admin not found"}

    if user.role != "admin":
        return {"success": False, "error": "User is not an admin"}

    # Cannot change root admin's level
    if get_effective_admin_level(user) == LEVEL_ROOT:
        return {"success": False, "error": "Cannot modify root admin permissions"}

    old_level = user.admin_level
    user.admin_level = new_level

    await _write_audit(
        db, root_admin, "update_admin_level",
        target_user_id=user.id,
        details={"old_level": old_level, "new_level": new_level},
        ip=ip,
    )

    logger.info(f"Root admin {root_admin.email} changed {user.email} level: {old_level} → {new_level}")
    return {"success": True, "user": {**_serialize_user(user), "effective_level": new_level}}


async def revoke_admin(
    db: AsyncSession,
    root_admin: User,
    target_admin_id: str,
    ip: str = None,
) -> dict:
    """Revoke admin access — demote back to regular user."""
    target_uuid = _coerce_uuid(target_admin_id)
    if not target_uuid:
        return {"success": False, "error": "Invalid admin ID"}

    result = await db.execute(select(User).where(User.id == target_uuid))
    user = result.scalar_one_or_none()
    if not user:
        return {"success": False, "error": "Admin not found"}

    if user.role != "admin":
        return {"success": False, "error": "User is not an admin"}

    # Cannot revoke root admin
    if get_effective_admin_level(user) == LEVEL_ROOT:
        return {"success": False, "error": "Cannot revoke root admin access"}

    # Cannot revoke yourself
    if str(user.id) == str(root_admin.id):
        return {"success": False, "error": "Cannot revoke your own admin access"}

    old_level = user.admin_level
    user.role = "user"
    user.admin_level = None
    user.admin_assigned_by = None
    user.admin_assigned_at = None

    await _write_audit(
        db, root_admin, "revoke_admin",
        target_user_id=user.id,
        details={"old_level": old_level, "target_email": user.email},
        ip=ip,
    )

    logger.info(f"Root admin {root_admin.email} revoked admin access for {user.email}")
    return {"success": True, "user": _serialize_user(user)}
