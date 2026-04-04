import asyncio
import uuid
import logging
from contextlib import asynccontextmanager
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from config.settings import settings
from database.connection import init_db, async_session_factory
from websocket.manager import manager

# ── New Architecture Imports ────────────────────────────────────────
from core.event_bus import event_bus, EventType, Event
from engines.market_session import market_session
from workers.market_worker import market_data_worker
from workers.order_worker import order_execution_worker
from workers.futures_order_worker import futures_order_worker
from workers.algo_worker import algo_strategy_worker
from workers.portfolio_worker import portfolio_recalc_worker
from workers.squareoff_worker import auto_squareoff_worker
from core.rate_limiter import RateLimitMiddleware
from strategies.zeroloss.manager import zeroloss_manager
from workers.access_expiry_worker import access_expiry_worker

# ── Broker Session Manager (per-user providers) ────────────────────
from services.broker_session import broker_session_manager

# ── Master Zebu Session (shared market data for all users) ──────────
from services.master_session import master_session_service

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ─────────────────────────────────────────────────────
    logger.info("Starting AlphaSync...")

    # ── Initialize Firebase Admin SDK ───────────────────────────────
    from config.firebase import init_firebase

    try:
        init_firebase()
        logger.info("Firebase Admin SDK initialized")
    except Exception as e:
        logger.error(f"Firebase init failed: {e} — auth will not work!")

    await init_db()

    # ── Initialize Redis (for price cache, shared across sessions) ──
    try:
        from cache.redis_client import get_redis

        await get_redis(settings.REDIS_URL)
        logger.info("Redis connected")
    except Exception as e:
        logger.warning(f"Redis initialization failed: {e}")

    # ── Load Zebu master contracts (all NSE equities via live Zebu CDN) ──────
    try:
        from services.contract_loader import fetch_zebu_contracts
        from providers.symbol_mapper import load_zebu_contracts

        contracts = await fetch_zebu_contracts("NSE")
        if contracts:
            count = load_zebu_contracts(contracts)
            logger.info(f"Zebu NSE master contracts loaded: {count} equity symbols")
        else:
            logger.warning(
                "Zebu master contracts CDN unavailable — "
                "symbols will be resolved on-demand via SearchScrip API"
            )
    except Exception as e:
        logger.warning(
            f"Zebu contract load failed — on-demand SearchScrip will handle resolution: {e}"
        )

    # ── Load Zebu futures contracts (NSE equities and indices) ──────────────
    try:
        from services.futures_service import initialize_futures

        await initialize_futures()
        logger.info("Zebu NSE futures contracts loaded")
    except Exception as e:
        logger.warning(f"Futures contracts load failed: {e}")

    # ── Restore broker sessions from DB ─────────────────────────────
    # No global provider. Sessions are per-user, created after OAuth.
    # At startup, restore any previously active sessions.
    restored = await broker_session_manager.restore_sessions()
    logger.info(
        f"Broker sessions: {restored} restored | "
        f"No global provider — market data flows after broker auth"
    )

    # ── Initialize master Zebu session (shared market data feed) ────────
    master_ok = await master_session_service.initialize()
    if master_ok:
        logger.info("Master market data session: ACTIVE (live NSE data for all users)")
    else:
        logger.warning(
            "Master market data session: INACTIVE "
            "(set ZEBU_MASTER_USER_ID/PASSWORD/DOB in .env for live data without broker connect)"
        )

    # Start the Event Bus dispatcher (must be first)
    background_tasks = [
        asyncio.create_task(event_bus.run()),
    ]

    # Wire event-driven workers (subscribe BEFORE starting emitters)
    event_bus.subscribe(EventType.ORDER_FILLED, portfolio_recalc_worker.on_order_filled)

    # Wire WebSocket manager as event listener for real-time updates
    event_bus.subscribe(EventType.PRICE_UPDATED, manager.on_price_event)
    event_bus.subscribe(EventType.FUTURES_QUOTE, manager.on_futures_quote_event)
    event_bus.subscribe(EventType.ORDER_PLACED, manager.on_order_event)
    event_bus.subscribe(EventType.ORDER_FILLED, manager.on_order_event)
    event_bus.subscribe(EventType.ORDER_CANCELLED, manager.on_order_event)
    event_bus.subscribe(EventType.ORDER_EXPIRED, manager.on_order_event)
    event_bus.subscribe(EventType.FUTURES_ORDER_PLACED, manager.on_futures_order_event)
    event_bus.subscribe(EventType.FUTURES_ORDER_FILLED, manager.on_futures_order_event)
    event_bus.subscribe(EventType.FUTURES_ORDER_CANCELLED, manager.on_futures_order_event)
    event_bus.subscribe(EventType.FUTURES_ORDER_EXPIRED, manager.on_futures_order_event)
    event_bus.subscribe(EventType.PORTFOLIO_UPDATED, manager.on_portfolio_event)
    event_bus.subscribe(EventType.ALGO_TRADE, manager.on_algo_event)
    event_bus.subscribe(EventType.ALGO_SIGNAL, manager.on_algo_event)
    event_bus.subscribe(EventType.ALGO_ERROR, manager.on_algo_event)

    # Start background workers
    # ZeroLoss controllers are started lazily per user when they enable the strategy.
    logger.info("ZeroLoss manager ready — waiting for users to start via UI")
    background_tasks.extend(
        [
            asyncio.create_task(market_data_worker.run()),
            asyncio.create_task(order_execution_worker.run()),
            asyncio.create_task(futures_order_worker.run()),
            asyncio.create_task(algo_strategy_worker.run()),
            asyncio.create_task(auto_squareoff_worker.run()),
            asyncio.create_task(access_expiry_worker.run()),
        ]
    )

    # Start broker session health check (monitors token expiry)
    await broker_session_manager.start_health_check(interval=300.0)

    # Emit system startup event
    await event_bus.emit(
        Event(
            type=EventType.SYSTEM_STARTUP,
            data={
                "workers": [
                    "event_bus",
                    "market_data",
                    "order_execution",
                    "algo_strategy",
                    "zeroloss_manager",
                ],
                "architecture": "per-user-provider",
            },
            source="main",
        )
    )

    logger.info(
        f"AlphaSync started | Workers: 5 | "
        f"Market Session: {market_session.get_current_state().value} | "
        f"Simulation Mode: {market_session.simulation_mode} | "
        f"Architecture: per-user-provider"
    )
    yield

    # ── Shutdown ────────────────────────────────────────────────────
    logger.info("Shutting down AlphaSync...")
    await event_bus.emit(Event(type=EventType.SYSTEM_SHUTDOWN, source="main"))

    # Stop workers gracefully
    await market_data_worker.stop()
    await order_execution_worker.stop()
    await algo_strategy_worker.stop()
    await zeroloss_manager.stop_all()
    await auto_squareoff_worker.stop()
    await broker_session_manager.stop()
    await event_bus.stop()

    # Close Redis
    try:
        from cache.redis_client import close_redis

        await close_redis()
    except Exception:
        pass

    # Cancel all background tasks
    for task in background_tasks:
        task.cancel()

    logger.info("AlphaSync shut down")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Professional Indian Stock Market Simulation Trading Platform",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiting (added after CORS so rate limit responses also get CORS headers)
