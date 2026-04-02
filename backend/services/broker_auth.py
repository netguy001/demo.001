"""
Broker Auth Service — Zebu OAuth / API-key login flow.

Handles the full lifecycle of a per-user broker connection:

    1.  generate_connect_url()   → Build the redirect URL for Zebu login.
    2.  handle_callback()        → Exchange the auth code for an access token.
    3.  get_active_session()     → Return a decrypted, valid session token.
    4.  refresh_session()        → Renew an expired token if possible.
    5.  disconnect()             → Revoke and remove a broker link.

Zebu Auth Flow (NorenOMS / Zebull API):
    ┌──────────┐     ┌──────────┐     ┌──────────┐
    │ Frontend  │────→│ AlphaSync│────→│  Zebu    │
    │           │     │  Backend │     │  Server  │
    └──────────┘     └──────────┘     └──────────┘
         │                │                 │
         │  1. GET /broker/connect/zebu      │
         │────────────────→│                 │
         │  2. Redirect URL │                │
         │←────────────────│                 │
         │  3. User logs in at Zebu          │
         │──────────────────────────────────→│
         │  4. Redirect back with auth code  │
         │←──────────────────────────────────│
         │  5. GET /broker/callback/zebu?code=...
         │────────────────→│                 │
         │                 │ 6. POST token exchange
         │                 │────────────────→│
         │                 │ 7. access_token  │
         │                 │←────────────────│
         │                 │ 8. Encrypt & store
         │  9. { connected }│                │
         │←────────────────│                 │

IMPORTANT:
    - We ONLY use the token for opening a market-data WebSocket.
    - We NEVER call order-placement or funds-transfer APIs.
    - The token is encrypted at rest (AES-256-GCM).
"""

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from config.settings import settings
from models.broker import BrokerAccount
from services.broker_crypto import (
    encrypt_token,
    decrypt_token,
    encrypt_json,
    decrypt_json,
)

logger = logging.getLogger(__name__)

# ── Zebu API endpoints ──────────────────────────────────────────────
ZEBU_API_BASE = settings.ZEBU_API_URL
# NOTE: ZEBU_AUTH_URL is now in settings (configurable via .env)


