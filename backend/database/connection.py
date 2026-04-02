import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import UUID as PG_UUID, JSONB as PG_JSONB
from sqlalchemy.exc import OperationalError
from config.settings import settings


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_for_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(PG_JSONB, "sqlite")
def _compile_pg_jsonb_for_sqlite(_type, _compiler, **_kw):
    return "JSON"


engine_kwargs = {
    "echo": settings.DEBUG,
    "future": True,
}

if not settings.DATABASE_URL.startswith("sqlite"):
    engine_kwargs.update(
        {
            "pool_size": settings.DB_POOL_SIZE,
            "max_overflow": settings.DB_MAX_OVERFLOW,
            "pool_recycle": settings.DB_POOL_RECYCLE,
            "pool_pre_ping": settings.DB_POOL_PRE_PING,
        }
    )

engine = create_async_engine(settings.DATABASE_URL, **engine_kwargs)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# Alias for background workers that need direct session access
# (not via FastAPI's Depends(get_db) dependency injection)
async_session_factory = async_session


class Base(DeclarativeBase):
    pass


async def _commit_with_retry(session: AsyncSession, retries: int = 3):
    """Retry transient SQLite lock errors for write-heavy demo workloads."""
    for attempt in range(retries):
        try:
            await session.commit()
            return
        except OperationalError as e:
            message = str(e).lower()
            locked = (
                "database is locked" in message or "database table is locked" in message
            )
            if locked and attempt < retries - 1:
                await asyncio.sleep(0.05 * (attempt + 1))
                continue
            raise


async def get_db():
    async with async_session() as session:
        try:
            yield session
            # Only auto-commit if the route didn't already commit/rollback
            if session.is_active:
                await _commit_with_retry(session)
        except Exception:
            if session.is_active:
                await session.rollback()
            raise