app.add_middleware(RateLimitMiddleware)

# Import and include routers
from routes.auth import router as auth_router
from routes.market import router as market_router
from routes.orders import router as orders_router
from routes.portfolio import router as portfolio_router
from routes.watchlist import router as watchlist_router
from routes.algo import router as algo_router
from routes.user import router as user_router
from routes.zeroloss import router as zeroloss_router
from routes.broker import router as broker_router
from routes.admin import router as admin_router
from routes.futures import router as futures_router
from routes.options import router as options_router

app.include_router(auth_router)
app.include_router(market_router)
app.include_router(orders_router)
app.include_router(portfolio_router)
app.include_router(watchlist_router)
app.include_router(algo_router)
app.include_router(user_router)
app.include_router(zeroloss_router)
app.include_router(broker_router)
app.include_router(admin_router)
app.include_router(futures_router)
app.include_router(options_router)

# ── Serve uploaded files (avatars etc.) ───────────────────────────────────────
os.makedirs("uploads/avatars", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")


@app.get("/")
async def root():
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "running",
    }


@app.get("/api/health")
async def health():
    """Enhanced health endpoint with worker, engine, and session status."""
    import config.firebase as fb_mod
    import os

    creds_path = os.environ.get("FIREBASE_CREDENTIALS_PATH", "")
    creds_json_set = bool(os.environ.get("FIREBASE_CREDENTIALS_JSON", ""))
    creds_file_exists = os.path.isfile(creds_path) if creds_path else False
    creds_file_size = os.path.getsize(creds_path) if creds_file_exists else 0
    creds_readable = os.access(creds_path, os.R_OK) if creds_file_exists else False

    # Try to diagnose Firebase init failure
    firebase_error = None
    if not fb_mod._initialized:
        try:
            fb_mod.init_firebase()
        except Exception as e:
            firebase_error = f"{type(e).__name__}: {e}"

    return {
        "status": "healthy",
        "firebase": {
            "initialized": fb_mod._initialized,
            "init_error": firebase_error,
            "credentials_path": creds_path,
            "credentials_file_exists": creds_file_exists,
            "credentials_file_readable": creds_readable,
            "credentials_file_size": creds_file_size,
            "credentials_json_env_set": creds_json_set,
            "process_uid": os.getuid() if hasattr(os, "getuid") else "N/A",
        },
        "market_session": market_session.get_session_info(),
        "event_bus": event_bus.get_stats(),
        "broker_sessions": broker_session_manager.get_status(),
        "master_session": {
            "active": master_session_service.is_active(),
            "user_id": settings.ZEBU_MASTER_USER_ID or "not_configured",
        },
        "workers": {
            "market_data": market_data_worker.get_stats(),
            "order_execution": order_execution_worker.get_stats(),
            "algo_strategy": algo_strategy_worker.get_stats(),
            "portfolio_recalc": portfolio_recalc_worker.get_stats(),
            "zeroloss": zeroloss_manager.get_stats(),
            "auto_squareoff": auto_squareoff_worker.get_stats(),
        },
        "caches": _get_cache_stats(),
    }


