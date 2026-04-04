"""
OTP Service — Mobile number verification via SMS OTP.

Flow:
  1. POST /api/auth/send-phone-otp  → generate 6-digit OTP, store in Redis,
                                       dispatch SMS via Fast2SMS (or log in dev).
  2. POST /api/auth/set-phone       → verify OTP from Redis, save phone on match.

Redis key schema:
  alphasync:phone_otp:{firebase_uid}   → JSON {phone, otp, attempts, created_at}  TTL 600s
  alphasync:otp_rl:{phone}             → integer request count                     TTL 3600s

OTP rules:
  - 6 random digits
  - Valid for 10 minutes
  - Max 3 incorrect guesses before invalidation (must re-send)
  - Max 5 send requests per phone per hour (rate-limit)
  - 60-second cooldown between re-sends (enforced by created_at check)

SMS provider:
  - Reads FAST2SMS_API_KEY from settings.
  - Falls back to console-logging the OTP in DEBUG / when key not set.
    This lets development work without an SMS account while making it
    trivial to enable real SMS by adding the key to the environment.
"""

import json
import logging
import random
import time
from typing import Tuple

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────
OTP_TTL_SECONDS = 600          # 10 minutes
RATE_LIMIT_TTL = 3600          # 1 hour window for rate-limiting
MAX_SENDS_PER_HOUR = 5         # max OTP requests per phone per hour
MIN_RESEND_SECONDS = 60        # cooldown between sends
MAX_ATTEMPTS = 3               # wrong guesses before OTP is invalidated

_KEY_OTP = "alphasync:phone_otp"     # :{firebase_uid}
_KEY_RL  = "alphasync:otp_rl"        # :{phone_digits}


# ── Redis helpers ────────────────────────────────────────────────────────────

async def _redis() -> aioredis.Redis:
    """Open a short-lived Redis connection for OTP operations."""
    from config.settings import settings
    return aioredis.from_url(
        settings.REDIS_URL,
        decode_responses=True,
        socket_timeout=5.0,
        socket_connect_timeout=5.0,
    )


async def _redis_get(client: aioredis.Redis, key: str):
    try:
        return await client.get(key)
    except Exception as exc:
        logger.warning("Redis GET %s failed: %s", key, exc)
        return None


async def _redis_set(client: aioredis.Redis, key: str, value: str, ex: int):
    try:
        await client.set(key, value, ex=ex)
    except Exception as exc:
        logger.warning("Redis SET %s failed: %s", key, exc)


async def _redis_incr_ex(client: aioredis.Redis, key: str, ex: int) -> int:
    """INCR key and set TTL only if it's a new key (so existing TTL is preserved)."""
    try:
        count = await client.incr(key)
        if count == 1:
            await client.expire(key, ex)
        return count
    except Exception as exc:
        logger.warning("Redis INCR %s failed: %s", key, exc)
        return 1


async def _redis_delete(client: aioredis.Redis, key: str):
    try:
        await client.delete(key)
    except Exception as exc:
        logger.warning("Redis DEL %s failed: %s", key, exc)


# ── OTP generation & storage ─────────────────────────────────────────────────

