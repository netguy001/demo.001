# AlphaSync — Technical Architecture Reference

> Full-stack Indian equity simulation trading platform with real-time market data,
> algorithmic strategies, and a proprietary zero-loss breakeven system.
> Production domain: **https://www.alphasync.app**

---

## Table of Contents

1. [Tech Stack Summary](#1-tech-stack-summary)
2. [Infrastructure & Deployment](#2-infrastructure--deployment)
3. [Backend Architecture](#3-backend-architecture)
4. [Database Schema](#4-database-schema)
5. [Authentication & Security](#5-authentication--security)
6. [Broker Integration Layer](#6-broker-integration-layer)
7. [Market Data Pipeline](#7-market-data-pipeline)
8. [Event Bus & Workers](#8-event-bus--workers)
9. [Trading Engine](#9-trading-engine)
10. [Risk Engine](#10-risk-engine)
11. [Market Session Engine](#11-market-session-engine)
12. [Indicator & Signal Engine](#12-indicator--signal-engine)
13. [ZeroLoss Strategy](#13-zeroloss-strategy-flagship)
14. [WebSocket Real-Time Layer](#14-websocket-real-time-layer)
15. [Caching Layer (Redis)](#15-caching-layer-redis)
16. [Frontend Architecture](#16-frontend-architecture)
17. [Frontend State Management](#17-frontend-state-management)
18. [Frontend Routing & Pages](#18-frontend-routing--pages)
19. [Frontend Component Tree](#19-frontend-component-tree)
20. [Frontend Custom Hooks](#20-frontend-custom-hooks)
21. [Frontend Strategy Engine](#21-frontend-strategy-engine-client-side)
22. [API Surface](#22-complete-api-surface)
23. [Environment Variables](#23-environment-variables)
24. [CI/CD Pipeline](#24-cicd-pipeline)

---

## 1. Tech Stack Summary

### Backend
| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | FastAPI | 0.109.2 |
| ASGI Server | Uvicorn (via Gunicorn) | 0.27.1 |
| Language | Python | 3.11 |
| ORM | SQLAlchemy (async) | 2.0.25 |
| DB Driver | asyncpg | 0.29.0 |
| Database | PostgreSQL | 16 (Alpine) |
| Migrations | Alembic | 1.13.1 |
| Cache | Redis | 7 (Alpine) |
| Redis Client | redis-py (async) | ≥5.0, <6.0 |
| JWT | python-jose[cryptography] | 3.3.0 |
| Password Hashing | passlib + bcrypt | 1.7.4 / 4.0.1 |
| Token Encryption | cryptography (AES-256-GCM) | ≥42.0, <44.0 |
| 2FA TOTP | pyotp | 2.9.0 |
| QR Codes | qrcode[pil] | 7.4.2 |
| HTTP Client | aiohttp + httpx | 3.9.3 / ≥0.25, <1.0 |
| WebSockets | websockets | 12.0 |
| Validation | Pydantic + pydantic-settings | 2.6.1 / 2.1.0 |
| Env Config | python-dotenv | 1.0.1 |

### Frontend
| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | React | 18.2.0 |
| Build Tool | Vite | 5.1.4 |
| Styling | Tailwind CSS | 3.4.1 |
| State Management | Zustand | 5.0.11 |
| Routing | React Router DOM | 6.22.1 |
| HTTP Client | Axios | 1.6.7 |
| Notifications | react-hot-toast | 2.4.1 |
| Icons | react-icons | 5.0.1 |
| Virtualization | @tanstack/react-virtual | 3.13.19 |
| CSS Utils | clsx + tailwind-merge | 2.1.1 / 3.5.0 |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| VPS | Contabo (IP: 95.111.252.225) |
| OS | Ubuntu (CloudPanel managed) |
| Reverse Proxy | CloudPanel Nginx (ports 80/443, TLS termination) |
| SSL | CloudPanel-managed Let's Encrypt |
| Containers | Docker + Docker Compose |
| Container Registry | GitHub Container Registry (ghcr.io) |
| CI/CD | GitHub Actions |
| DNS/Domain | www.alphasync.app |

---

## 2. Infrastructure & Deployment

### Production Network Topology
```
Internet
  │
  ▼
CloudPanel Nginx (ports 80/443)
  ├── TLS termination (Let's Encrypt)
  ├── /           → 127.0.0.1:3000 (frontend container)
  ├── /api/       → 127.0.0.1:8000 (backend container)
  └── /ws/        → 127.0.0.1:8000 (backend WebSocket)
        │
Docker Compose (bridge network: alphasync)
  ├── frontend    → nginx:alpine serving React SPA (port 80 internal)
  ├── backend     → gunicorn + uvicorn running FastAPI (port 8000)
  ├── db          → postgres:16-alpine (port 5432, internal only)
  └── redis       → redis:7-alpine (port 6379, internal only)
```

CloudPanel owns ports 80 and 443. Docker containers bind only to 127.0.0.1 on ports 3000 (frontend) and 8000 (backend). PostgreSQL and Redis are not exposed externally.

### Docker Compose (Production) — 4 Services
- **backend**: Pre-built image from GHCR, bound to `127.0.0.1:8000`, health-checked via Python urllib
- **frontend**: Pre-built image from GHCR, bound to `127.0.0.1:3000`, serves static React build via nginx:alpine
- **db**: postgres:16-alpine, data persisted to `pgdata` volume, health-checked via `pg_isready`
- **redis**: redis:7-alpine, AOF persistence, 256MB max memory, LRU eviction, password-protected

### Docker Compose (Development)
- Backend built from `./backend/Dockerfile`, mounts source as volume for hot-reload
- Frontend built from `./frontend/Dockerfile`, port 5173
- DB exposed on host port 5432
- Redis on port 6379, no password

### Backend Dockerfile
- Base: `python:3.11-slim`
- Non-root user: `app`
- Single Gunicorn worker with Uvicorn (1 worker — per-user async broker sessions don't parallelize with multiprocessing)
- Port 8000

### Frontend Dockerfile
- Stage 1 (build): `node:18-alpine`, `npm install`, `vite build`
- Stage 2 (serve): `nginx:alpine`, copies `dist/` to `/usr/share/nginx/html`
- Custom `nginx.conf` for SPA fallback routing
- Port 80

### Volumes
| Name | Purpose |
|------|---------|
| `pgdata` | PostgreSQL data persistence |
| `redisdata` | Redis AOF persistence |
| `uploads` | User avatar file uploads |

---

## 3. Backend Architecture

### Architecture Pattern
Event-driven microservices within a single Python process. All components communicate through a central Event Bus backed by `asyncio.Queue`. Background workers run as `asyncio.Tasks` within the same event loop.

### Process Model
```
gunicorn main:app
  └── 1× UvicornWorker (single process)
        └── asyncio event loop
              ├── FastAPI HTTP handlers
              ├── WebSocket connections
              ├── EventBus dispatcher (queue consumer)
              ├── MarketDataWorker (price streaming)
              ├── OrderExecutionWorker (pending order fills)
              ├── AlgoStrategyWorker (strategy evaluation)
              ├── ZeroLossController (proprietary strategy)
              └── BrokerSessionManager (token health checks)
```

### Startup Sequence (Lifespan)
1. `init_db()` — Create PostgreSQL tables + uuid-ossp extension
2. Connect to Redis
3. `broker_session_manager.restore_sessions()` — Reload active broker sessions from DB
4. Start EventBus dispatcher task
5. Subscribe event handlers (ORDER_FILLED → portfolio recalc, all events → WebSocket broadcast)
6. Start 4 background worker tasks (market data, order execution, algo strategy, zeroloss)
7. Start broker session health check (every 300s)
8. Auto-enable ZeroLoss if DEBUG or SIMULATION_MODE

### Shutdown Sequence
1. Emit `SYSTEM_SHUTDOWN` event
2. Stop all workers gracefully (each has a `stop()` method)
3. Stop broker session manager
4. Stop EventBus
5. Close Redis connection
6. Cancel all asyncio tasks

### Middleware Stack (order matters)
1. **CORSMiddleware** — Origins from `CORS_ORIGINS` env var (parsed as JSON array by pydantic-settings)
2. **RateLimitMiddleware** — Custom, per-IP sliding window (see Rate Limiting below)

### File Structure
```
backend/
├── main.py                    # FastAPI app, lifespan, middleware, routers
├── config/settings.py         # Pydantic BaseSettings (all config)
├── database/connection.py     # SQLAlchemy async engine + session factory
├── models/                    # SQLAlchemy ORM models
│   ├── user.py                #   User, TwoFactorAuth, UserSession
│   ├── order.py               #   Order (MARKET/LIMIT/STOP_LOSS)
│   ├── portfolio.py           #   Portfolio, Holding, Transaction
│   ├── watchlist.py           #   Watchlist, WatchlistItem
│   ├── algo.py                #   AlgoStrategy, AlgoTrade, AlgoLog
│   └── broker.py              #   BrokerAccount (encrypted tokens)
├── routes/                    # FastAPI routers (REST endpoints)
│   ├── auth.py                #   Register, login, 2FA, refresh, logout
│   ├── market.py              #   Quotes, search, history, indices, ticker
│   ├── orders.py              #   Place, list, cancel
│   ├── portfolio.py           #   Summary, holdings
│   ├── watchlist.py           #   CRUD + items
│   ├── algo.py                #   Strategy CRUD, toggle, logs
│   ├── user.py                #   Profile, password, avatar
│   ├── zeroloss.py            #   Status, toggle, signals, performance, config
│   └── broker.py              #   OAuth connect/callback, disconnect, manual token
├── services/                  # Business logic
│   ├── auth_service.py        #   JWT creation/validation, password hashing, 2FA
│   ├── trading_engine.py      #   Order placement, portfolio updates, fill logic
│   ├── portfolio_service.py   #   Portfolio summary with live prices
│   ├── market_data.py         #   Quote fetching, stock search, ticker data
│   ├── algo_engine.py         #   Strategy CRUD + log management
│   ├── broker_auth.py         #   Zebu OAuth flow, token exchange
│   ├── broker_crypto.py       #   AES-256-GCM encrypt/decrypt for broker tokens
│   ├── broker_safety.py       #   Broker credential validation
│   ├── broker_session.py      #   Per-user session manager (singleton)
│   └── nse_stocks.py          #   Static NSE stock list (300+ symbols)
├── core/                      # Cross-cutting infrastructure
│   ├── event_bus.py           #   Async event bus (pub/sub over asyncio.Queue)
│   └── rate_limiter.py        #   Sliding window rate limiter middleware
├── engines/                   # Computation engines
│   ├── indicators.py          #   SMA, EMA, RSI, MACD, Bollinger, VWAP, ATR
│   ├── signals.py             #   Signal generation per strategy type
│   ├── market_session.py      #   NSE trading hours, holidays, state machine
│   └── risk_engine.py         #   Pre-trade risk validation
├── workers/                   # Background async tasks
│   ├── market_worker.py       #   Price streaming loop
│   ├── order_worker.py        #   Pending order evaluation loop
│   ├── algo_worker.py         #   Strategy execution loop
│   └── portfolio_worker.py    #   Portfolio recalc on ORDER_FILLED events
├── providers/                 # Market data provider abstraction
│   ├── base.py                #   Abstract MarketProvider interface
│   ├── factory.py             #   Provider factory
│   ├── zebu_provider.py       #   Zebu/MYNT WebSocket implementation
│   └── symbol_mapper.py       #   Symbol translation (RELIANCE.NS ↔ RELIANCE-EQ)
├── strategies/zeroloss/       # Proprietary ZeroLoss strategy
│   ├── controller.py          #   Main control loop (scan, monitor, exit)
│   ├── models.py              #   ZeroLossSignal, ZeroLossPerformance tables
│   ├── confidence_engine.py   #   Multi-factor confidence scoring
│   ├── signal_generator.py    #   Entry signal generation
│   └── breakeven_manager.py   #   Cost calculation + SL/target levels
├── websocket/manager.py       # WebSocket connection manager (pub/sub per user)
├── cache/redis_client.py      # Redis client (price cache, subscriptions)
├── alembic/                   # Database migration scripts
└── Dockerfile                 # Production image build
```

---

## 4. Database Schema

### PostgreSQL 16 — Tables

#### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK, server_default uuid |
| email | VARCHAR | UNIQUE |
| username | VARCHAR | UNIQUE |
| password_hash | VARCHAR | bcrypt hash |
| full_name | VARCHAR(100) | nullable |
| phone | VARCHAR(20) | nullable |
| avatar_url | VARCHAR | nullable |
| is_verified | BOOLEAN | default false |
| is_active | BOOLEAN | default true |
| role | VARCHAR(20) | default "user" |
| virtual_capital | FLOAT | default 1,000,000 (₹10 lakh) |
| created_at | TIMESTAMP(TZ) | auto |
| updated_at | TIMESTAMP(TZ) | auto |

Relationships: `two_factor`, `portfolio`, `orders`, `watchlists`, `algo_strategies`

#### `two_factor_auth`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users, UNIQUE |
| secret | VARCHAR | TOTP base32 key |
| is_enabled | BOOLEAN | default false |
| backup_codes | TEXT | JSON array, nullable |

#### `user_sessions`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users |
| token_jti | VARCHAR | UNIQUE (JWT ID for revocation) |
| ip_address | VARCHAR(45) | |
| user_agent | VARCHAR | |
| is_active | BOOLEAN | default true |
| created_at | TIMESTAMP(TZ) | |
| expires_at | TIMESTAMP(TZ) | |

Index: `(user_id, is_active)`

#### `orders`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users |
| symbol | VARCHAR(20) | e.g. "RELIANCE.NS" |
| exchange | VARCHAR(10) | default "NSE" |
| order_type | VARCHAR(20) | MARKET, LIMIT, STOP_LOSS, STOP_LOSS_LIMIT |
| side | VARCHAR(4) | BUY, SELL |
| quantity | INTEGER | CHECK > 0 |
| price | FLOAT | nullable (MARKET orders) |
| trigger_price | FLOAT | nullable (STOP orders) |
| filled_quantity | INTEGER | default 0 |
| filled_price | FLOAT | nullable |
| status | VARCHAR(20) | PENDING → OPEN → FILLED / CANCELLED / REJECTED / EXPIRED |
| rejection_reason | VARCHAR | nullable |
| created_at | TIMESTAMP(TZ) | |
| updated_at | TIMESTAMP(TZ) | |
| executed_at | TIMESTAMP(TZ) | nullable |

Indices: `(user_id, status)`, `(user_id, created_at)`  
Check constraints on `side`, `order_type`, `status`, `quantity > 0`

#### `portfolios`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users, UNIQUE |
| total_invested | FLOAT | default 0 |
| current_value | FLOAT | default 0 |
| available_capital | FLOAT | default 1,000,000 |
| total_pnl | FLOAT | default 0 |
| total_pnl_percent | FLOAT | default 0 |

Relationship: `holdings` (cascade delete)

#### `holdings`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| portfolio_id | UUID | FK → portfolios |
| symbol | VARCHAR(20) | |
| exchange | VARCHAR(10) | |
| company_name | VARCHAR(200) | nullable |
| quantity | INTEGER | |
| avg_price | FLOAT | |
| current_price | FLOAT | |
| invested_value | FLOAT | |
| current_value | FLOAT | |
| pnl | FLOAT | |
| pnl_percent | FLOAT | |

Unique index: `(portfolio_id, symbol)`

#### `transactions`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users |
| order_id | UUID | FK → orders, nullable |
| symbol | VARCHAR(20) | |
| transaction_type | VARCHAR(4) | BUY, SELL |
| quantity | INTEGER | |
| price | FLOAT | |
| total_value | FLOAT | |
| created_at | TIMESTAMP(TZ) | |

Index: `(user_id, created_at)`

#### `watchlists`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users |
| name | VARCHAR(100) | default "My Watchlist" |
| created_at | TIMESTAMP(TZ) | |

Relationship: `items` (cascade delete)

#### `watchlist_items`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| watchlist_id | UUID | FK → watchlists |
| symbol | VARCHAR(20) | |
| exchange | VARCHAR(10) | default "NSE" |
| added_at | TIMESTAMP(TZ) | |

Unique index: `(watchlist_id, symbol)`

#### `algo_strategies`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users |
| name | VARCHAR(100) | |
| description | TEXT | nullable |
| strategy_type | VARCHAR(30) | SMA_CROSSOVER, RSI, MACD, CUSTOM |
| symbol | VARCHAR(20) | |
| exchange | VARCHAR(10) | |
| parameters | JSONB | strategy-specific config |
| is_active | BOOLEAN | default false |
| max_position_size | INTEGER | default 100 |
| stop_loss_percent | FLOAT | default 2.0 |
| take_profit_percent | FLOAT | default 4.0 |
| total_trades | INTEGER | default 0 |
| total_pnl | FLOAT | default 0 |
| win_rate | FLOAT | default 0 |

Index: `(user_id, is_active)`  
Relationships: `trades`, `logs`

#### `algo_trades`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| strategy_id | UUID | FK → algo_strategies |
| user_id | UUID | FK → users |
| symbol | VARCHAR(20) | |
| side | VARCHAR(4) | BUY, SELL |
| quantity | INTEGER | |
| price | FLOAT | |
| pnl | FLOAT | nullable |
| signal | TEXT | reason string |
| created_at | TIMESTAMP(TZ) | |

Index: `(strategy_id, created_at)`

#### `algo_logs`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| strategy_id | UUID | FK → algo_strategies |
| level | VARCHAR(10) | INFO, WARNING, ERROR, TRADE |
| message | TEXT | |
| data | JSONB | nullable |
| created_at | TIMESTAMP(TZ) | |

Index: `(strategy_id, created_at)`

#### `broker_accounts`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| user_id | UUID | FK → users |
| broker | VARCHAR(20) | default "zebu" |
| broker_user_id | VARCHAR(50) | nullable |
| access_token_enc | TEXT | AES-256-GCM encrypted |
| refresh_token_enc | TEXT | nullable, encrypted |
| token_expiry | TIMESTAMP(TZ) | nullable |
| is_active | BOOLEAN | default true |
| extra_data_enc | TEXT | nullable, encrypted JSONB (uid, actid, email) |
| connected_at | TIMESTAMP(TZ) | |
| last_used_at | TIMESTAMP(TZ) | |
| updated_at | TIMESTAMP(TZ) | |

Unique constraint: `(user_id, broker)`  
Index: `(broker, is_active)`

#### `zeroloss_signals`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| symbol | VARCHAR | |
| timestamp | TIMESTAMP(TZ) | indexed |
| confidence_score | FLOAT | 0–100 |
| direction | VARCHAR | LONG, SHORT, NO_TRADE |
| entry_price | FLOAT | nullable |
| stop_loss | FLOAT | nullable |
| target | FLOAT | nullable |
| status | VARCHAR | WAITING, ACTIVE, PROFIT, BREAKEVEN |
| created_at | TIMESTAMP(TZ) | |

Index: `(symbol, timestamp)`

#### `zeroloss_performance`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK |
| date | DATE | UNIQUE |
| total_trades | INTEGER | |
| profit_trades | INTEGER | |
| breakeven_trades | INTEGER | |
| loss_trades | INTEGER | always 0 by design |
| net_pnl | FLOAT | |
| created_at | TIMESTAMP(TZ) | |

### SQLAlchemy Configuration
- Engine: `create_async_engine` with asyncpg
- Pool: 20 steady connections, 10 overflow, 3600s recycle, pre-ping enabled
- Session: `async_sessionmaker` with `expire_on_commit=False`
- Extension: `uuid-ossp` (wrapped in DO block to handle race conditions)

---

## 5. Authentication & Security

### JWT Token System
- **Access Token**: 60-minute lifetime, HS256, claims: `sub` (user_id), `email`, `jti`, `exp`, `type: "access"`
- **Refresh Token**: 7-day lifetime, HS256, claims: `sub`, `jti`, `exp`, `type: "refresh"`
- **Revocation**: JTI stored in `user_sessions` table; logout invalidates by marking `is_active=false`
- **Library**: python-jose[cryptography]

### Password Security
- **Hashing**: bcrypt via passlib `CryptContext(schemes=["bcrypt"])`
- **Verification**: `pwd_context.verify(plain, hash)`

### Two-Factor Authentication (2FA)
- **Protocol**: TOTP (RFC 6238)
- **Secret**: `pyotp.random_base32()` — 32-char base32 key
- **Verification**: `pyotp.TOTP(secret).verify(code, valid_window=1)` (allows ±30s drift)
- **QR Code**: Generated as PNG → base64 string for frontend display
- **Backup Codes**: Stored as JSON array in DB

### Broker Token Encryption
- **Algorithm**: AES-256-GCM (authenticated encryption with associated data)
- **Key Derivation**: HKDF-SHA256 from `BROKER_ENCRYPTION_KEY` environment variable
- **Nonce**: 12 random bytes, prepended to ciphertext before base64 encoding
- **Storage Format**: `base64(nonce + ciphertext + tag)` in `access_token_enc`/`extra_data_enc` columns
- **API**: `encrypt_token()`, `decrypt_token()`, `encrypt_json()`, `decrypt_json()`

### Rate Limiting
Sliding window counter, in-memory, per IP + path prefix:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/auth/login` | 10 requests | 60s |
| `/api/auth/register` | 5 requests | 60s |
| `/api/auth/refresh` | 30 requests | 60s |
| `/api/auth/2fa` | 10 requests | 60s |
| All other `/api/*` | 120 requests | 60s |

Returns HTTP 429 with `Retry-After` header on breach. Skips WebSocket and non-API paths.

---

## 6. Broker Integration Layer

### Per-User Session Architecture
There is no global market data provider. Every broker connection is scoped to a user. The `BrokerSessionManager` singleton manages a registry of active `ZebuProvider` instances keyed by user_id.

```
BrokerSessionManager (singleton)
├── _sessions: dict[user_id → ZebuProvider]
├── create_session(user_id) → Load encrypted tokens from DB, decrypt, create ZebuProvider, start WebSocket
├── destroy_session(user_id) → Stop provider, remove from registry
├── get_session(user_id) → Return user's provider or None
├── get_any_session() → Return ANY active provider (for system tasks)
├── restore_sessions() → At startup, restore all active sessions from DB
└── health_check loop → Every 300s, validate token expiry
```

### Zebu OAuth Flow
1. **Connect**: `GET /api/broker/zebu/connect` → Generate state token (stored in-memory, 10-min TTL), return Zebu login redirect URL
2. **Callback**: `POST /api/broker/zebu/callback` → Validate state, receive `susertoken` from Zebu redirect, encrypt with AES-256-GCM, upsert `broker_accounts` row, create ZebuProvider session
3. **Disconnect**: `DELETE /api/broker/zebu/disconnect` → Wipe encrypted tokens, set `is_active=false`, destroy provider session

Alternative auth paths:
- **QuickAuth**: `POST /api/broker/zebu/login` — Programmatic login with uid/password/factor2
- **Manual Token**: `POST /api/broker/zebu/manual-token` — Direct token injection (dev/testing)

### Zebu Provider (WebSocket)
- **Endpoint**: `wss://go.mynt.in/NorenWSTP/` (Zebu rebranded to MYNT)
- **Auth**: `jKey` (session token) sent on connection handshake
- **Reconnection**: Exponential backoff (1s base, 2x factor, 60s max, 50 max attempts)
- **Heartbeat**: Ping every 30s, expect pong within 10s
- **Credential Hot-Swap**: `update_credentials()` with lock-based synchronization

### Symbol Mapping
Bidirectional translation between AlphaSync canonical format and Zebu format:
- Canonical: `RELIANCE.NS` (dot-separated, exchange suffix)
- Zebu: `RELIANCE-EQ` (trading symbol) + token `2885` (numeric exchange token)
- ~20 popular NSE stocks pre-mapped; dynamic loading from Zebu master contract file

---

## 7. Market Data Pipeline

### Data Flow
```
Zebu MYNT WebSocket
  → ZebuProvider (per-user)
    → MarketDataWorker (polls every 3s during trading, 60s otherwise)
      → EventBus (PRICE_UPDATED event)
        → Redis price cache (120s TTL)
        → WebSocket broadcast to all connected clients
```

### Market Data Service API
- **User-scoped**: `get_quote(symbol, user_id)` — Uses that user's broker session
- **System-scoped**: `get_system_quote(symbol)` — Uses any active session (for ZeroLoss, algos)
- **Safe variants**: `get_quote_safe()`, `get_system_quote_safe()` — Return None instead of raising
- **Stock search**: Local NSE list (300+ stocks) merged with Zebu SearchScrip API, 5-min cache, top 20 results
- **Ticker data**: Indices (^NSEI, ^NSEBANK, ^CNXIT, ^BSESN) + 20 popular stocks

### Pre-Mapped Symbols
RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, ITC, KOTAKBANK, LT, SBIN, BAJFINANCE, BHARTIARTL, ASIANPAINT, HCLTECH, MARUTI, SUNPHARMA, TITAN, WIPRO, ULTRACEMCO, NESTLEIND, TATAMOTORS

---

## 8. Event Bus & Workers

### Event Bus Design
Single `asyncio.Queue` with sequential handler dispatch. Emitters enqueue events; the dispatcher loop dequeues and calls all registered handlers for that event type.

```
EventType (16 total):
├── PRICE_UPDATED
├── MARKET_STATE_CHANGE
├── ORDER_PLACED, ORDER_FILLED, ORDER_PARTIALLY_FILLED, ORDER_CANCELLED, ORDER_REJECTED, ORDER_EXPIRED
├── PORTFOLIO_UPDATED
├── ALGO_SIGNAL, ALGO_TRADE, ALGO_ERROR, ALGO_STATE_CHANGE
├── RISK_BREACH, RISK_KILL_SWITCH
├── USER_LOGIN, USER_LOGOUT
└── SYSTEM_STARTUP, SYSTEM_SHUTDOWN
```

### Event Subscriptions (wired at startup)
| Event | Handler | Action |
|-------|---------|--------|
| ORDER_FILLED | portfolio_recalc_worker | Recalculate portfolio on async fills |
| PRICE_UPDATED | WebSocket manager | Broadcast to all connected clients |
| ORDER_* | WebSocket manager | Send to specific user |
| PORTFOLIO_UPDATED | WebSocket manager | Send to specific user |
| ALGO_TRADE/SIGNAL/ERROR | WebSocket manager | Send to user or broadcast |

### Background Workers

#### Market Data Worker
- **Interval**: 3s (trading hours), 60s (market closed), 10s (no broker sessions)
- **Logic**: Get any active broker session → fetch quotes for all subscribed symbols → emit PRICE_UPDATED per symbol
- **Sleep**: 0.3s between symbols to avoid API hammering

#### Order Execution Worker
- **Interval**: 5s (trading hours only, skips outside market hours)
- **Logic**: Fetch all OPEN orders across all users → for each, check fill conditions:
  - LIMIT BUY: price ≤ limit_price
  - LIMIT SELL: price ≥ limit_price
  - STOP_LOSS/STOP_LOSS_LIMIT: trigger conditions met
- **Expiry**: Orders older than 7 days auto-expire

#### Algo Strategy Worker
- **Interval**: 30s (only when `market_session.can_run_algo()` returns true)
- **Logic**: For each active strategy → fetch 60-day OHLCV → compute indicators → generate signal → run risk engine → place order if approved → record AlgoTrade + AlgoLog → emit ALGO_TRADE

#### Portfolio Recalculation Worker
- **Trigger**: Event-driven (subscribes to ORDER_FILLED)
- **Logic**: Handle async fills from order_execution_worker (LIMIT/STOP orders), update holdings, create transaction records, recalculate portfolio totals, emit PORTFOLIO_UPDATED

---

## 9. Trading Engine

### Order Placement Flow
```
1. Fetch current market price (via get_quote_safe)
2. Load user's portfolio
3. Validate order params (type, side, quantity, prices)
4. Risk Engine pre-check (position size, capital, exposure, daily loss, open order count)
5. Capital check (BUY) or Holdings check (SELL)
6. Create Order record in DB (status = PENDING)
7. IF MARKET order:
     → Execute immediately (status = FILLED)
     → Update portfolio inline
     → Emit ORDER_FILLED event
8. IF LIMIT/STOP order:
     → Set status = OPEN
     → Emit ORDER_PLACED event
     → Evaluated async by Order Execution Worker
```

### Portfolio Update on Fill
- **BUY**: Decrease available_capital, increase total_invested, create/update holding (average-up if existing)
- **SELL**: Increase available_capital, decrease total_invested, reduce holding quantity (delete if zero), track realized P&L
- **Audit**: Create Transaction record for every fill

---

## 10. Risk Engine

Sequential pre-trade validation — all checks must pass:

| Check | Limit | Default |
|-------|-------|---------|
| Algo Kill-Switch | If active, reject all algo orders | Off |
| Market Session | Must be pre-market or open (bypassed in simulation) | N/A |
| Position Size | Max shares per order | 500 |
| Capital per Trade | Max BUY value | ₹2,00,000 |
| Portfolio Exposure | Max (invested / total capital) | 80% |
| Open Order Limit | Max concurrent open orders | 20 |
| Daily Loss Limit | Max realized loss per day | ₹50,000 |

Admin controls: `activate_kill_switch()`, `deactivate_kill_switch()`, `update_limits()`, `get_status()`

Daily P&L tracking: Resets at midnight IST, cached in-memory.

---

## 11. Market Session Engine

### NSE Session States (IST)
| Time Range | State | Orders | Trading | Algo |
|------------|-------|--------|---------|------|
| 09:00–09:15 | PRE_MARKET | ✅ | ❌ | ❌ |
| 09:15–15:20 | OPEN | ✅ | ✅ | ✅ |
| 15:20–15:30 | CLOSING | ❌ | ✅ | ❌ |
| 15:30–16:00 | AFTER_MARKET | ❌ | ❌ | ❌ |
| 16:00–09:00 | CLOSED | ❌ | ❌ | ❌ |
| Saturday/Sunday | CLOSED | ❌ | ❌ | ❌ |

Includes 17 NSE holidays for 2026 (Republic Day, Holi, Good Friday, Eid, Independence Day, Diwali, Christmas, etc.)

**Simulation Mode**: When `SIMULATION_MODE=true`, all session checks are bypassed — trading works 24/7.

---

## 12. Indicator & Signal Engine

### Backend Indicators (stateless functions)
| Indicator | Parameters | Output |
|-----------|-----------|--------|
| SMA | period | List of moving averages |
| EMA | period | List (Wilder's smoothing) |
| RSI | period=14 | 0–100 oscillator |
| MACD | fast=12, slow=26, signal=9 | {macd_line, signal_line, histogram} |
| Bollinger Bands | period=20, std_dev=2 | {upper, middle, lower} |
| VWAP | — | Volume-weighted average price |
| ATR | period=14 | Average true range |

All return arrays same length as input; first (period-1) values are None.

### Signal Generation
```python
@dataclass
class Signal:
    action: str       # BUY, SELL, HOLD
    confidence: float  # 0.0–1.0
    reason: str
    indicator_values: dict
```

| Strategy | BUY Condition | SELL Condition | Confidence |
|----------|--------------|----------------|------------|
| SMA_CROSSOVER | Short SMA > Long SMA (golden cross) | Short < Long (death cross) | 0.70 |
| RSI | Oversold bounce (RSI crosses above 30) | Overbought (RSI > 70) | 0.65 |
| MACD | MACD > signal line | MACD < signal line | 0.60 |
| BOLLINGER | Price ≤ lower band | Price ≥ upper band | 0.55 |

---

## 13. ZeroLoss Strategy (Flagship)

### Concept
A proprietary strategy that guarantees break-even on losing trades by calculating stop-loss levels that exactly cover round-trip transaction costs.

### Architecture
```
ZeroLossController (background task, 30s cycle)
├── ConfidenceEngine → Multi-factor scoring (0–100)
├── ZeroLossSignalGenerator → LONG/SHORT/NO_TRADE decision
├── BreakevenManager → Cost-aware SL/target calculation
└── Position Monitor → Track active positions, check exits (5s)
```

### Confidence Engine — 6-Factor Scoring
| Factor | Weight | Scoring Logic |
|--------|--------|---------------|
| EMA Stack (20/50/200) | 25 pts | Bullish alignment: 25, Partial: 12, Mixed: 0 |
| RSI Zone | 20 pts | Sweet zone: 20, Near edge: 10, Outside: 0 |
| MACD | 15 pts | Positive + growing: 15, Aligned: 8, Opposed: 0 |
| Volume Confirmation | 15 pts | Ratio > 1.2: 15, else proportionally |
| Volatility (India VIX) | 15 pts | ≤12: 15, 12–18: 8, ≥25: reduced |
| Support/Resistance | 10 pts | Proximity-based scoring |

Minimum candles required: 55 (for EMA-200 + buffer)

### Signal Decision Matrix
| Confidence | Direction | Signal |
|------------|-----------|--------|
| < 75 (threshold) | Any | NO_TRADE (zero-loss guarantee) |
| ≥ 75 | BULLISH | LONG |
| ≥ 75 | BEARISH | SHORT |
| ≥ 75 | NEUTRAL | NO_TRADE |

### Break-Even Cost Calculation (Indian Equity Delivery)
```
Buy-side costs:
  Brokerage:          min(0.03%, ₹20)
  STT:                0.1%
  Exchange charges:   0.00345%
  GST (18%):          ~0.006% (on brokerage + exchange)
  SEBI fee:           0.0001%
  Stamp duty:         0.015%
───────────────────────────────
Round-trip total:     ≈ 0.25% of trade value
```

### Trade Level Computation
```
For LONG:
  entry = current_market_price
  cost_per_share = round_trip_cost / quantity
  slippage = 0.01% buffer
  stop_loss = entry - cost_per_share
  risk = cost_per_share
  target = entry + (risk × reward_ratio)

For SHORT:
  stop_loss = entry + cost_per_share
  target = entry - (risk × reward_ratio)
```

If stop-loss is hit, net P&L = 0 (costs are exactly offset). If target is hit, pure profit.

### Controller Loop
1. **Monitor active positions** (every 5s): Check prices vs SL/target, close if hit
2. **Force-close** at 15:20 IST (before market close)
3. **Scan for new signals** (only during trading hours): For each unoccupied tracked symbol, run confidence engine + signal generator → open position if criteria met

### Persistence
- Signals → `zeroloss_signals` table
- Daily performance → `zeroloss_performance` table
- Events → EventBus (ALGO_SIGNAL, ALGO_TRADE channels)

---

## 14. WebSocket Real-Time Layer

### Connection Manager
```
ConnectionManager (singleton):
├── active_connections: dict[conn_id → WebSocket]
├── subscriptions: dict[symbol → set[conn_ids]]
├── user_connections: dict[user_id → set[conn_ids]]
├── connection_users: dict[conn_id → user_id]
```

### Client Connection
- **Endpoint**: `WS /ws/{client_id}?token={jwt}`
- **Auth**: JWT validated on connect, user_id extracted
- **Protocol**: JSON messages

### Message Types (Server → Client)
| Type | Channel | Target | Payload |
|------|---------|--------|---------|
| `quote` | `prices` | All subscribers | symbol, price, change, volume |
| `order_update` | `orders` | Specific user | order details |
| `portfolio_update` | `portfolio` | Specific user | portfolio summary |
| `algo_signal` | `zeroloss` | Broadcast | confidence data |
| `algo_trade` | `zeroloss` | Broadcast | trade details |

### Client Messages (Client → Server)
| Action | Payload | Effect |
|--------|---------|--------|
| `subscribe` | `{symbols: [...]}` | Add to price subscriptions |
| `unsubscribe` | `{symbols: [...]}` | Remove from subscriptions |
| `ping` | — | Server responds with `pong` |

### Event Handlers (wired to EventBus)
- `on_price_event` → Broadcast to ALL connected clients
- `on_order_event` → Send to the order's user only
- `on_portfolio_event` → Send to the portfolio's user only
- `on_algo_event` → Send to specific user or broadcast (ZeroLoss)

---

## 15. Caching Layer (Redis)

### Key Schema
| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `alphasync:price:{symbol}` | STRING (JSON) | 120s | Single quote cache |
| `alphasync:price:{symbol}:ts` | STRING (unix) | 120s | Quote timestamp |
| `alphasync:price:all` | HASH | — | All prices in one key |
| `alphasync:subscriptions` | SET | — | Active symbol subscriptions |
| `alphasync:provider:status` | STRING (JSON) | 60s | Provider health snapshot |

### Connection
- `redis.asyncio` with connection pool (20 connections, 5s timeout)
- `retry_on_timeout=True`
- AOF persistence enabled, 256MB max memory, LRU eviction on pressure

### Failure Mode
All Redis operations catch exceptions and return None/False. The system continues without cache — just slower (direct provider queries).

---

## 16. Frontend Architecture

### Build Pipeline
```
Source (JSX + CSS)
  → Vite (dev server with HMR, or production build)
    → React 18 (components)
    → Tailwind CSS 3 (utility-first styling)
    → PostCSS + Autoprefixer
      → dist/ (static HTML, CSS, JS bundles)
        → nginx:alpine (Docker, SPA fallback)
```

### Design System

**Color Palette**:
- Primary: Indigo (50–900)
- Surface: CSS custom properties (dark/light tokens)
- Trading: `profit` (#22c55e), `loss` (#ef4444), `bull` (#26A69A), `bear` (#EF5350)
- Accent: Cyan, Emerald, Amber

**Typography**:
- Body: Inter
- Code/Prices: JetBrains Mono / Fira Code / DM Mono
- Display: Syne

**Animations**: `fade-in`, `slide-up`, `slide-in-right`, `price-up`, `price-down` (flash), `skeleton` (shimmer), `marquee`, `float`

**Responsive Breakpoints**: xs (480), sm (640), md (768), lg (1024), xl (1400), 2xl (1920)

### Component Classes (index.css)
- `.glass-card` — Frosted glass effect
- `.btn-primary`, `.btn-secondary`, `.btn-buy`, `.btn-sell` — Button variants
- `.input-field`, `.label-text` — Form elements
- `.price-up`, `.price-down` — Flash animations
- `.sidebar-link`, `.sidebar-link-active` — Navigation
- `.stat-card`, `.price-display` — Data display

### File Structure
```
frontend/src/
├── main.jsx                  # ReactDOM.createRoot + BrowserRouter + ThemeProvider
├── App.jsx                   # Route definitions + Suspense + lazy loading
├── index.css                 # Global styles + CSS custom properties + Tailwind
├── pages/                    # Route-level components (12 total)
│   ├── LandingPage.jsx       #   Marketing homepage
│   ├── LoginPage.jsx         #   JWT login + optional 2FA
│   ├── RegisterPage.jsx      #   Account registration with password strength
│   ├── TradingModeSelectPage #   Demo/Live/Options mode selection
│   ├── BrokerSelectPage.jsx  #   Zebu broker connection
│   ├── BrokerCallbackPage    #   OAuth callback handler
│   ├── PortfolioPage.jsx     #   Portfolio overview
│   ├── AlgoTradingPage.jsx   #   Algo strategy management
│   ├── ZeroLossPage.jsx      #   ZeroLoss strategy dashboard
│   └── SettingsPage.jsx      #   Profile, security, 2FA, theme
├── workspaces/               # Complex page layouts
│   ├── DashboardWorkspace    #   Main dashboard (stats, indices, ZeroLoss, orders)
│   └── TradingWorkspace      #   Terminal (watchlist | chart | order panel)
├── components/
│   ├── layout/               #   AppShell, Navbar, Sidebar, MarketTickerBar
│   │                         #   DockContainer, ResizablePanel, ResponsiveDrawer
│   │                         #   MobileTradeBar
│   ├── trading/              #   ChartHeader, ZebuLiveChart, Watchlist
│   │                         #   WatchlistItem, OrderPanel
│   ├── portfolio/            #   PortfolioSummary, HoldingsTable, PnLCard
│   └── ui/                   #   Badge, Button, Input, Modal, Skeleton, Tooltip
├── panels/                   #   PositionsPanel, OrderHistoryPanel, PanelContainer
├── strategy/                 # Client-side strategy engine
│   ├── components/           #   StrategyDock (floating draggable panel)
│   ├── engine/               #   strategyEngine.js (runs all enabled strategies)
│   ├── indicators/           #   14 indicators (SMA, EMA, RSI, MACD, BB, ATR, etc.)
│   └── strategies/           #   16 strategies (crossovers, momentum, mean-reversion)
├── stores/                   # Zustand state (6 stores)
│   ├── useAuthStore.js
│   ├── useBrokerStore.js
│   ├── useMarketIndicesStore.js
│   ├── useStrategyStore.js
│   ├── useWatchlistStore.js
│   └── useZeroLossStore.js
├── store/                    # Zustand state (2 stores)
│   ├── useMarketStore.js
│   └── usePortfolioStore.js
├── hooks/                    # Custom hooks (8 total)
│   ├── useBreakpoint.js      #   Responsive breakpoint detection
│   ├── useDebounce.js        #   Function debouncing
│   ├── useDraggable.js       #   Drag-to-position with localStorage persistence
│   ├── useKeyboardShortcuts  #   Keyboard shortcut binding
│   ├── useMarketData.js      #   Quote polling + candle fetching
│   ├── useOrders.js          #   Order form state + submission
│   ├── useSearch.js          #   Debounced search with abort controller
│   └── useWebSocket.js       #   WebSocket connection + auto-reconnect
├── context/                  # React Context providers
│   ├── AuthContext.jsx       #   Legacy auth context (mostly replaced by store)
│   └── ThemeContext.jsx      #   Dark/light theme toggle + localStorage
├── services/
│   └── api.js                #   Axios instance with JWT interceptors
└── utils/
    ├── cn.js                 #   clsx + twMerge className utility
    ├── constants.js          #   API_BASE, localStorage keys, chart periods, etc.
    ├── formatters.js         #   ₹ currency, percent, date/time formatters
    └── validators.js         #   Order form, email, password validation
```

---

## 17. Frontend State Management

All state is managed by Zustand stores (8 total). No Redux. No React Context for state (only for theme and legacy auth wrapper).

### useAuthStore
| State | Type |
|-------|------|
| `user` | object \| null (from localStorage) |
| `loading` | boolean |
| `isAuthenticated` | computed boolean |

| Action | API Call |
|--------|---------|
| `login(email, pw, totp?)` | POST `/auth/login` |
| `register(data)` | POST `/auth/register` |
| `logout()` | Clear localStorage |
| `updateUser(patch)` | Merge + persist |

### useBrokerStore
| State | Type |
|-------|------|
| `status` | 'disconnected' \| 'connecting' \| 'connected' \| 'expired' |
| `brokerUserId` | string \| null |
| `tokenExpiry` | ISO timestamp \| null |

| Action | API Call |
|--------|---------|
| `connect()` | GET `/broker/zebu/connect` |
| `handleCallback(code, state, extra)` | POST `/broker/zebu/callback` |
| `disconnect()` | DELETE `/broker/zebu/disconnect` |
| `login(uid, pw, 2fa, apiKey, vendor)` | POST `/broker/zebu/login` |
| `fetchStatus()` | GET `/broker/status?broker=zebu` |
| `manualToken(token, uid, actid)` | POST `/broker/zebu/manual-token` |

### useMarketStore
| State | Type |
|-------|------|
| `symbols` | Record<symbol, quote> |
| `watchlist` | Array<symbol> |
| `selectedSymbol` | string \| null |
| `wsStatus` | connection status |

| Action | API Call |
|--------|---------|
| `updateQuote(symbol, data)` | — (from WebSocket) |
| `batchUpdateQuotes(map)` | — (from WebSocket) |
| `setSelectedSymbol(symbol)` | — |

### usePortfolioStore
| State | Type |
|-------|------|
| `holdings` | Array<holding> |
| `positions` | Array<position> |
| `orders` | Array<order> |
| `summary` | object \| null |
| `pnl` | {realized, unrealized, total} |

| Action | API Call |
|--------|---------|
| `refreshPortfolio()` | GET `/portfolio/summary`, `/portfolio/holdings`, `/orders` (parallel) |

### useWatchlistStore
| State | Type |
|-------|------|
| `watchlists` | Array<{id, name, items[]}> |
| `activeId` | string \| null |
| `prices` | Record<symbol, quote> |

| Action | API Call |
|--------|---------|
| `loadWatchlist()` | GET `/watchlist` |
| `createWatchlist(name)` | POST `/watchlist` |
| `renameWatchlist(id, name)` | PATCH `/watchlist/{id}` |
| `deleteWatchlist(id)` | DELETE `/watchlist/{id}` |
| `addItem(symbol, exchange)` | POST `/watchlist/{id}/items` |
| `removeItem(itemId)` | DELETE `/watchlist/{id}/items/{itemId}` |
| `fetchPrices()` | GET `/market/batch?symbols=...` |

### useZeroLossStore
| State | Type |
|-------|------|
| `enabled` | boolean |
| `symbols` | Array<string> |
| `confidence` | Record<symbol, {score, direction, breakdown}> |
| `activePositions` | Record<symbol, position> |
| `stats` | {today_trades, today_profit, today_breakeven, today_pnl} |
| `signals` | Array<signal> (history) |
| `performance` | {records, summary} |

| Action | API Call |
|--------|---------|
| `fetchAll()` | GET `/zeroloss/status`, `/zeroloss/signals`, `/zeroloss/performance` (parallel) |
| `toggle()` | POST `/zeroloss/toggle` |
| `handleWsMessage(data)` | — (from WebSocket) |

### useMarketIndicesStore
| Action | API Call |
|--------|---------|
| `fetchIndices()` | GET `/market/indices` |
| `fetchTicker()` | GET `/market/ticker` |
| `startPolling(interval)` | Periodic fetchTicker |

### useStrategyStore
- `enabledMap` (localStorage-persisted) — Which client-side strategies are active
- `engineOutput` — Cached result from client-side strategy engine

---

## 18. Frontend Routing & Pages

### Route Tree
```
/ (BrowserRouter)
├── PUBLIC (ForceDarkMode wrapper):
│   ├── /                    → LandingPage
│   ├── /login               → LoginPage
│   └── /register            → RegisterPage
│
├── PROTECTED + ForceDarkMode (no AppShell):
│   ├── /select-mode         → TradingModeSelectPage
│   ├── /select-broker       → BrokerSelectPage
│   └── /broker/callback     → BrokerCallbackPage
│
├── PROTECTED (inside AppShell → Navbar + Sidebar):
│   ├── /dashboard           → DashboardWorkspace
│   ├── /terminal            → TradingWorkspace
│   ├── /portfolio           → PortfolioPage
│   ├── /algo                → AlgoTradingPage
│   ├── /zeroloss            → ZeroLossPage
│   └── /settings            → SettingsPage
│
└── * → redirect to /
```

All page components are lazy-loaded with `React.lazy()` + `<Suspense fallback={<PageSkeleton/>}>`.

### AppShell Layout
```
┌─────────────────────────────────────────────────┐
│  Navbar (search, market ticker, user menu)       │
├──────┬──────────────────────────────────────────┤
│      │                                          │
│ Side │          <Outlet />                      │
│ bar  │          (page content)                  │
│      │                                          │
├──────┴──────────────────────────────────────────┤
│  (optional: DockContainer for terminal)          │
└─────────────────────────────────────────────────┘
```

### TradingWorkspace Layout (Responsive)
**Desktop (≥1400px)**:
```
┌──────────┬────────────────────────┬──────────┐
│          │    ChartHeader         │          │
│ Watchlist│    ZebuLiveChart       │  Order   │
│ (resize) │                        │  Panel   │
│          ├────────────────────────┤          │
│          │    DockContainer       │          │
│          │    (Positions/Orders)  │          │
└──────────┴────────────────────────┴──────────┘
                  + floating StrategyDock
```
**Mobile (<768px)**: Watchlist and Order Panel become slide-in drawers + bottom trade bar

---

## 19. Frontend Component Tree

### Layout Components
| Component | Purpose |
|-----------|---------|
| `AppShell` | Main wrapper: Navbar + Sidebar + Outlet |
| `Navbar` | Top bar: user menu, search, market ticker |
| `Sidebar` | Left nav: Dashboard, Terminal, Portfolio, Algo, ZeroLoss, Settings |
| `MarketTickerBar` | Scrolling marquee of indices + stock prices |
| `DockContainer` | Tabbed bottom dock (positions, orders) in terminal |
| `ResizablePanel` | Drag-resizable panel (watchlist columns on desktop) |
| `ResponsiveDrawer` | Slide-in drawer (watchlist/orders on tablet/mobile) |
| `MobileTradeBar` | Fixed bottom bar with Buy/Sell buttons on mobile |

### Trading Components
| Component | Purpose |
|-----------|---------|
| `ChartHeader` | Symbol name + price + period selector + strategy dock toggle |
| `ZebuLiveChart` | Candlestick chart (embedded viewer or SVG candles) |
| `Watchlist` | Tabbed watchlist manager with price tiles |
| `WatchlistItem` | Single item: symbol, price, change, buy/sell buttons |
| `OrderPanel` | Order form: side, type, qty, price, submit |

### Portfolio Components
| Component | Purpose |
|-----------|---------|
| `PortfolioSummary` | Stat cards: capital, invested, current value, P&L |
| `HoldingsTable` | Table: symbol, qty, avg price, LTP, P&L, % |
| `PnLCard` | Individual holding P&L display |

### UI Components
`Badge`, `Button`, `Input`, `Modal`, `Skeleton`, `Tooltip`

### Guard Components
| Component | Purpose |
|-----------|---------|
| `ProtectedRoute` | Checks auth, redirects to /login if not authenticated |
| `ErrorBoundary` | Catches React errors, shows fallback UI |
| `ForceDarkMode` | Forces dark theme for specific route subtrees |

---

## 20. Frontend Custom Hooks

| Hook | Signature | Purpose |
|------|-----------|---------|
| `useBreakpoint` | `() → {width, tier, isMobile, isTablet, isDesktop}` | Responsive breakpoint detection via ResizeObserver |
| `useDebounce` | `(fn, delay) → debouncedFn` | Function debouncing with cleanup |
| `useDraggable` | `(storageKey, defaultPos) → {position, onMouseDown, dragRef}` | Drag-to-position with localStorage persistence |
| `useKeyboardShortcuts` | `(shortcuts, enabled?) → void` | Keyboard shortcut binding (e.g., `alt+t`, `escape`) |
| `useMarketData` | `(symbol, {pollInterval}) → {quote, candles, isLoading, refetch, fetchCandles}` | Quote polling + OHLCV candle fetching |
| `useOrders` | `(symbol) → {form, setForm, setSide, totalCost, isSubmitting, submitOrder}` | Order form state management + submission |
| `useSearch` | `(endpoint, resultKey, delay) → {query, setQuery, results, isSearching, clear}` | Debounced search with AbortController |
| `useWebSocket` | `() → {status, subscribe, unsubscribe}` | WebSocket connection with auto-reconnect + exponential backoff (30s cap) + heartbeat (30s) + message routing to stores |

---

## 21. Frontend Strategy Engine (Client-Side)

A fully client-side strategy engine that runs technical analysis on candle data in the browser. Independent from the backend algo system.

### Indicators (14)
SMA, EMA, RSI, MACD, Bollinger Bands, ATR, ADX, Stochastic, CCI, HMA (Hull Moving Average), Ichimoku Cloud, Supertrend, VWAP, Williams %R

### Strategies (16)
SMA Crossover, EMA Crossover, RSI Momentum, MACD Histogram, Bollinger Bands, ADX Trend, ATR Breakout, Stochastic Oscillator, CCI Reversal, HMA Trend, Ichimoku Cloud, Supertrend, VWAP, Williams %R, Multi-Indicator Consensus, Custom Weighted

### Engine
`strategyEngine.js` — Runs all enabled strategies (from `useStrategyStore.enabledMap`) against candle data, returns weighted confidence scores and per-strategy results.

### UI
`StrategyDock` — Floating draggable panel showing enabled strategies, their signals (BUY/SELL/HOLD), confidence bars, and mini trend chart.

---

## 22. Complete API Surface

### Auth
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` | Create account + auto-create portfolio |
| POST | `/api/auth/login` | JWT exchange (optional 2FA) |
| GET | `/api/auth/me` | Current user profile |
| POST | `/api/auth/2fa/setup` | Generate TOTP secret + QR |
| POST | `/api/auth/2fa/verify` | Enable 2FA |
| POST | `/api/auth/2fa/disable` | Disable 2FA |
| POST | `/api/auth/refresh` | Exchange refresh → access token |
| POST | `/api/auth/logout` | Revoke session by JTI |

### Market Data
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/market/quote/{symbol}` | Live quote |
| GET | `/api/market/search?q=` | Stock search (NSE + Zebu) |
| GET | `/api/market/history/{symbol}?period=&interval=` | OHLCV candles |
| GET | `/api/market/indices` | Nifty 50, Bank Nifty, etc. |
| GET | `/api/market/ticker` | All indices + popular stocks |
| GET | `/api/market/popular` | Popular stocks list |
| GET | `/api/market/batch?symbols=` | Multi-symbol quotes |
| GET | `/api/market/provider/health` | Provider status |

### Orders
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/orders` | Place order (MARKET/LIMIT/STOP) |
| GET | `/api/orders` | List orders (filter by status) |
| GET | `/api/orders/{id}` | Get single order |
| DELETE | `/api/orders/{id}` | Cancel order |

### Portfolio
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/portfolio` | Full summary |
| GET | `/api/portfolio/holdings` | Holdings list |
| GET | `/api/portfolio/summary` | Summary + holdings |

### Watchlists
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/watchlist` | List all watchlists |
| POST | `/api/watchlist` | Create watchlist |
| PATCH | `/api/watchlist/{id}` | Rename |
| DELETE | `/api/watchlist/{id}` | Delete |
| POST | `/api/watchlist/{id}/items` | Add symbol |
| DELETE | `/api/watchlist/{id}/items/{itemId}` | Remove symbol |

### Algo Trading
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/algo/strategies` | List strategies |
| POST | `/api/algo/strategies` | Create strategy |
| PUT | `/api/algo/strategies/{id}` | Update parameters |
| DELETE | `/api/algo/strategies/{id}` | Delete (must be inactive) |
| PUT | `/api/algo/strategies/{id}/toggle` | Activate/deactivate |
| GET | `/api/algo/strategies/{id}/logs` | Audit trail |

### ZeroLoss
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/zeroloss/status` | Strategy status + confidence |
| POST | `/api/zeroloss/toggle` | Enable/disable |
| GET | `/api/zeroloss/signal?symbol=` | Latest signal |
| GET | `/api/zeroloss/signals?limit=&symbol=` | Signal history |
| GET | `/api/zeroloss/performance?days=` | Daily performance |
| GET | `/api/zeroloss/positions` | Active positions |
| PUT | `/api/zeroloss/config` | Update config |
| GET | `/api/zeroloss/debug/status` | Debug endpoint |
| GET | `/api/zeroloss/debug/scan?symbol=` | Test single scan |

### User
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/user/profile` | Profile data |
| PUT | `/api/user/profile` | Update profile |
| PUT | `/api/user/password` | Change password |
| POST | `/api/user/avatar` | Upload avatar (max 2MB) |
| DELETE | `/api/user/avatar` | Delete avatar |

### Broker
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/broker/zebu/connect` | Get OAuth redirect URL |
| POST | `/api/broker/zebu/callback` | Handle OAuth callback |
| DELETE | `/api/broker/zebu/disconnect` | Revoke connection |
| POST | `/api/broker/zebu/login` | QuickAuth login |
| GET | `/api/broker/status` | Connection status |
| POST | `/api/broker/zebu/manual-token` | Manual token injection |

### Health
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Root health check |
| GET | `/api/health` | Enhanced health (worker stats) |

### WebSocket
| Path | Purpose |
|------|---------|
| `WS /ws/{client_id}?token={jwt}` | Real-time updates (quotes, orders, portfolio, algo) |

---

## 23. Environment Variables

### Production (.env on server)
| Variable | Required | Purpose |
|----------|----------|---------|
| `POSTGRES_DB` | Yes (default: alphasync) | Database name |
| `POSTGRES_USER` | Yes (default: alphasync) | Database user |
| `POSTGRES_PASSWORD` | **Yes (no default)** | Database password |
| `REDIS_PASSWORD` | **Yes (no default)** | Redis password |
| `JWT_SECRET_KEY` | **Yes (no default)** | JWT signing key |
| `BROKER_ENCRYPTION_KEY` | **Yes (no default)** | AES-256-GCM key for broker tokens |
| `SIMULATION_MODE` | No (default: false) | Allow trading outside market hours |
| `CORS_ORIGINS` | Hardcoded in compose | Allowed origins JSON array |
| `ZEBU_WS_URL` | No (default: wss://go.mynt.in/NorenWSTP/) | Zebu WebSocket endpoint |
| `ZEBU_API_URL` | No (default: https://go.mynt.in/NorenWClientTP) | Zebu REST endpoint |
| `ZEBU_API_SECRET` | No | Zebu API key |
| `ZEBU_VENDOR_CODE` | No | Zebu vendor code |
| `ZEBU_REDIRECT_URI` | Hardcoded to production URL | OAuth redirect |

### Backend Settings (config/settings.py)
| Setting | Default |
|---------|---------|
| DB_POOL_SIZE | 20 |
| DB_MAX_OVERFLOW | 10 |
| DB_POOL_RECYCLE | 3600s |
| JWT_ALGORITHM | HS256 |
| JWT_ACCESS_TOKEN_EXPIRE_MINUTES | 60 |
| JWT_REFRESH_TOKEN_EXPIRE_DAYS | 7 |
| DEFAULT_VIRTUAL_CAPITAL | ₹10,00,000 |
| MARKET_DATA_CACHE_SECONDS | 15 |
| PRICE_STREAM_INTERVAL | 3.0s |
| WORKER_MARKET_DATA_INTERVAL | 3.0s |
| WORKER_ORDER_EXECUTION_INTERVAL | 5.0s |
| WORKER_ALGO_STRATEGY_INTERVAL | 30.0s |
| RISK_MAX_POSITION_SIZE | 500 |
| RISK_MAX_CAPITAL_PER_TRADE | ₹2,00,000 |
| RISK_MAX_PORTFOLIO_EXPOSURE | 80% |
| RISK_MAX_DAILY_LOSS | ₹50,000 |
| RISK_MAX_OPEN_ORDERS | 20 |

---

## 24. CI/CD Pipeline

### GitHub Actions Workflow
**Trigger**: Push to `main` branch or manual dispatch

#### Stage 1: Build
- Checkout code
- Login to GitHub Container Registry (ghcr.io)
- Setup Docker Buildx
- Build + push backend image (`ghcr.io/netguy001/alphasync-backend:{sha}` + `:latest`)
- Build + push frontend image (`ghcr.io/netguy001/alphasync-frontend:{sha}` + `:latest`)
- GitHub Actions cache for layer caching (`type=gha`)

#### Stage 2: Deploy (only on main)
- SCP `docker-compose.prod.yml` + `deploy/` to `/opt/alphasync/alpha_zebu/`
- SSH into server:
  1. `docker login ghcr.io` with `GHCR_TOKEN`
  2. `docker compose pull` (download new images)
  3. `docker compose up -d --remove-orphans` (zero-downtime restart)
  4. `docker compose exec -T backend alembic upgrade head` (run migrations)
  5. `docker image prune -f` (clean old images)
  6. Health checks: `curl http://127.0.0.1:8000/api/health` and `curl http://127.0.0.1:3000`
  7. On failure: dump backend logs (tail 50) and exit 1

### Required GitHub Secrets
| Secret | Purpose |
|--------|---------|
| `SERVER_HOST` | VPS IP (95.111.252.225) |
| `SERVER_USER` | SSH user (root) |
| `SERVER_SSH_KEY` | SSH private key |
| `GHCR_TOKEN` | GitHub PAT (read:packages + write:packages) |