def _get_cache_stats() -> dict:
    try:
        from cache.smart_cache import get_all_cache_stats

        return get_all_cache_stats()
    except Exception:
        return {}


@app.get("/api/debug/db")
async def debug_db():
    """Temporary diagnostic endpoint — test DB connectivity and schema."""
    import traceback
    from database.connection import async_session
    from sqlalchemy import text as sa_text, inspect as sa_inspect

    results = {}

    try:
        async with async_session() as session:
            # Test basic connectivity
            row = await session.execute(sa_text("SELECT 1"))
            results["db_connected"] = True

            # Check if users table exists and its columns
            cols = await session.execute(
                sa_text(
                    "SELECT column_name, data_type FROM information_schema.columns "
                    "WHERE table_name = 'users' ORDER BY ordinal_position"
                )
            )
            columns = [{"name": r[0], "type": r[1]} for r in cols.fetchall()]
            results["users_table_columns"] = columns
            results["has_firebase_uid"] = any(
                c["name"] == "firebase_uid" for c in columns
            )
            results["has_auth_provider"] = any(
                c["name"] == "auth_provider" for c in columns
            )

            # Check portfolios table
            pcols = await session.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'portfolios' ORDER BY ordinal_position"
                )
            )
            results["portfolios_columns"] = [r[0] for r in pcols.fetchall()]

            # Check alembic version
            try:
                ver = await session.execute(
                    sa_text("SELECT version_num FROM alembic_version")
                )
                results["alembic_version"] = [r[0] for r in ver.fetchall()]
            except Exception:
                results["alembic_version"] = "alembic_version table not found"

            # Count users
            cnt = await session.execute(sa_text("SELECT count(*) FROM users"))
            results["user_count"] = cnt.scalar()

    except Exception as e:
        results["error"] = f"{type(e).__name__}: {e}"
        results["traceback"] = traceback.format_exc()

    return results


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str = None):
    connection_id = client_id or str(uuid.uuid4())

    # Extract user_id from Firebase ID token (query param)
    user_id = None
    token = websocket.query_params.get("token")
    if token:
        try:
            from services.auth_service import verify_id_token
            from sqlalchemy import select as sa_select
            from models.user import User as UserModel
            from database.connection import async_session_factory

            claims = verify_id_token(token)
            if claims:
                firebase_uid = claims.get("uid")
                if firebase_uid:
                    async with async_session_factory() as db:
                        result = await db.execute(
                            sa_select(UserModel).where(
                                UserModel.firebase_uid == firebase_uid
                            )
                        )
                        ws_user = result.scalar_one_or_none()
                        if ws_user:
                            user_id = str(ws_user.id)
        except Exception as e:
            logger.warning(
                f"WebSocket token verification failed for {connection_id}: {e}"
            )

    try:
        await manager.connect(websocket, connection_id, user_id=user_id)
    except Exception as e:
        logger.error(f"WebSocket connect failed ({connection_id}): {e}", exc_info=True)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
        return

    try:
        while True:
            data = await websocket.receive_text()
            await manager.handle_message(connection_id, data)
    except WebSocketDisconnect:
        manager.disconnect(connection_id)
    except Exception as e:
        logger.warning(f"WebSocket loop error ({connection_id}): {e}")
        manager.disconnect(connection_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_excludes=["*.db", "*.db-journal", "*.db-wal", "__pycache__"],
    )