async def init_db():
    async with engine.begin() as conn:
        is_postgres = conn.dialect.name == "postgresql"
        is_sqlite = conn.dialect.name == "sqlite"

        if is_postgres:
            # Ensure uuid-ossp extension is available for gen_random_uuid()
            # Wrapped in DO block to handle race condition when multiple workers start simultaneously
            await conn.execute(
                text(
                    """
                DO $$ BEGIN
                    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
                EXCEPTION WHEN duplicate_object THEN NULL;
                END $$;
            """
                )
            )
        from models import user, order, portfolio, watchlist, algo  # noqa
        from models import broker as broker_model  # noqa
        from strategies.zeroloss import models as zeroloss_models  # noqa

        # Ensure admin panel models (TwoFactorAuth, AdminSession, etc.) are loaded
        from models.user import (
            TwoFactorAuth,
            AdminSession,
            AdminAuditLog,
            EmailNotificationLog,
        )  # noqa

        await conn.run_sync(Base.metadata.create_all)

        # ── Lightweight, idempotent schema patch for SQLite (demo DB) ─────────
        if is_sqlite:

            async def _sqlite_columns(table_name: str) -> list[str]:
                res = await conn.execute(text(f"PRAGMA table_info({table_name});"))
                return [row[1] for row in res.fetchall()]

            # Ensure orders table has columns added after initial create
            async def _ensure_sqlite_column(column_name: str, ddl: str):
                cols = await _sqlite_columns("orders")
                if column_name not in cols:
                    await conn.execute(text(f"ALTER TABLE orders ADD COLUMN {ddl};"))

            await _ensure_sqlite_column(
                "product_type", "product_type VARCHAR(10) NOT NULL DEFAULT 'CNC'"
            )
            await _ensure_sqlite_column("tag", "tag VARCHAR(30)")

            # Admin panel columns on users table
            async def _ensure_users_column(column_name: str, ddl: str):
                res = await conn.execute(text("PRAGMA table_info(users);"))
                cols = [row[1] for row in res.fetchall()]
                if column_name not in cols:
                    await conn.execute(text(f"ALTER TABLE users ADD COLUMN {ddl};"))

            await _ensure_users_column(
                "account_status", "account_status VARCHAR(30) NOT NULL DEFAULT 'active'"
            )
            await _ensure_users_column(
                "access_expires_at", "access_expires_at DATETIME"
            )
            await _ensure_users_column(
                "access_duration_days", "access_duration_days INTEGER"
            )
            await _ensure_users_column("approved_at", "approved_at DATETIME")
            await _ensure_users_column("approved_by", "approved_by CHAR(36)")
            await _ensure_users_column(
                "deactivation_reason", "deactivation_reason VARCHAR(500)"
            )
            # Admin hierarchy columns
            await _ensure_users_column("admin_level", "admin_level VARCHAR(20)")
            await _ensure_users_column(
                "admin_assigned_by", "admin_assigned_by CHAR(36)"
            )
            await _ensure_users_column(
                "admin_assigned_at", "admin_assigned_at DATETIME"
            )

            # ZeroLoss strategy columns for per-user isolation
            async def _ensure_zeroloss_signal_column(column_name: str, ddl: str):
                cols = await _sqlite_columns("zeroloss_signals")
                if column_name not in cols:
                    await conn.execute(
                        text(f"ALTER TABLE zeroloss_signals ADD COLUMN {ddl};")
                    )

            async def _ensure_zeroloss_perf_column(column_name: str, ddl: str):
                cols = await _sqlite_columns("zeroloss_performance")
                if column_name not in cols:
                    await conn.execute(
                        text(f"ALTER TABLE zeroloss_performance ADD COLUMN {ddl};")
                    )

            await _ensure_zeroloss_signal_column("user_id", "user_id CHAR(36)")
            await _ensure_zeroloss_signal_column(
                "pnl", "pnl NUMERIC(16,2) NOT NULL DEFAULT 0"
            )
            await _ensure_zeroloss_perf_column("user_id", "user_id CHAR(36)")

            await conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_zeroloss_signals_user_ts "
                    "ON zeroloss_signals (user_id, timestamp DESC);"
                )
            )
            await conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_zeroloss_perf_user_date "
                    "ON zeroloss_performance (user_id, date DESC);"
                )
            )

        if is_postgres:
            # ── Add missing columns for Firebase auth migration ─────────────
            # create_all doesn't ALTER existing tables — add columns manually
            # if they're missing (idempotent).
            await conn.execute(
                text(
                    """
                DO $$ BEGIN
                    -- Add firebase_uid column if missing
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'firebase_uid'
                    ) THEN
                        ALTER TABLE users ADD COLUMN firebase_uid VARCHAR(128) UNIQUE;
                        CREATE INDEX IF NOT EXISTS ix_users_firebase_uid ON users (firebase_uid);
                    END IF;

                    -- Add auth_provider column if missing
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'auth_provider'
                    ) THEN
                        ALTER TABLE users ADD COLUMN auth_provider VARCHAR(30) NOT NULL DEFAULT 'firebase';
                    END IF;

                    -- Make password_hash nullable (Firebase users have no password)
                    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
                EXCEPTION WHEN others THEN
                    RAISE NOTICE 'Migration note: %', SQLERRM;
                END $$;
            """
                )
            )

            # ── Add admin panel columns to users table ──────────────────
            await conn.execute(
                text(
                    """
                DO $$ BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'account_status'
                    ) THEN
                        ALTER TABLE users ADD COLUMN account_status VARCHAR(30) NOT NULL DEFAULT 'active';
                        CREATE INDEX IF NOT EXISTS ix_users_account_status ON users (account_status);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'access_expires_at'
                    ) THEN
                        ALTER TABLE users ADD COLUMN access_expires_at TIMESTAMPTZ;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'access_duration_days'
                    ) THEN
                        ALTER TABLE users ADD COLUMN access_duration_days INTEGER;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'approved_at'
                    ) THEN
                        ALTER TABLE users ADD COLUMN approved_at TIMESTAMPTZ;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'approved_by'
                    ) THEN
                        ALTER TABLE users ADD COLUMN approved_by UUID REFERENCES users(id);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'deactivation_reason'
                    ) THEN
                        ALTER TABLE users ADD COLUMN deactivation_reason VARCHAR(500);
                    END IF;

                    -- Admin hierarchy columns
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'admin_level'
                    ) THEN
                        ALTER TABLE users ADD COLUMN admin_level VARCHAR(20);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'admin_assigned_by'
                    ) THEN
                        ALTER TABLE users ADD COLUMN admin_assigned_by UUID REFERENCES users(id);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'admin_assigned_at'
                    ) THEN
                        ALTER TABLE users ADD COLUMN admin_assigned_at TIMESTAMPTZ;
                    END IF;
                EXCEPTION WHEN others THEN
                    RAISE NOTICE 'Admin migration note: %', SQLERRM;
                END $$;
            """
                )
            )

            # ── ZeroLoss per-user columns (signals/performance) ──────────────
            await conn.execute(
                text(
                    """
                DO $$ BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'zeroloss_signals' AND column_name = 'user_id'
                    ) THEN
                        ALTER TABLE zeroloss_signals ADD COLUMN user_id UUID;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'zeroloss_signals' AND column_name = 'pnl'
                    ) THEN
                        ALTER TABLE zeroloss_signals ADD COLUMN pnl NUMERIC(16,2) NOT NULL DEFAULT 0;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'zeroloss_performance' AND column_name = 'user_id'
                    ) THEN
                        ALTER TABLE zeroloss_performance ADD COLUMN user_id UUID;
                    END IF;

                    BEGIN
                        ALTER TABLE zeroloss_signals
                            ADD CONSTRAINT fk_zeroloss_signals_user
                            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
                    EXCEPTION WHEN duplicate_object THEN NULL;
                    END;

                    BEGIN
                        ALTER TABLE zeroloss_performance
                            ADD CONSTRAINT fk_zeroloss_performance_user
                            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
                    EXCEPTION WHEN duplicate_object THEN NULL;
                    END;

                    IF EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'zeroloss_performance_date_key'
                    ) THEN
                        ALTER TABLE zeroloss_performance
                            DROP CONSTRAINT zeroloss_performance_date_key;
                    END IF;

                    CREATE INDEX IF NOT EXISTS ix_zeroloss_signals_user_ts
                        ON zeroloss_signals (user_id, timestamp DESC);
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_zeroloss_perf_user_date
                        ON zeroloss_performance (user_id, date);
                EXCEPTION WHEN others THEN
                    RAISE NOTICE 'ZeroLoss migration note: %', SQLERRM;
                END $$;
            """
                )
            )

            # ── Add product_type column to orders table ───────────────────
            # CNC (Delivery), MIS (Intraday), NRML (F&O) — mirrors real
            # Indian broker product types.
            await conn.execute(
                text(
                    """
                DO $$ BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'orders' AND column_name = 'product_type'
                    ) THEN
                        ALTER TABLE orders ADD COLUMN product_type VARCHAR(10) NOT NULL DEFAULT 'CNC';
                    END IF;
                EXCEPTION WHEN others THEN
                    RAISE NOTICE 'Migration note: %', SQLERRM;
                END $$;
            """
                )
            )