async def generate_and_store_otp(firebase_uid: str, phone_e164: str) -> Tuple[bool, str, str]:
    """
    Generate a 6-digit OTP and persist it in Redis.

    Returns (success, otp_or_empty, error_message).
    Enforces rate-limiting and cooldown.
    phone_e164: already-normalised +91XXXXXXXXXX string.
    """
    phone_digits = phone_e164.replace("+91", "")  # 10-digit for rate-limit key

    client = await _redis()
    try:
        # ── Rate-limit: max sends per hour ───────────────────────────
        rl_key = f"{_KEY_RL}:{phone_digits}"
        count = await _redis_incr_ex(client, rl_key, RATE_LIMIT_TTL)
        if count > MAX_SENDS_PER_HOUR:
            return False, "", (
                f"Too many OTP requests. You can request up to {MAX_SENDS_PER_HOUR} "
                "per hour. Please try again later."
            )

        # ── Cooldown: 60s between re-sends ───────────────────────────
        otp_key = f"{_KEY_OTP}:{firebase_uid}"
        existing_raw = await _redis_get(client, otp_key)
        if existing_raw:
            existing = json.loads(existing_raw)
            elapsed = time.time() - existing.get("created_at", 0)
            if elapsed < MIN_RESEND_SECONDS:
                wait = int(MIN_RESEND_SECONDS - elapsed) + 1
                return False, "", f"Please wait {wait}s before requesting a new OTP."

        # ── Generate & store ─────────────────────────────────────────
        otp = str(random.randint(100000, 999999))
        payload = json.dumps({
            "phone":      phone_e164,
            "otp":        otp,
            "attempts":   0,
            "created_at": time.time(),
        })
        await _redis_set(client, otp_key, payload, ex=OTP_TTL_SECONDS)

        return True, otp, ""

    finally:
        await client.aclose()


async def verify_otp(firebase_uid: str, phone_e164: str, otp_input: str) -> Tuple[bool, str]:
    """
    Verify the OTP submitted by the user.

    Returns (success, error_message).
    Increments attempt counter; deletes the OTP on success or after max failures.
    """
    client = await _redis()
    try:
        otp_key = f"{_KEY_OTP}:{firebase_uid}"
        raw = await _redis_get(client, otp_key)

        if not raw:
            return False, "OTP has expired or was not requested. Please request a new one."

        data = json.loads(raw)

        if data.get("phone") != phone_e164:
            return False, "Phone number mismatch. Please start over."

        if data.get("attempts", 0) >= MAX_ATTEMPTS:
            await _redis_delete(client, otp_key)
            return False, "Too many incorrect attempts. Please request a new OTP."

        if data.get("otp") != otp_input.strip():
            data["attempts"] = data.get("attempts", 0) + 1
            await _redis_set(client, otp_key, json.dumps(data), ex=OTP_TTL_SECONDS)
            remaining = MAX_ATTEMPTS - data["attempts"]
            if remaining <= 0:
                await _redis_delete(client, otp_key)
                return False, "Too many incorrect attempts. Please request a new OTP."
            return False, f"Incorrect OTP. {remaining} attempt{'s' if remaining > 1 else ''} remaining."

        # ── OTP correct — clean up ────────────────────────────────────
        await _redis_delete(client, otp_key)
        return True, ""

    finally:
        await client.aclose()


# ── SMS dispatch ─────────────────────────────────────────────────────────────

async def send_otp_sms(phone_digits_10: str, otp: str) -> bool:
    """
    Send OTP via Fast2SMS.

    If FAST2SMS_API_KEY is not configured the OTP is only logged —
    this allows the app to function in development without an SMS account.
    Set the key in settings / environment to enable real SMS delivery.
    """
    from config.settings import settings

    message = (
        f"Your AlphaSync OTP is {otp}. "
        "Valid for 10 minutes. Do not share this code with anyone."
    )

    if not getattr(settings, "FAST2SMS_API_KEY", ""):
        logger.warning(
            "[DEV MODE] SMS not configured — OTP for +91%s is: %s",
            phone_digits_10,
            otp,
        )
        return True   # Allow flow to continue in development

    try:
        import aiohttp

        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://www.fast2sms.com/dev/bulkV2",
                headers={"authorization": settings.FAST2SMS_API_KEY},
                json={
                    "route":    "q",
                    "message":  message,
                    "language": "english",
                    "flash":    0,
                    "numbers":  phone_digits_10,
                },
                timeout=aiohttp.ClientTimeout(total=12),
            ) as resp:
                body = await resp.json(content_type=None)
                if resp.status == 200 and body.get("return"):
                    logger.info("OTP SMS sent to +91%s", phone_digits_10)
                    return True
                logger.error("Fast2SMS API error (status=%s): %s", resp.status, body)
                return False

    except Exception as exc:
        logger.error("SMS dispatch failed for +91%s: %s", phone_digits_10, exc, exc_info=True)
        return False
