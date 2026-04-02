"""
Admin dependencies — FastAPI Depends() guards for admin routes.

Security layers:
  1. Firebase token → get_current_user() (existing)
  2. role='admin'  → get_admin_user()
  3. 2FA session   → require_2fa_session()
  4. Admin level   → require_root_admin() / require_manage_level()

Admin levels (stored in User.admin_level):
  - "root"      → full access, can manage other admins
  - "manage"    → can approve/deactivate/reactivate users
  - "view_only" → read-only dashboard access
"""

import logging
from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from database.connection import get_db
from models.user import User
from routes.auth import get_current_user
from services.admin_2fa_service import validate_admin_session
from config.settings import settings

logger = logging.getLogger(__name__)

# ── Admin level constants ─────────────────────────────────────────────
LEVEL_ROOT = "root"
LEVEL_MANAGE = "manage"
LEVEL_VIEW_ONLY = "view_only"


def get_effective_admin_level(user: User) -> str:
    """Determine the effective admin level for a user.

    Root admin is identified by email match against ROOT_ADMIN_EMAIL config.
    Other admins use the admin_level column. Falls back to "manage" for
    legacy admins who have role='admin' but no admin_level set.
    """
    if user.email and user.email.lower() == settings.ROOT_ADMIN_EMAIL.lower():
        return LEVEL_ROOT
    return user.admin_level or LEVEL_MANAGE


async def get_admin_user(
    user: User = Depends(get_current_user),
) -> User:
    """Require the current user to have role='admin'."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def require_2fa_session(
    request: Request,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Require a valid admin session (2FA verified).

    The frontend sends the admin session token in the X-Admin-Session header.
    This token is issued after successful TOTP verification and expires after
    ADMIN_SESSION_EXPIRY_MINUTES (default 30 minutes).
    """
    session_token = request.headers.get("X-Admin-Session")
    if not session_token:
        raise HTTPException(
            status_code=403,
            detail="Admin 2FA session required. Please verify your identity.",
        )

    session = await validate_admin_session(db, session_token)
    if not session:
        raise HTTPException(
            status_code=403,
            detail="Admin session expired or invalid. Please re-verify 2FA.",
        )

    # Ensure session belongs to the current admin
    if str(session.user_id) != str(admin.id):
        raise HTTPException(status_code=403, detail="Session mismatch")

    return admin


async def require_root_admin(
    admin: User = Depends(require_2fa_session),
) -> User:
    """Require the admin to be the root admin."""
    level = get_effective_admin_level(admin)
    if level != LEVEL_ROOT:
        raise HTTPException(
            status_code=403,
            detail="Root admin access required for this action",
        )
    return admin


async def require_manage_level(
    admin: User = Depends(require_2fa_session),
) -> User:
    """Require the admin to have at least 'manage' level (root also qualifies)."""
    level = get_effective_admin_level(admin)
    if level == LEVEL_VIEW_ONLY:
        raise HTTPException(
            status_code=403,
            detail="You have view-only access. Contact root admin for elevated permissions.",
        )
    return admin