class BrokerAuthService:
    """
    Manages broker authentication flows.

    Broker-agnostic interface; the `broker` parameter selects the
    concrete implementation (currently only "zebu").
    """

    # ── OAuth state tokens (in-memory, short-lived) ─────────────────
    # Maps state_token → {"user_id": str, "created": datetime}
    # In production, use Redis with TTL instead.
    _pending_states: dict[str, dict] = {}

    # ────────────────────────────────────────────────────────────────
    # 1. Generate Connect URL
    # ────────────────────────────────────────────────────────────────

    async def generate_connect_url(self, user_id: str, broker: str = "zebu") -> dict:
        """
        Build the redirect URL for the broker login page.

        Returns: { "redirect_url": str, "state": str }
        """
        if broker != "zebu":
            raise ValueError(f"Unsupported broker: {broker}")

        state = secrets.token_urlsafe(32)
        self._pending_states[state] = {
            "user_id": user_id,
            "created": datetime.now(timezone.utc),
        }

        # Zebu uses a vendor-key + redirect-based login.
        # The redirect_url is where Zebu sends the auth code after login.
        redirect_url = (
            f"{settings.ZEBU_AUTH_URL}"
            f"?vendor_code={settings.ZEBU_VENDOR_CODE}"
            f"&redirect_uri={settings.ZEBU_REDIRECT_URI}"
            f"&state={state}"
        )

        return {"redirect_url": redirect_url, "state": state}

    # ────────────────────────────────────────────────────────────────
    # 2. Handle Callback (exchange code for token)
    # ────────────────────────────────────────────────────────────────

    async def handle_callback(
        self,
        db: AsyncSession,
        broker: str,
        auth_code: str,
        state: str,
        susertoken: str = "",
        uid: str = "",
        actid: str = "",
    ) -> dict:
        """
        Exchange the auth code for an access token and store it encrypted.

        Zebu's vendor redirect flow can return the session token directly
        (susertoken param), in which case no QuickAuth call is needed.
        If only auth_code is provided, we call QuickAuth to exchange it.

        Returns: { "success": True, "broker_user_id": str }
        Raises: ValueError on invalid state or failed exchange.
        """
        if broker != "zebu":
            raise ValueError(f"Unsupported broker: {broker}")

        # ── Validate state ──────────────────────────────────────────
        pending = self._pending_states.pop(state, None)
        if not pending:
            raise ValueError("Invalid or expired OAuth state token")

        # States older than 10 minutes are rejected
        if (datetime.now(timezone.utc) - pending["created"]).total_seconds() > 600:
            raise ValueError("OAuth state token expired (>10 min)")

        user_id = pending["user_id"]

        # ── Get token: direct from redirect OR via QuickAuth ───────
        if susertoken:
            # Zebu vendor redirect gave us the token directly
            token_data = {
                "susertoken": susertoken,
                "uid": uid or "",
                "actid": actid or uid or "",
                "stat": "Ok",
            }
            logger.info("Using direct susertoken from Zebu redirect")
        else:
            # Fall back to QuickAuth exchange (needs uid)
            token_data = await self._zebu_token_exchange(auth_code, uid=uid)
            if not token_data.get("susertoken"):
                raise ValueError(
                    f"Zebu token exchange failed: {token_data.get('emsg', 'unknown error')}"
                )

        # ── Encrypt and store ───────────────────────────────────────
        access_token_enc = encrypt_token(token_data["susertoken"])
        broker_user_id = token_data.get("actid", token_data.get("uid", ""))

        # Build extra data blob (non-sensitive metadata)
        extra = {
            "uid": token_data.get("uid", ""),
            "actid": token_data.get("actid", ""),
            "brkname": token_data.get("brkname", "ZEBU"),
            "email": token_data.get("email", ""),
        }

        # Upsert broker account
        result = await db.execute(
            select(BrokerAccount).where(
                and_(
                    BrokerAccount.user_id == user_id,
                    BrokerAccount.broker == broker,
                )
            )
        )
        account = result.scalar_one_or_none()

        if account:
            account.access_token_enc = access_token_enc
            account.broker_user_id = broker_user_id
            account.extra_data_enc = encrypt_json(extra)
            account.is_active = True
            account.token_expiry = datetime.now(timezone.utc) + timedelta(hours=8)
            account.last_used_at = datetime.now(timezone.utc)
        else:
            account = BrokerAccount(
                user_id=user_id,
                broker=broker,
                broker_user_id=broker_user_id,
                access_token_enc=access_token_enc,
                extra_data_enc=encrypt_json(extra),
                is_active=True,
                token_expiry=datetime.now(timezone.utc) + timedelta(hours=8),
                connected_at=datetime.now(timezone.utc),
                last_used_at=datetime.now(timezone.utc),
            )
            db.add(account)

        await db.flush()

        logger.info(
            f"Broker connected: user={str(user_id)[:8]} broker={broker} "
            f"broker_user={broker_user_id}"
        )

        return {
            "success": True,
            "broker": broker,
            "broker_user_id": broker_user_id,
        }

    # ────────────────────────────────────────────────────────────────
    # 3. Get Active Session Token
    # ────────────────────────────────────────────────────────────────

    async def get_active_session(
        self, db: AsyncSession, user_id: str, broker: str = "zebu"
    ) -> Optional[dict]:
        """
        Retrieve an active, decrypted session for opening WebSocket.

        Returns:
            {
                "user_id": str,           # Zebu user ID
                "session_token": str,     # Decrypted susertoken
                "broker_user_id": str,
                "extra": dict,
            }
            or None if no active connection.
        """
        result = await db.execute(
            select(BrokerAccount).where(
                and_(
                    BrokerAccount.user_id == user_id,
                    BrokerAccount.broker == broker,
                    BrokerAccount.is_active == True,  # noqa: E712
                )
            )
        )
        account = result.scalar_one_or_none()
        if not account:
            return None

        # Check token expiry
        if account.token_expiry and account.token_expiry < datetime.now(timezone.utc):
            logger.warning(
                f"Broker token expired for user={str(user_id)[:8]} broker={broker}"
            )
            # Try refresh if we have a refresh token
            refreshed = await self._try_refresh(db, account)
            if not refreshed:
                account.is_active = False
                await db.flush()
                return None

        try:
            session_token = decrypt_token(account.access_token_enc)
            extra = (
                decrypt_json(account.extra_data_enc) if account.extra_data_enc else {}
            )
        except Exception as e:
            logger.error(f"Token decryption failed for user={str(user_id)[:8]}: {e}")
            account.is_active = False
            await db.flush()
            return None

        # Update last used
        account.last_used_at = datetime.now(timezone.utc)
        await db.flush()

        return {
            "user_id": extra.get("uid", account.broker_user_id),
            "session_token": session_token,
            "broker_user_id": account.broker_user_id,
            "extra": extra,
        }

    # ────────────────────────────────────────────────────────────────
    # 4. Get Any Active Session (for system-level WebSocket)
    # ────────────────────────────────────────────────────────────────

    async def get_any_active_session(
        self, db: AsyncSession, broker: str = "zebu"
    ) -> Optional[dict]:
        """
        Retrieve ANY active broker session — used for the global
        market-data WebSocket connection.

        The system only needs ONE valid session to stream prices.
        All users share the same price feed.

        Returns same shape as get_active_session() or None.
        """
        result = await db.execute(
            select(BrokerAccount)
            .where(
                and_(
                    BrokerAccount.broker == broker,
                    BrokerAccount.is_active == True,  # noqa: E712
                )
            )
            .order_by(BrokerAccount.last_used_at.desc())
            .limit(1)
        )
        account = result.scalar_one_or_none()
        if not account:
            return None

        return await self.get_active_session(db, account.user_id, broker)

    # ────────────────────────────────────────────────────────────────
    # 5. Disconnect
    # ────────────────────────────────────────────────────────────────

    async def disconnect(
        self, db: AsyncSession, user_id: str, broker: str = "zebu"
    ) -> bool:
        """
        Disconnect a broker account: wipe tokens and deactivate.

        Returns True if an account was found and disconnected.
        """
        result = await db.execute(
            select(BrokerAccount).where(
                and_(
                    BrokerAccount.user_id == user_id,
                    BrokerAccount.broker == broker,
                )
            )
        )
        account = result.scalar_one_or_none()
        if not account:
            return False

        account.access_token_enc = None
        account.refresh_token_enc = None
        account.extra_data_enc = None
        account.is_active = False
        await db.flush()

        logger.info(f"Broker disconnected: user={str(user_id)[:8]} broker={broker}")
        return True

    # ────────────────────────────────────────────────────────────────
    # 6. Get Connection Status
    # ────────────────────────────────────────────────────────────────

    async def get_status(
        self, db: AsyncSession, user_id: str, broker: str = "zebu"
    ) -> dict:
        """Return the connection status for a user's broker account."""
        result = await db.execute(
            select(BrokerAccount).where(
                and_(
                    BrokerAccount.user_id == user_id,
                    BrokerAccount.broker == broker,
                )
            )
        )
        account = result.scalar_one_or_none()
        if not account:
            return {"connected": False, "broker": broker}

        is_expired = (
            account.token_expiry is not None
            and account.token_expiry < datetime.now(timezone.utc)
        )

        return {
            "connected": account.is_active and not is_expired,
            "broker": broker,
            "broker_user_id": account.broker_user_id,
            "connected_at": (
                account.connected_at.isoformat() if account.connected_at else None
            ),
            "token_expiry": (
                account.token_expiry.isoformat() if account.token_expiry else None
            ),
            "is_expired": is_expired,
            "last_used_at": (
                account.last_used_at.isoformat() if account.last_used_at else None
            ),
        }

    # ════════════════════════════════════════════════════════════════
    # PRIVATE — Zebu-specific methods
    # ════════════════════════════════════════════════════════════════

    async def _zebu_token_exchange(self, auth_code: str, uid: str = "") -> dict:
        """
        Exchange a Zebu auth code for an access token.

        Calls Zebu's NorenAPI QuickAuth endpoint.
        The `uid` is the Zebu user ID (per-user, NOT a global setting).
        If uid is empty, uses auth_code as both uid and pwd (some flows).
        """
        try:
            import hashlib

            # uid comes from the redirect params or the auth_code itself
            zebu_uid = uid or auth_code

            # Build appkey: SHA-256 of "uid|api_secret"
            # Use ZEBU_API_SECRET (correct field); fall back to ZEBU_API_KEY (legacy)
            _api_secret = settings.ZEBU_API_SECRET or settings.ZEBU_API_KEY
            appkey_raw = f"{zebu_uid}|{_api_secret}"
            appkey = hashlib.sha256(appkey_raw.encode()).hexdigest()

            payload = {
                "apkversion": "1.0.0",
                "uid": zebu_uid,
                "pwd": auth_code,  # In OAuth flow this is the received code
                "factor2": "",
                "vc": settings.ZEBU_VENDOR_CODE or zebu_uid,
                "appkey": appkey,
                "imei": "alphasync",
                "source": "API",
            }

            # Zebu expects jData= form-encoded, NOT JSON body
            jdata = "jData=" + json.dumps(payload)
            headers = {"Content-Type": "application/x-www-form-urlencoded"}

            _FALLBACK_HOSTS = [
                settings.ZEBU_API_URL,
                "https://go.mynt.in/NorenWClientTP",
                "https://api.zebull.in/NorenWClientTP",
            ]
            seen: set[str] = set()
            hosts = []
            for h in _FALLBACK_HOSTS:
                h = h.rstrip("/")
                if h not in seen:
                    seen.add(h)
                    hosts.append(h)

            data = None
            last_error = None
            async with httpx.AsyncClient(timeout=20.0) as client:
                for host in hosts:
                    url = f"{host}/QuickAuth"
                    try:
                        logger.info(f"Zebu QuickAuth (OAuth) → {url} uid={zebu_uid}")
                        resp = await client.post(url, data=jdata, headers=headers)
                        if resp.status_code != 200:
                            last_error = f"HTTP {resp.status_code} from {host}"
                            logger.warning(f"Zebu QuickAuth {last_error}")
                            continue
                        if not resp.text or not resp.text.strip():
                            raise ValueError(
                                "Server returned empty response. "
                                "Check Vendor Code and App Key in MYNT portal."
                            )
                        data = resp.json()
                        break
                    except httpx.TimeoutException:
                        last_error = f"Timeout connecting to {host}"
                        logger.warning(f"Zebu QuickAuth timeout: {host}")
                        continue
                    except httpx.ConnectError as e:
                        last_error = f"Cannot reach {host}: {e}"
                        logger.warning(f"Zebu QuickAuth connect error: {host} — {e}")
                        continue

            if data is None:
                return {"emsg": last_error or "All Zebu API endpoints unreachable"}

            if data.get("stat") == "Ok" or data.get("susertoken"):
                logger.info("Zebu token exchange successful")
                return data
            else:
                logger.error(f"Zebu token exchange failed: {data}")
                return data

        except Exception as e:
            logger.error(f"Zebu token exchange error: {e}", exc_info=True)
            return {"emsg": str(e)}

    async def _try_refresh(self, db: AsyncSession, account: BrokerAccount) -> bool:
        """
        Attempt to refresh an expired token.

        Zebu's NorenOMS does not provide a standard refresh flow;
        tokens are valid for one trading session (~8 hours).
        Users must re-authenticate daily.

        This method is a placeholder for brokers that DO support
        refresh tokens (e.g. Angel, Fyers).
        """
        if not account.refresh_token_enc:
            return False

        # Placeholder — implement per-broker refresh logic here
        logger.info(
            f"Token refresh not supported for broker={account.broker}, "
            f"user must re-authenticate"
        )
        return False

    # ────────────────────────────────────────────────────────────────
    # 7. Direct Login (QuickAuth — no vendor SSO redirect needed)
    # ────────────────────────────────────────────────────────────────

    async def direct_login(
        self,
        db: AsyncSession,
        user_id: str,
        zebu_uid: str,
        password: str,
        totp: str = "",
        api_key: str = "",
        vendor_code: str = "",
    ) -> dict:
        """
        Authenticate directly via Zebu's QuickAuth API.

        This is the standard login method when vendor SSO redirect
        is unavailable. The user provides their Zebu credentials
        (User ID, Password, TOTP) and we exchange them for a session token.

        Returns: { "success": True, "broker_user_id": str }
        Raises: ValueError on authentication failure.
        """
        import hashlib

        # Build appkey: SHA-256 of "uid|api_secret"
        # api_secret priority: user-provided api_key > server ZEBU_API_SECRET > ZEBU_API_KEY
        _api_secret = api_key or settings.ZEBU_API_SECRET or settings.ZEBU_API_KEY
        if not _api_secret:
            raise ValueError(
                "API Key is required. Get it from MYNT portal → "
                "Client Code → API Key."
            )
        appkey_raw = f"{zebu_uid}|{_api_secret}"
        appkey = hashlib.sha256(appkey_raw.encode()).hexdigest()

        # Hash the password: SHA-256
        pwd_hash = hashlib.sha256(password.encode()).hexdigest()

        payload = {
            "apkversion": "1.0.0",
            "uid": zebu_uid,
            "pwd": pwd_hash,
            "factor2": totp,
            "vc": vendor_code or settings.ZEBU_VENDOR_CODE or zebu_uid,
            "appkey": appkey,
            "imei": "alphasync",
            "source": "API",
        }

        # Zebu rebranded to MYNT — try configured host, then fallback
        _FALLBACK_HOSTS = [
            settings.ZEBU_API_URL,  # configured (go.mynt.in/NorenWClientTP)
            "https://go.mynt.in/NorenWClientTP",
            "https://api.zebull.in/NorenWClientTP",
        ]
        # Deduplicate while preserving order
        seen = set()
        hosts = []
        for h in _FALLBACK_HOSTS:
            h = h.rstrip("/")
            if h not in seen:
                seen.add(h)
                hosts.append(h)

        jdata = "jData=" + json.dumps(payload)
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        data = None
        last_error = None

        async with httpx.AsyncClient(timeout=20.0) as client:
            for host in hosts:
                url = f"{host}/QuickAuth"
                try:
                    logger.info(f"Zebu QuickAuth → {url} uid={zebu_uid}")
                    resp = await client.post(url, data=jdata, headers=headers)

                    # Non-200 but not a connectivity issue — server responded
                    if resp.status_code != 200:
                        body_preview = resp.text[:300] if resp.text else "(empty)"
                        logger.error(
                            f"Zebu QuickAuth HTTP {resp.status_code} from {host}: "
                            f"{body_preview}"
                        )
                        last_error = f"Zebu API returned HTTP {resp.status_code}"
                        continue

                    # Empty body = silent rejection (bad vendor code / app key)
                    if not resp.text or not resp.text.strip():
                        logger.error(
                            f"Zebu QuickAuth: EMPTY response from {host}. "
                            "Check ZEBU_VENDOR_CODE and ZEBU_API_SECRET."
                        )
                        raise ValueError(
                            "Server returned empty response. "
                            "Check Vendor Code and App Key in MYNT portal."
                        )

                    data = resp.json()
                    break  # success — got a JSON response

                except httpx.TimeoutException:
                    logger.warning(f"Zebu QuickAuth timeout: {host}")
                    last_error = f"Timeout connecting to {host}"
                    continue
                except httpx.ConnectError as e:
                    logger.warning(f"Zebu QuickAuth connect error: {host} — {e}")
                    last_error = f"Cannot reach {host}"
                    continue

        if data is None:
            raise ValueError(last_error or "All Zebu/MYNT API endpoints unreachable")

        if data.get("stat") != "Ok" and not data.get("susertoken"):
            error_msg = data.get("emsg", "Authentication failed")
            logger.error(f"Zebu QuickAuth failed: {error_msg}")
            raise ValueError(f"Zebu login failed: {error_msg}")

        # ── Success — store token ───────────────────────────────────
        session_token = data["susertoken"]
        broker_user_id = data.get("actid", data.get("uid", zebu_uid))

        access_token_enc = encrypt_token(session_token)
        extra = {
            "uid": data.get("uid", zebu_uid),
            "actid": data.get("actid", zebu_uid),
            "brkname": data.get("brkname", "ZEBU"),
            "email": data.get("email", ""),
        }

        # Upsert broker account
        result = await db.execute(
            select(BrokerAccount).where(
                and_(
                    BrokerAccount.user_id == user_id,
                    BrokerAccount.broker == "zebu",
                )
            )
        )
        account = result.scalar_one_or_none()

        if account:
            account.access_token_enc = access_token_enc
            account.broker_user_id = broker_user_id
            account.extra_data_enc = encrypt_json(extra)
            account.is_active = True
            account.token_expiry = datetime.now(timezone.utc) + timedelta(hours=8)
            account.last_used_at = datetime.now(timezone.utc)
        else:
            account = BrokerAccount(
                user_id=user_id,
                broker="zebu",
                broker_user_id=broker_user_id,
                access_token_enc=access_token_enc,
                extra_data_enc=encrypt_json(extra),
                is_active=True,
                token_expiry=datetime.now(timezone.utc) + timedelta(hours=8),
                connected_at=datetime.now(timezone.utc),
                last_used_at=datetime.now(timezone.utc),
            )
            db.add(account)

        await db.flush()

        logger.info(
            f"Zebu direct login successful: user={str(user_id)[:8]} "
            f"broker_user={broker_user_id}"
        )

        return {
            "success": True,
            "broker": "zebu",
            "broker_user_id": broker_user_id,
        }


# ── Module-level singleton ──────────────────────────────────────────
broker_auth_service = BrokerAuthService()
