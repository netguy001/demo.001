from pydantic_settings import BaseSettings
from typing import Optional
import os


class Settings(BaseSettings):
    APP_NAME: str = "AlphaSync"
    APP_VERSION: str = "2.0.0"
    DEBUG: bool = False

    # Database (PostgreSQL — required for production)
    DATABASE_URL: str = (
        "postgresql+asyncpg://alphasync:alphasync@localhost:5432/alphasync"
    )
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 10
    DB_POOL_RECYCLE: int = 3600
    DB_POOL_PRE_PING: bool = True

    # Firebase Authentication
    FIREBASE_CREDENTIALS_JSON: str = ""  # JSON string of service account key
    FIREBASE_CREDENTIALS_PATH: str = ""  # Path to service account JSON file

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Virtual Capital
    DEFAULT_VIRTUAL_CAPITAL: float = 1000000.0  # 10 Lakh INR

    # Market Data
    MARKET_DATA_CACHE_SECONDS: int = 15
    PRICE_STREAM_INTERVAL: float = 3.0
    STRICT_ZEBU_MARKET_DATA: bool = False

    # Redis (shared live price cache across all user sessions)
    REDIS_URL: str = "redis://localhost:6379/0"

    # Zebu / MYNT Market Data Feed (per-user sessions via BrokerSessionManager)
    # Zebu rebranded to MYNT; go.mynt.in is the current production host.
    ZEBU_WS_URL: str = "wss://go.mynt.in/NorenWSTP/"
    ZEBU_API_KEY: str = ""  # legacy — use ZEBU_API_SECRET instead
    ZEBU_API_SECRET: str = ""  # "App Key" from MYNT portal → Client Code → API Key

    # Zebu Broker OAuth / API Integration
    ZEBU_API_URL: str = "https://go.mynt.in/NorenWClientTP"
    ZEBU_AUTH_URL: str = "https://go.mynt.in"  # Vendor SSO redirect (MYNT portal)
    ZEBU_VENDOR_CODE: str = ""
    ZEBU_REDIRECT_URI: str = "http://localhost:5173/broker/callback"

    # ── Master Zebu Account (shared market data for all users) ──────
    # One Zebu account logs in at startup, streams NSE data to Redis.
    # Users get live prices without entering their own broker credentials.
    ZEBU_MASTER_USER_ID: str = ""  # e.g. "FA12345"
    ZEBU_MASTER_PASSWORD: str = ""  # Zebu login password
    ZEBU_MASTER_DOB: str = ""  # DD-MM-YYYY or 6-digit TOTP
    # ZEBU_API_SECRET reused for master account too
    # ZEBU_VENDOR_CODE reused for master account too

    # Broker Token Encryption (AES-256-GCM)
    # Generate with: python -c "import secrets; print(secrets.token_urlsafe(48))"
    BROKER_ENCRYPTION_KEY: str = (
        "alphasync-default-broker-key-change-in-production-1234"
    )

    # ── New Architecture Settings ───────────────────────────────────

    # Worker intervals (seconds)
    WORKER_MARKET_DATA_INTERVAL: float = 3.0
    WORKER_ORDER_EXECUTION_INTERVAL: float = 5.0
    WORKER_ALGO_STRATEGY_INTERVAL: float = 30.0

    # Risk Engine defaults
    RISK_MAX_POSITION_SIZE: int = 500
    RISK_MAX_CAPITAL_PER_TRADE: float = 200000.0
    RISK_MAX_PORTFOLIO_EXPOSURE: float = 0.80
    RISK_MAX_DAILY_LOSS: float = 50000.0
    RISK_MAX_OPEN_ORDERS: int = 20

    # Market Session — always False; platform uses real live market data
    SIMULATION_MODE: bool = False

    # ── Admin Panel ──────────────────────────────────────────────────
    ADMIN_SESSION_EXPIRY_MINUTES: int = 30
    TOTP_ISSUER_NAME: str = "AlphaSync Admin"
    # Temporary bootstrap admin allowlist. Override in env for production.
    ADMIN_EMAIL_ALLOWLIST: list[str] = ["meganath1025@gmail.com"]
    # Root admin email — has unrestricted access and can create/manage other admins.
    ROOT_ADMIN_EMAIL: str = "meganath1025@gmail.com"

    # ── SMS (OTP delivery for phone verification via Twilio) ─────────
    # Twilio sends from an international number — no Indian DLT registration needed.
    # Sign up at https://www.twilio.com/try-twilio (free trial credit included).
    # Leave blank to fall back to email OTP delivery.
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_PHONE_NUMBER: str = ""  # e.g. +12025551234 — your Twilio number

    # SMTP for email notifications (Gmail)
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = "meganath1025@gmail.com"
    SMTP_PASSWORD: str = "qcneuqilbxhnppau"
    SMTP_FROM_EMAIL: str = "meganath1025@gmail.com"
    SMTP_FROM_NAME: str = "AlphaSync"
    SMTP_USE_TLS: bool = False

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
