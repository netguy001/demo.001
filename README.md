<p align="center">
  <img src="frontend/public/logo.png" alt="AlphaSync Logo" height="60" />
</p>

<h1 align="center">AlphaSync — Virtual Stock Trading Platform</h1>

<p align="center">
  <strong>Practice stock trading with ₹10,00,000 virtual money. Zero risk. Real-time market data via Zebu/MYNT. Professional tools.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/FastAPI-0.109-009688?logo=fastapi&logoColor=white" />
  <img src="https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Zustand-5-orange" />
  <img src="https://img.shields.io/badge/TailwindCSS-3-06B6D4?logo=tailwindcss&logoColor=white" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/License-Private-red" />
</p>

---

## 📖 What is AlphaSync?

AlphaSync is a **virtual (paper) trading platform** for the Indian stock market. Think of it as a **flight simulator, but for trading stocks**.

- You get **₹10,00,000 of virtual money** when you sign up — completely free
- You can **buy and sell real Indian stocks** (NIFTY 50, SENSEX, etc.) using **real-time market prices** streamed directly from the **Zebu/MYNT** WebSocket feed
- Your money is virtual, so there's **zero financial risk** — but the experience is exactly like real trading
- It includes **professional-grade charts**, **automated trading bots**, and a unique **ZeroLoss strategy** that guarantees no net losses
- **Broker integration** via Zebu OAuth gives you real-time live data feeds with per-user sessions

**Who is it for?**
- 🎓 **Students** learning how the stock market works
- 📈 **Beginners** who want to practice before investing real money
- 🤖 **Traders** who want to test automated strategies safely
- 👨‍🏫 **Instructors** teaching finance and trading

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR BROWSER                             │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              Frontend (React 18 + Vite 5)               │   │
│   │                                                         │   │
│   │  Landing → Login/Register → Select Mode → Select Broker │   │
│   │                      ↓ (OAuth Callback)                 │   │
│   │  ┌───────────┬──────────────┬──────────────────────┐    │   │
│   │  │ Dashboard  │   Trading    │  Portfolio / Algo /  │    │   │
│   │  │ Workspace │   Workspace  │  ZeroLoss / Settings │    │   │
│   │  └───────────┴──────────────┴──────────────────────┘    │   │
│   └──────────────────────┬──────────────────────────────────┘   │
│                          │                                      │
│           REST API calls + WebSocket (real-time)                │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                   BACKEND SERVER (FastAPI 2.0)                  │
│                                                                 │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│   │   Auth   │  │  Market  │  │ Trading  │  │   Strategy   │   │
│   │ Service  │  │   Data   │  │  Engine  │  │   Engines    │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                                 │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│   │   Risk   │  │  Event   │  │Background│  │  WebSocket   │   │
│   │  Engine  │  │   Bus    │  │ Workers  │  │   Manager    │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                                 │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│   │  Broker  │  │  Broker  │  │  Broker  │  │   Symbol     │   │
│   │   Auth   │  │ Sessions │  │  Safety  │  │   Mapper     │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                                 │
│         ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│         │ Database  │  │  Redis   │  │  Broker  │               │
│         │PostgreSQL/│  │  Cache   │  │  Crypto  │               │
│         │  SQLite   │  │          │  │ AES-256  │               │
│         └──────────┘  └──────────┘  └──────────┘               │
└─────────────────────────────────────────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │ Zebu / MYNT │
                    │  WebSocket  │
                    │ (Live NSE   │
                    │   Prices)   │
                    └─────────────┘
```

### In Simple Terms

| Part | What It Does | Like... |
|------|-------------|---------|
| **Frontend** | The app you see and interact with in your browser | The dashboard of a car |
| **Backend** | The brain that processes all your trades and data | The engine under the hood |
| **Database** | Stores all your data — account, trades, portfolio | Your filing cabinet |
| **Redis** | High-speed cache for live stock prices across all users | A shared whiteboard everyone reads from |
| **Zebu/MYNT** | Provides real-time stock prices from NSE via WebSocket | A live radio broadcast from the exchange |
| **WebSocket** | Pushes live price updates to your screen instantly | A live notification channel |
| **Event Bus** | Internal messaging system that coordinates everything | A post office routing mail between departments |
| **Broker Safety** | Blocks any real order placement — market data only | A security guard at the trading desk |

---

## 🔄 How It Works — The User Journey

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Landing  │────▶│ Register │────▶│  Select  │────▶│  Select  │
  │   Page   │     │ /Login   │     │   Mode   │     │  Broker  │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
                                                           │
                        ┌──────────────────────────────────┘
                        ▼
  ┌──────────────────────────────────────────────────────────────┐
  │              Zebu OAuth (Broker Connection)                  │
  │                                                              │
  │  1. Redirect to Zebu login portal                            │
  │  2. User authenticates → redirected back with auth code      │
  │  3. Backend exchanges code → creates encrypted session       │
  │  4. ZebuProvider created → real-time data starts flowing     │
  └──────────────────────────────────────────────────────────────┘
                        │
                        ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    Main Application                          │
  │                                                              │
  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
  │  │ Dashboard │  │  Trading  │  │ Portfolio │  │  Settings │ │
  │  │ Workspace │  │ Workspace │  │  Manager  │  │   Page    │ │
  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │
  │                                                              │
  │  ┌───────────┐  ┌───────────┐                                │
  │  │   Algo    │  │ ZeroLoss  │                                │
  │  │  Trading  │  │ Strategy  │                                │
  │  └───────────┘  └───────────┘                                │
  └──────────────────────────────────────────────────────────────┘
```

### Step-by-Step Flow

1. **Landing Page** — See what AlphaSync offers (features, live ticker, stats)
2. **Register** — Create your account (name, email, password) → You instantly receive ₹10,00,000 virtual capital
3. **Select Trading Mode** — Choose "Demo Trading" (other modes like Live, Options, Crypto are coming soon)
4. **Select Broker** — Pick a broker (Zebull is active; Zerodha, Angel One, Upstox, Groww, Dhan coming soon)
5. **Broker OAuth** — Authenticate with Zebu to enable real-time market data streaming
6. **Dashboard** — See your portfolio value, market indices, quick stats, and recent orders
7. **Trading Terminal** — The main trading screen with charts, watchlist, and order placement
8. **Portfolio** — View all your holdings, invested value, and profit/loss
9. **Algo Trading** — Create automated trading bots using strategies like SMA, RSI, MACD
10. **ZeroLoss** — A unique AI-powered strategy that guarantees zero net losses
11. **Settings** — Profile, avatar, password, 2FA security, and theme (dark/light mode)

---

## 🖥️ Frontend Architecture

The frontend is what you see in your browser. It's built with **React 18** — a popular framework for building interactive user interfaces.

### Tech Stack

| Technology | Purpose |
|-----------|---------|
| **React 18** | Building the user interface (pages, buttons, forms) |
| **Vite 5** | Ultra-fast development server and build tool |
| **Tailwind CSS 3** | Styling — makes everything look beautiful with utility classes |
| **Zustand 5** | State management — keeps data in sync across all pages |
| **Lightweight Charts** | Professional TradingView-style candlestick charts |
| **React Router 6** | Navigation between pages without full page reloads |
| **Axios** | Communicates with the backend server |
| **React Hot Toast** | Beautiful notification popups |
| **React Icons** | Comprehensive icon library |
| **@tanstack/react-virtual** | Virtualized lists for high-performance rendering |
| **clsx + tailwind-merge** | Utility-first CSS class composition |

### Folder Structure

```
frontend/src/
│
├── pages/                    ← Full pages (one per screen)
│   ├── LandingPage.jsx          Homepage / marketing page
│   ├── LoginPage.jsx            User login with 2FA support
│   ├── RegisterPage.jsx         Account creation
│   ├── TradingModeSelectPage    Choose trading mode
│   ├── BrokerSelectPage.jsx     Choose your broker
│   ├── BrokerCallbackPage.jsx   OAuth callback handler (Zebu redirect)
│   ├── PortfolioPage.jsx        Portfolio holdings & P&L
│   ├── AlgoTradingPage.jsx      Automated trading strategies
│   ├── ZeroLossPage.jsx         ZeroLoss strategy dashboard
│   └── SettingsPage.jsx         Profile, security, theme
│
├── workspaces/               ← Advanced page layouts (replace basic pages)
│   ├── DashboardWorkspace.jsx   Main dashboard with widgets & panels
│   └── TradingWorkspace.jsx     Professional trading terminal with docking
│
├── components/               ← Reusable building blocks
│   ├── layout/                  App shell, sidebar, navbar, ticker bar
│   │   ├── AppShell.jsx            Main layout wrapper
│   │   ├── Navbar.jsx              Top navigation bar
│   │   ├── Sidebar.jsx             Side navigation
│   │   ├── MarketTickerBar.jsx     Live scrolling ticker
│   │   ├── MobileTradeBar.jsx      Mobile-optimized trade actions
│   │   ├── DockContainer.jsx       Dockable panel container
│   │   ├── ResizablePanel.jsx      Draggable resizable panels
│   │   └── ResponsiveDrawer.jsx    Mobile-friendly drawer
│   │
│   ├── trading/                 Chart, watchlist, order panel
│   │   ├── ZebuLiveChart.jsx       Real-time Zebu WebSocket chart
│   │   ├── ChartHeader.jsx         Chart controls & indicators
│   │   ├── OrderPanel.jsx          Buy/sell order form
│   │   ├── Watchlist.jsx           Stock watchlist component
│   │   └── WatchlistItem.jsx       Individual watchlist row
│   │
│   ├── portfolio/               Holdings table, P&L cards
│   │   ├── HoldingsTable.jsx       Portfolio holdings grid
│   │   ├── PnLCard.jsx             Profit & loss card
│   │   └── PortfolioSummary.jsx    Portfolio overview
│   │
│   ├── ui/                      Generic UI components
│   │   ├── Button.jsx              Styled button component
│   │   ├── Input.jsx               Form input component
│   │   ├── Modal.jsx               Dialog/modal overlay
│   │   ├── Badge.jsx               Status/label badges
│   │   ├── Skeleton.jsx            Loading skeleton placeholders
│   │   └── Tooltip.jsx             Hover tooltips
│   │
│   ├── ProtectedRoute.jsx       Blocks unauthenticated users
│   ├── ErrorBoundary.jsx        Catches & displays errors gracefully
│   └── ForceDarkMode.jsx        Forces dark theme on specific pages
│
├── panels/                   ← Dockable content panels
│   ├── PositionsPanel.jsx       Open positions table
│   ├── OrderHistoryPanel.jsx    Recent orders table
│   └── PanelContainer.jsx       Panel wrapper/host
│
├── stores/                   ← Zustand state stores (global data)
│   ├── useAuthStore.js          User login state & tokens
│   ├── useBrokerStore.js        Broker connection state & session
│   ├── useWatchlistStore.js     Multi-watchlist management
│   ├── useZeroLossStore.js      ZeroLoss strategy state
│   ├── useMarketIndicesStore.js Market ticker data (NIFTY, SENSEX, etc.)
│   └── useStrategyStore.js      Client-side strategy state
│
├── store/                    ← Additional stores
│   ├── useMarketStore.js        Live price quote cache
│   └── usePortfolioStore.js     Holdings & orders
│
├── hooks/                    ← Custom React hooks
│   ├── useWebSocket.js          Real-time price updates via WebSocket
│   ├── useMarketData.js         Fetch quotes & candle history
│   ├── useOrders.js             Order form logic & submission
│   ├── useSearch.js             Stock search with autocomplete
│   ├── useBreakpoint.js         Responsive layout detection
│   ├── useDebounce.js           Debounced values for performance
│   ├── useKeyboardShortcuts.js  Keyboard shortcut bindings
│   └── useDraggable.js          Drag-and-drop for floating panels
│
├── strategy/                 ← Client-side technical analysis engine
│   ├── engine/
│   │   └── strategyEngine.js    Aggregates 5 weighted strategies
│   ├── indicators/              14 technical indicators
│   │   ├── sma.js, ema.js, rsi.js, macd.js
│   │   ├── bollingerBands.js, vwap.js, atr.js, adx.js
│   │   ├── cci.js, stochastic.js, ichimoku.js
│   │   ├── hma.js, supertrend.js
│   │   └── index.js
│   ├── strategies/              16 strategy implementations
│   │   ├── movingAverage.js, emaCross.js, rsiMomentum.js
│   │   ├── goldenRsi.js, macdHistogram.js, bollingerStrategy.js
│   │   ├── vwapStrategy.js, atrBreakout.js, adxStrategy.js
│   │   ├── cciStrategy.js, stochasticStrategy.js
│   │   ├── ichimokuStrategy.js, hmaStrategy.js
│   │   ├── supertrendStrategy.js, trendDetector.js
│   │   └── index.js
│   └── components/
│       └── StrategyDock.jsx     Floating strategy analysis popup
│
├── services/
│   └── api.js                   Axios HTTP client with JWT auth interceptors
│
├── context/
│   ├── ThemeContext.jsx          Dark/light theme management
│   └── AuthContext.jsx          Legacy auth context
│
├── utils/
│   ├── formatters.js            Currency (₹), percent, date formatting
│   ├── validators.js            Form & order validation
│   ├── constants.js             App-wide constants & config
│   └── cn.js                    CSS class name merger (clsx + tailwind-merge)
│
├── App.jsx                   ← Root: routing, theme, providers
├── main.jsx                  ← Entry point
└── index.css                 ← Global styles & design tokens
```

### Frontend Routes

| Path | Component | Auth | Layout |
|------|-----------|------|--------|
| `/` | LandingPage | Public | Forced dark |
| `/login` | LoginPage | Public | Forced dark |
| `/register` | RegisterPage | Public | Forced dark |
| `/select-mode` | TradingModeSelectPage | Protected | Forced dark, no AppShell |
| `/select-broker` | BrokerSelectPage | Protected | Forced dark, no AppShell |
| `/broker/callback` | BrokerCallbackPage | Protected | Forced dark, no AppShell |
| `/dashboard` | DashboardWorkspace | Protected | AppShell |
| `/terminal` | TradingWorkspace | Protected | AppShell |
| `/portfolio` | PortfolioPage | Protected | AppShell |
| `/algo` | AlgoTradingPage | Protected | AppShell |
| `/zeroloss` | ZeroLossPage | Protected | AppShell |
| `/settings` | SettingsPage | Protected | AppShell |
| `*` | Redirect → `/` | — | — |

### How the Frontend Manages Data

Think of **Zustand stores** like shared notebooks that any page can read from or write to:

```
┌─────────────────────────────────────────────────────────────┐
│                     Zustand Stores (8 total)                │
│  (Shared data accessible from anywhere in the app)         │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐        │
│  │  Auth Store │  │Market Store │  │Portfolio Store│        │
│  │ • User info │  │ • Live quotes│  │ • Holdings   │        │
│  │ • JWT token │  │ • WS status │  │ • Orders     │        │
│  │ • Login/out │  │ • Prices    │  │ • P&L        │        │
│  └─────────────┘  └─────────────┘  └──────────────┘        │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐        │
│  │Watchlist    │  │ ZeroLoss   │  │ Market Index │        │
│  │Store        │  │ Store      │  │ Store        │        │
│  │ • Lists     │  │ • Signals  │  │ • NIFTY      │        │
│  │ • Symbols   │  │ • Positions│  │ • SENSEX     │        │
│  │ • Prices    │  │ • Stats    │  │ • BANKNIFTY  │        │
│  └─────────────┘  └─────────────┘  └──────────────┘        │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │Broker Store │  │Strategy    │                           │
│  │ • Connected │  │Store       │                           │
│  │ • Session   │  │ • Signals  │                           │
│  │ • Status    │  │ • Config   │                           │
│  └─────────────┘  └─────────────┘                           │
└─────────────────────────────────────────────────────────────┘
         ▲                    ▲                  ▲
         │     REST API       │    WebSocket     │   Polling
         │    (on demand)     │  (real-time)     │  (periodic)
         ▼                    ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend Server                           │
└─────────────────────────────────────────────────────────────┘
```

### Client-Side Strategy Engine

AlphaSync includes a **strategy analysis engine that runs entirely in your browser** — no server needed:

| Category | What's Included |
|----------|----------------|
| **14 Technical Indicators** | SMA, EMA, RSI, MACD, Bollinger Bands, VWAP, ATR, ADX, CCI, Stochastic, Ichimoku, HMA, Supertrend |
| **16 Trading Strategies** | Moving Average Cross, EMA Cross, RSI Momentum, Golden RSI, MACD Histogram, Bollinger Bands, VWAP, ATR Breakout, ADX, CCI, Stochastic, Ichimoku, HMA, Supertrend, Trend Detector |
| **5 Core Engine Strategies** | EMA Cross (25%), RSI Momentum (20%), Volume-Price (15%), Golden RSI (20%), Trend Detector (20%) |

The engine scores each strategy independently and combines them into an overall **BULLISH / BEARISH / NEUTRAL** signal with a confidence percentage.

### Theme System

| Pages | Theme |
|-------|-------|
| Landing, Login, Register, Mode Select, Broker Select, Broker Callback | **Always dark mode** (forced) |
| Dashboard, Terminal, Portfolio, Algo, ZeroLoss, Settings | **User's choice** (dark or light toggle in navbar) |

---

## ⚙️ Backend Architecture

The backend is the **server** that runs on your computer (or in the cloud). It handles all the heavy lifting — processing trades, fetching market data, running algorithms, and storing your data.

### Tech Stack

| Technology | Purpose |
|-----------|---------|
| **FastAPI** (Python) | Web framework — handles API requests |
| **SQLAlchemy** | Database toolkit — reads/writes to the database |
| **SQLite** (dev) / **PostgreSQL** (prod) | Stores all user data, trades, portfolios |
| **Redis 7** | High-speed cache for live stock prices + pub/sub |
| **Zebu/MYNT WebSocket** | Real-time NSE stock prices via broker feed |
| **JWT (JSON Web Tokens)** | Secure authentication tokens |
| **bcrypt** | Password hashing (encryption) |
| **pyotp** | Two-factor authentication (2FA) with TOTP codes |
| **cryptography** | AES-256-GCM encryption for broker tokens |
| **WebSocket** | Pushes real-time updates to the browser |
| **httpx / aiohttp** | Async HTTP clients for external APIs |

### Folder Structure

```
backend/
│
├── main.py                   ← Application entry point (v2.0.0)
│                                Starts server, registers routes,
│                                launches background workers,
│                                restores broker sessions
│
├── config/
│   └── settings.py              All configuration (DB, JWT, Zebu, Redis,
│                                broker encryption, risk limits, intervals)
│
├── database/
│   └── connection.py            Database engine setup & session management
│
├── cache/
│   └── redis_client.py          Redis price cache (per-symbol + batch)
│                                Key pattern: alphasync:price:{symbol}
│
├── providers/                ← Market data provider system
│   ├── base.py                  Abstract MarketProvider class + Quote model
│   ├── factory.py               Create per-user ZebuProvider instances
│   ├── zebu_provider.py         Zebu/MYNT WebSocket provider (1000+ lines)
│   │                            Real-time ticks, auto-reconnect, heartbeat
│   └── symbol_mapper.py         Canonical ↔ Zebu token mapping
│
├── routes/                   ← API endpoints (9 routers)
│   ├── auth.py                  Login, register, 2FA, logout
│   ├── market.py                Stock quotes, search, history, indices
│   ├── orders.py                Place, list, cancel orders
│   ├── portfolio.py             Portfolio summary, holdings
│   ├── user.py                  Profile, avatar, password change
│   ├── algo.py                  Create & manage algo strategies
│   ├── watchlist.py             Watchlist CRUD operations
│   ├── zeroloss.py              ZeroLoss strategy endpoints
│   └── broker.py                Zebu OAuth connect/callback/disconnect
│
├── models/                   ← Database table definitions
│   ├── user.py                  Users, sessions, 2FA
│   ├── order.py                 Buy/sell orders
│   ├── portfolio.py             Portfolio, holdings, transactions
│   ├── algo.py                  Algo strategies, trades, logs
│   ├── watchlist.py             Watchlists and items
│   └── broker.py                Broker accounts (encrypted tokens)
│
├── services/                 ← Business logic (10 services)
│   ├── auth_service.py          Password hashing, JWT, 2FA utilities
│   ├── market_data.py           Market data integration + Redis caching
│   ├── trading_engine.py        Order placement & execution logic
│   ├── portfolio_service.py     Portfolio calculations with live prices
│   ├── algo_engine.py           Algo strategy CRUD operations
│   ├── nse_stocks.py            Database of ~280 NSE stocks
│   ├── broker_auth.py           Zebu OAuth lifecycle (connect → token → session)
│   ├── broker_session.py        Per-user ZebuProvider registry & health checks
│   ├── broker_crypto.py         AES-256-GCM token encryption/decryption
│   └── broker_safety.py         Safety guards — blocks real order endpoints
│
├── engines/                  ← Computation engines
│   ├── indicators.py            Technical indicators (SMA, EMA, RSI, MACD, etc.)
│   ├── signals.py               Strategy signal generation (BUY/SELL/HOLD)
│   ├── risk_engine.py           Pre-trade risk validation
│   └── market_session.py        NSE trading hours & holiday calendar (2026)
│
├── workers/                  ← Background tasks (run continuously)
│   ├── market_worker.py         Fetches live prices every 3 seconds
│   ├── order_worker.py          Checks pending orders every 5 seconds
│   ├── algo_worker.py           Runs algo strategies every 30 seconds
│   └── portfolio_worker.py      Recalculates portfolio on order fills
│
├── strategies/
│   └── zeroloss/             ← ZeroLoss strategy module
│       ├── controller.py        Main orchestrator (background loop)
│       ├── confidence_engine.py Score calculator (0-100)
│       ├── signal_generator.py  Trade signal creator
│       ├── breakeven_manager.py Cost calculator for zero-loss stops
│       ├── models.py            ZeroLoss database tables
│       └── migration.sql        Database migration script
│
├── websocket/
│   └── manager.py               Real-time WebSocket connection manager
│
├── core/
│   ├── event_bus.py             Internal messaging system (22 event types)
│   └── rate_limiter.py          API request throttling per-IP
│
├── tools/
│   └── force_entry_test.py      Development testing utility
│
├── uploads/avatars/             User avatar uploads
├── Dockerfile                   Container configuration
└── requirements.txt             Python dependencies
```

### Broker Integration — Per-User Provider Architecture

AlphaSync uses a **per-user provider model** — each authenticated user gets their own dedicated `ZebuProvider` instance for real-time market data:

```
  User A ──── OAuth ────▶ ZebuProvider A ──── WebSocket ────▶ Zebu/MYNT
  User B ──── OAuth ────▶ ZebuProvider B ──── WebSocket ────▶ Zebu/MYNT
  User C ──── OAuth ────▶ ZebuProvider C ──── WebSocket ────▶ Zebu/MYNT
                                │
                                ├──▶ Redis Cache (shared price data)
                                │
                                └──▶ Safety Layer (blocks real orders)
```

**OAuth Flow:**
1. Frontend calls `GET /api/broker/zebu/connect` → gets redirect URL
2. User logs in at Zebu's portal
3. Zebu redirects back to `/broker/callback` with auth code
4. Backend exchanges code for session token via QuickAuth
5. Token encrypted with **AES-256-GCM** and stored in DB
6. `ZebuProvider` created for that user, auto-subscribes to popular symbols
7. Real-time WebSocket prices start flowing

**Alternative:** Direct login via `POST /api/broker/zebu/login` (QuickAuth API, no SSO redirect)

**Safety System — Market Data Only:**
- ✅ **Whitelisted** (allowed): QuickAuth, GetQuotes, SearchScrip, GetTimePriceSeries, etc.
- ❌ **Blocklisted** (blocked): PlaceOrder, CancelOrder, Funds, Transfer, ModifyOrder, etc.
- `SafeHttpClient` wrapper enforces guards on every HTTP request
- `is_safe_websocket_message()` validates outbound WS messages
- System is designed for **market data consumption only** — never places real orders

### How the Backend Processes a Trade

Here's what happens step-by-step when you click "BUY" on a stock:

```
  You click "BUY 10 shares of RELIANCE"
                    │
                    ▼
  ┌──────────────────────────────────┐
  │     1. API receives order        │  ← POST /api/orders
  │     (routes/orders.py)           │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │     2. Risk Engine validates     │  ← Is it safe to trade?
  │     • Position size ≤ 500 shares │
  │     • Capital per trade ≤ ₹2L    │
  │     • Portfolio exposure ≤ 80%   │
  │     • Daily loss limit ≤ ₹50K   │
  │     • Open orders ≤ 20          │
  └──────────────────┬───────────────┘
                     │ ✅ Passed
                     ▼
  ┌──────────────────────────────────┐
  │     3. Trading Engine executes   │
  │     • Fetches live price (Redis) │
  │     • MARKET order → fills now   │
  │     • LIMIT order → stays open   │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │     4. Portfolio updated         │
  │     • Capital deducted           │
  │     • Holding added/updated      │
  │     • Transaction recorded       │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │     5. Events emitted            │
  │     • ORDER_FILLED → WebSocket   │  ← You see it instantly
  │     • PORTFOLIO_UPDATED          │
  └──────────────────────────────────┘
```

### Background Workers — The Silent Engines

These run continuously in the background, keeping everything up to date:

| Worker | What It Does | How Often |
|--------|-------------|-----------|
| **Market Data Worker** | Fetches/streams live stock prices via Zebu WebSocket | Every **3 seconds** during market hours |
| **Order Execution Worker** | Checks if any pending LIMIT/STOP-LOSS orders should be filled | Every **5 seconds** |
| **Algo Strategy Worker** | Runs your automated trading bots (SMA, RSI, MACD strategies) | Every **30 seconds** |
| **Portfolio Worker** | Recalculates your portfolio value when orders fill | On every **order fill** event |
| **ZeroLoss Controller** | Scans for ZeroLoss trade signals and monitors active positions | Every **30 seconds** |
| **Broker Health Check** | Monitors broker session token expiry and connectivity | Every **5 minutes** |

### Event Bus — The Internal Post Office

All workers communicate through an **Event Bus** (like an internal messaging system):

```
  Market Worker ──── PRICE_UPDATED ─────┐
                                        │
  Order Worker ──── ORDER_FILLED ───────┤
                                        ├──▶ Event Bus ──▶ WebSocket ──▶ Your Browser
  Algo Worker ──── ALGO_TRADE ──────────┤         │
                                        │         ├──▶ Portfolio Worker
  ZeroLoss ──── ZEROLOSS_SIGNAL ────────┘         │
                                                  └──▶ Database
```

**22 event types** are supported:

| Category | Events |
|----------|--------|
| **Market** | PRICE_UPDATED, MARKET_STATE_CHANGE |
| **Orders** | ORDER_PLACED, ORDER_FILLED, ORDER_PARTIALLY_FILLED, ORDER_CANCELLED, ORDER_REJECTED, ORDER_EXPIRED |
| **Portfolio** | PORTFOLIO_UPDATED |
| **Algo** | ALGO_SIGNAL, ALGO_TRADE, ALGO_ERROR, ALGO_STATE_CHANGE |
| **Risk** | RISK_BREACH, RISK_KILL_SWITCH |
| **Auth** | USER_LOGIN, USER_LOGOUT |
| **System** | SYSTEM_STARTUP, SYSTEM_SHUTDOWN |

### Risk Engine — Your Safety Net

Every single order (manual or automated) must pass through the Risk Engine:

| Rule | Limit | What It Prevents |
|------|-------|-----------------|
| Max shares per order | 500 | Overly large positions |
| Max capital per trade | ₹2,00,000 | Putting too much into one trade |
| Portfolio exposure limit | 80% | Always keep 20% cash reserve |
| Daily loss limit | ₹50,000 | Prevents catastrophic daily losses |
| Max open orders | 20 | Keeps orders manageable |
| Kill switch | On/Off | Emergency stop for all algo trading |

### Redis Cache Architecture

Live stock prices are cached in Redis for high-speed access across all user sessions:

| Key Pattern | Content | TTL |
|-------------|---------|-----|
| `alphasync:price:{symbol}` | JSON quote data | 120s |
| `alphasync:price:{symbol}:ts` | Unix timestamp | 120s |
| `alphasync:subscriptions` | SET of subscribed symbols | No TTL |
| `alphasync:provider:status` | Provider health JSON | 60s |
| `alphasync:price:all` | HASH of all symbol quotes (batch reads) | — |

- Connection pool: 20 max connections, 5s timeout
- Graceful fallback if Redis unavailable (returns None, logs warning)
- Pipeline-based batch operations for efficiency

---

## 🤖 ZeroLoss Strategy — How It Works

ZeroLoss is a unique **intraday (same-day) trading strategy** that guarantees you never lose money on a trade. Here's the concept in simple terms:

### The Core Idea

> When you buy a stock, your stop-loss (the price at which you sell to cut losses) is set at your **exact break-even point** — the price where you'd recover all trading costs. So the worst-case scenario is **₹0 loss**.

### How It Scores Confidence (0-100)

Before entering any trade, ZeroLoss calculates a **confidence score** by analyzing 6 factors:

| Factor | Max Points | What It Measures |
|--------|-----------|-----------------|
| **EMA Stack** | 25 pts | Are moving averages aligned? (Trending vs sideways) |
| **RSI Zone** | 20 pts | Is the stock overbought or in a sweet spot? |
| **MACD Momentum** | 15 pts | Is momentum building in the right direction? |
| **Volume** | 15 pts | Are enough people trading this stock? |
| **Volatility (VIX)** | 15 pts | Is the overall market calm or panicking? |
| **Support/Resistance** | 10 pts | Is the stock near a key price level? |

**Threshold**: A trade is only taken when confidence ≥ **60/100** (configurable, default 75 in production).

### The Break-Even Math

When you buy a stock, you pay several **hidden costs** (brokerage, taxes, exchange fees). ZeroLoss calculates ALL of them:

| Cost Component | Rate |
|---------------|------|
| Brokerage | ₹20 or 0.03% (whichever is higher) |
| STT (Securities Transaction Tax) | 0.1% per side |
| Exchange charges | 0.00345% |
| SEBI fee | 0.0001% |
| GST | 18% on brokerage + charges |
| Stamp duty | 0.015% (buy only) |
| Slippage buffer | 0.01% |
| **Total round-trip cost** | **~0.25%** |

Your **stop-loss = entry price − total cost per share** (for buy trades), so the worst case is breaking even after all fees.

### ZeroLoss Workflow

```
  Every 30 seconds:
  ┌─────────────────────────────────┐
  │  1. Monitor active positions    │ ← Check if SL or target hit
  │     → Auto-close at 3:20 PM    │
  ├─────────────────────────────────┤
  │  2. Scan watchlist symbols      │ ← Fetch 1-year daily candles
  │     → Calculate 6-factor score  │
  ├─────────────────────────────────┤
  │  3. Score ≥ threshold? → Trade  │ ← Place order with exact
  │     Score < threshold? → Skip   │   SL and target prices
  └─────────────────────────────────┘
```

---

## 📊 Database Schema

All your data is stored in organized tables:

```
┌──────────────────────────────────────────────────────────────┐
│                        DATABASE                              │
│                                                              │
│  ┌──────────┐     ┌──────────┐     ┌──────────────┐         │
│  │  users   │────▶│portfolios│────▶│   holdings   │         │
│  │          │     │          │     │              │         │
│  │ email    │     │ capital  │     │ symbol       │         │
│  │ username │     │ value    │     │ quantity     │         │
│  │ password │     │ P&L      │     │ avg_price    │         │
│  │ capital  │     └──────────┘     │ current_val  │         │
│  └──────────┘                      └──────────────┘         │
│       │                                                      │
│       │         ┌──────────┐     ┌──────────────┐           │
│       ├────────▶│  orders  │────▶│ transactions │           │
│       │         │          │     │              │           │
│       │         │ symbol   │     │ type (BUY/   │           │
│       │         │ side     │     │       SELL)  │           │
│       │         │ quantity │     │ quantity     │           │
│       │         │ status   │     │ price        │           │
│       │         └──────────┘     └──────────────┘           │
│       │                                                      │
│       │         ┌──────────┐     ┌──────────────┐           │
│       ├────────▶│algo_     │────▶│ algo_trades  │           │
│       │         │strategies│     │ algo_logs    │           │
│       │         └──────────┘     └──────────────┘           │
│       │                                                      │
│       │         ┌──────────┐     ┌──────────────┐           │
│       ├────────▶│watchlists│────▶│watchlist_items│           │
│       │         └──────────┘     └──────────────┘           │
│       │                                                      │
│       │         ┌──────────────┐  ┌──────────────┐           │
│       ├────────▶│user_sessions │  │two_factor_   │           │
│       │         └──────────────┘  │auth          │           │
│       │                           └──────────────┘           │
│       │                                                      │
│       │         ┌───────────────────────────┐                │
│       └────────▶│    broker_accounts        │                │
│                 │ broker (zebu)             │                │
│                 │ broker_user_id            │                │
│                 │ access_token_enc (AES)    │                │
│                 │ refresh_token_enc (AES)   │                │
│                 │ token_expiry              │                │
│                 │ is_active                 │                │
│                 │ extra_data_enc (AES JSON) │                │
│                 └───────────────────────────┘                │
│                                                              │
│  ┌──────────────────┐  ┌─────────────────────┐              │
│  │zeroloss_signals  │  │zeroloss_performance │              │
│  │ confidence_score │  │ total_trades        │              │
│  │ direction        │  │ profit_trades       │              │
│  │ entry/SL/target  │  │ breakeven_trades    │              │
│  └──────────────────┘  │ net_pnl             │              │
│                        └─────────────────────┘              │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔌 API Reference

All backend endpoints organized by category (45+ endpoints across 9 routers):

### Authentication (`/api/auth`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| POST | `/register` | Create new account |
| POST | `/login` | Sign in (supports 2FA) |
| GET | `/me` | Get current user profile |
| POST | `/2fa/setup` | Set up two-factor auth |
| POST | `/2fa/verify` | Verify 2FA code |
| POST | `/2fa/disable` | Turn off 2FA |
| POST | `/refresh` | Refresh login token |
| POST | `/logout` | Sign out |

### Market Data (`/api/market`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/quote/{symbol}` | Get live price for a stock |
| GET | `/search?q=` | Search for stocks by name |
| GET | `/history/{symbol}` | Get price history (candles) |
| GET | `/indices` | NIFTY 50, SENSEX, BANKNIFTY, NIFTY IT |
| GET | `/ticker` | All indices + popular stocks for ticker bar |
| GET | `/popular` | List of 20 popular Indian stocks |
| GET | `/batch?symbols=` | Get prices for multiple stocks at once |

### Orders (`/api/orders`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| POST | `/` | Place a new order |
| GET | `/` | List your orders |
| GET | `/{order_id}` | Get specific order details |
| DELETE | `/{order_id}` | Cancel a pending order |

### Portfolio (`/api/portfolio`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/` | Portfolio summary with live P&L |
| GET | `/holdings` | All your stock holdings |
| GET | `/summary` | Combined summary + holdings |

### User Profile (`/api/user`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/profile` | Your profile info |
| PUT | `/profile` | Update name, phone, avatar |
| PUT | `/password` | Change password |
| POST | `/avatar` | Upload profile picture |
| DELETE | `/avatar` | Remove profile picture |

### Algo Trading (`/api/algo`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/strategies` | List your algo strategies |
| POST | `/strategies` | Create a new strategy |
| PUT | `/strategies/{id}/toggle` | Start/stop a strategy |
| PUT | `/strategies/{id}` | Update strategy settings |
| DELETE | `/strategies/{id}` | Delete a strategy |
| GET | `/strategies/{id}/logs` | View strategy execution logs |

### Watchlist (`/api/watchlist`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/` | List all your watchlists |
| POST | `/` | Create a new watchlist |
| PATCH | `/{id}` | Rename a watchlist |
| DELETE | `/{id}` | Delete a watchlist |
| POST | `/{id}/items` | Add a stock to a watchlist |
| DELETE | `/{id}/items/{item_id}` | Remove a stock |

### ZeroLoss (`/api/zeroloss`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/status` | Strategy state & confidence scores |
| POST | `/toggle` | Enable/disable ZeroLoss |
| GET | `/signal` | Latest signal for symbol(s) |
| GET | `/signals` | Signal history (paginated) |
| GET | `/performance` | Daily performance summary |
| GET | `/positions` | Active ZeroLoss positions |
| PUT | `/config` | Update strategy configuration |

### Broker (`/api/broker`)
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/zebu/connect` | Generate Zebu OAuth redirect URL |
| POST | `/zebu/callback` | Exchange auth code for encrypted token |
| DELETE | `/zebu/disconnect` | Revoke broker connection |
| POST | `/zebu/login` | Direct Zebu login via QuickAuth (no SSO) |
| GET | `/status` | Current broker connection status |
| POST | `/zebu/manual-token` | Dev: manually inject session token |

### WebSocket
| Protocol | Endpoint | Description |
|----------|---------|-------------|
| WS | `/ws/{client_id}?token=` | Real-time updates (prices, orders, portfolio) |

### Health
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/` | Server status check |
| GET | `/api/health` | Detailed health (workers, sessions, uptime) |

---

## 🔐 Security

| Feature | Implementation |
|---------|---------------|
| **Password Storage** | bcrypt hashed (never stored in plain text) |
| **Authentication** | JWT tokens with expiry & session tracking |
| **Two-Factor Auth (2FA)** | TOTP-based (Google Authenticator compatible) |
| **Session Management** | JTI-based revocation (logout invalidates token) |
| **Rate Limiting** | Per-IP: Login 10/min, Register 5/min, API 120/min |
| **CORS** | Restricted to frontend origin only |
| **File Upload** | Avatar: JPG/PNG/GIF/WebP only, max 2MB |
| **Broker Token Encryption** | AES-256-GCM with HKDF-SHA256 key derivation |
| **Broker API Safety** | Whitelist/blocklist — only market data endpoints allowed |
| **No Real Orders** | SafeHttpClient blocks all order/fund/position modification endpoints |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and **npm** (for frontend)
- **Python** 3.11+ (for backend)
- **Redis** 7+ (for price caching)
- **Git** (to clone the repository)

### Quick Start (Development)

**1. Clone the repository**
```bash
git clone <repository-url>
cd alphasync-react
```

**2. Configure environment**
```bash
# Backend
cd backend
cp .env.example .env
# Edit .env with your Zebu API credentials (optional for basic testing)
```

**3. Start Redis** (required for live price caching)
```bash
# Using Docker:
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Or install natively:
# Windows: https://github.com/tporadowski/redis/releases
# macOS: brew install redis && redis-server
# Linux: sudo apt install redis-server && sudo systemctl start redis
```

**4. Start the Backend**
```bash
cd backend
pip install -r requirements.txt
python main.py
```
The backend API will be running at `http://localhost:8000`

**5. Start the Frontend**
```bash
cd frontend
npm install
npm run dev
```
The app will be available at `http://localhost:5173`

---

## 🐳 Docker — Production Deployment

### Architecture

Docker Compose orchestrates **4 containers** working together:

```
┌─────────────────────────────────────────────────────────┐
│                   Docker Compose                        │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Frontend │  │ Backend  │  │PostgreSQL│  │ Redis  │  │
│  │ (Nginx)  │  │ (Uvicorn)│  │    16    │  │   7    │  │
│  │ :5173    │  │  :8000   │  │  :5432   │  │ :6379  │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘  │
│       │              │             │            │        │
│       └──────────────┘             │            │        │
│         API proxy via nginx        │            │        │
│                    └───────────────┘            │        │
│                      DB connection              │        │
│                                    └────────────┘        │
│                                     Price cache          │
└─────────────────────────────────────────────────────────┘
```

### Step-by-Step Docker Setup

**1. Prerequisites**
- Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- Ensure Docker is running

**2. Configure environment variables**
```bash
# Copy the example env file (if not already done)
cp .env.example .env

# Edit .env and set your production values:
# - JWT_SECRET_KEY (generate a strong random string)
# - BROKER_ENCRYPTION_KEY (generate: python -c "import secrets; print(secrets.token_urlsafe(48))")
# - ZEBU_VENDOR_CODE (your Zebu vendor code)
# - ZEBU_API_KEY (your Zebu API key)
```

**3. Build and start all containers**
```bash
# Build and start everything
docker-compose up --build

# Or run in background (detached mode)
docker-compose up --build -d
```

**4. Access the application**
| Service | URL | Description |
|---------|-----|-------------|
| **Frontend** | http://localhost:5173 | Main application |
| **Backend API** | http://localhost:8000 | API & WebSocket server |
| **API Docs** | http://localhost:8000/docs | Swagger/OpenAPI documentation |
| **PostgreSQL** | localhost:5432 | Database (user: `alphasync`, pass: `alphasync`) |
| **Redis** | localhost:6379 | Price cache |

**5. Useful Docker commands**
```bash
# View running containers
docker-compose ps

# View logs (all services)
docker-compose logs -f

# View logs (specific service)
docker-compose logs -f backend
docker-compose logs -f frontend

# Stop all containers
docker-compose down

# Stop and remove all data (clean slate)
docker-compose down -v

# Rebuild a specific service
docker-compose up --build backend

# Enter a running container
docker exec -it alphasync-react-backend-1 bash
docker exec -it alphasync-react-frontend-1 sh

# Check Redis cache
docker exec -it alphasync-react-redis-1 redis-cli
> KEYS alphasync:*
> GET alphasync:price:RELIANCE

# Access PostgreSQL
docker exec -it alphasync-react-db-1 psql -U alphasync -d alphasync
```

### Docker Services Detail

| Service | Image | Port | Volumes | Notes |
|---------|-------|------|---------|-------|
| **frontend** | Node 18 → Nginx | 5173→80 | — | Multi-stage build, production-optimized |
| **backend** | Python 3.11-slim | 8000 | `./backend:/app` | Hot-reload in dev via volume mount |
| **db** | postgres:16-alpine | 5432 | `pgdata` (persistent) | DB: `alphasync`, auto-created |
| **redis** | redis:7-alpine | 6379 | `redisdata` (persistent) | AOF, 256MB max, LRU eviction |

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite+aiosqlite:///./alphasync.db` | Database connection (PostgreSQL in Docker) |
| `JWT_SECRET_KEY` | `alphasync-super-secret-key-...` | **Change in production!** |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection URL |
| `BROKER_ENCRYPTION_KEY` | `alphasync-broker-encryption-...` | **Change in production!** AES-256 key |
| `ZEBU_VENDOR_CODE` | *(empty)* | Zebu API vendor code |
| `ZEBU_API_KEY` | *(empty)* | Zebu API key |
| `ZEBU_REDIRECT_URI` | `http://localhost:5173/broker/callback` | OAuth callback URL |
| `ZEBU_WS_URL` | `wss://go.mynt.in/NorenWSTP/` | Zebu WebSocket endpoint |
| `ZEBU_API_URL` | `https://go.mynt.in/NorenWClientTP` | Zebu REST API endpoint |
| `ZEROLOSS_CONFIDENCE_THRESHOLD` | `75` | Min confidence score for ZeroLoss trades |
| `ZEROLOSS_SYMBOLS` | `RELIANCE,TCS,HDFCBANK,INFY,ICICIBANK` | ZeroLoss watchlist |
| `SIMULATION_MODE` | `true` | Enable simulation mode |
| `DEFAULT_VIRTUAL_CAPITAL` | `1000000.0` | Starting capital (₹10L) |
| `MARKET_DATA_CACHE_SECONDS` | `15` | Redis price cache TTL |

---

## 📐 Design Decisions

| Decision | Reasoning |
|----------|-----------|
| **Simulation mode ON by default** | Trading works 24/7 regardless of actual NSE hours — perfect for practice |
| **Per-user broker provider** | Each user gets their own Zebu session — proper isolation, individual subscriptions |
| **Zebu/MYNT WebSocket for prices** | Real-time NSE data from broker's institutional feed, sub-second latency |
| **AES-256-GCM token encryption** | Broker tokens encrypted at rest with authenticated encryption — no plaintext storage |
| **Broker safety guards** | Whitelist/blocklist ensures the app never places real orders — market data only |
| **Redis for price cache** | Shared price cache across all user sessions — avoids redundant API calls |
| **SQLite for dev, PostgreSQL for prod** | SQLite needs zero setup for development; PostgreSQL scales for production |
| **Event-driven architecture** | Workers don't call each other directly — they communicate through events, making the system modular |
| **Client-side strategy engine** | Technical analysis runs in your browser for instant feedback without server round-trips |
| **Forced dark mode on auth pages** | Login/register pages are designed with dark aesthetics; app pages let you choose |
| **Zustand over Redux** | Simpler API, less boilerplate, built-in persistence — better for this project size |
| **Lazy-loaded pages** | Each page loads only when you navigate to it, keeping the initial load fast |
| **Workspace components** | Dashboard & Trading use "workspace" pattern — dockable, resizable panels for pro UI |

---

## 📊 Key Numbers

| Metric | Value |
|--------|-------|
| Starting virtual capital | ₹10,00,000 |
| NSE stocks supported | ~280 |
| Technical indicators | 14 (client) + 7 (server) |
| Trading strategies | 16 (client) + 4 (server) |
| API routers | 9 |
| API endpoints | 45+ |
| Backend services | 10 |
| Background workers | 5 + broker health check |
| Event types | 22 |
| Zustand stores | 8 |
| Custom hooks | 8 |
| UI components | 22+ |
| Market data refresh | Every 3 seconds |
| Order check interval | Every 5 seconds |
| Redis price TTL | 120 seconds |

---

## 📁 Project Structure (Top Level)

```
alphasync-react/
├── backend/              ← Python FastAPI server (v2.0.0)
│   ├── cache/               Redis price caching
│   ├── config/              Settings & configuration
│   ├── core/                Event bus & rate limiter
│   ├── database/            DB connection & sessions
│   ├── engines/             Technical analysis & risk
│   ├── models/              SQLAlchemy table definitions
│   ├── providers/           Market data providers (Zebu)
│   ├── routes/              9 API routers
│   ├── services/            10 business logic services
│   ├── strategies/          ZeroLoss strategy module
│   ├── websocket/           Real-time WS manager
│   ├── workers/             Background task workers
│   ├── Dockerfile           Python container
│   ├── main.py              Entry point
│   └── requirements.txt     Python dependencies
│
├── frontend/             ← React 18 + Vite 5 app
│   ├── src/
│   │   ├── pages/           12 page components
│   │   ├── workspaces/      2 advanced workspace layouts
│   │   ├── components/      22+ reusable components
│   │   ├── panels/          3 dockable panels
│   │   ├── stores/          6 Zustand stores
│   │   ├── store/           2 additional stores
│   │   ├── hooks/           8 custom React hooks
│   │   ├── strategy/        Client-side analysis engine
│   │   ├── services/        API client
│   │   ├── context/         Theme & auth contexts
│   │   └── utils/           Helper functions
│   ├── Dockerfile           Nginx container (multi-stage build)
│   ├── nginx.conf           Nginx configuration with API proxy
│   └── package.json         Node.js dependencies
│
├── docker-compose.yml    ← 4-service container orchestration
├── .env.example          ← Environment template
└── README.md             ← This file
```

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---------|----------|
| **Redis connection refused** | Ensure Redis is running: `docker run -d --name redis -p 6379:6379 redis:7-alpine` |
| **CORS errors** | Check that `CORS_ORIGINS` in settings includes your frontend URL |
| **Broker not connecting** | Verify `ZEBU_VENDOR_CODE` and `ZEBU_API_KEY` in `.env` |
| **Database locked (SQLite)** | Only one process should access SQLite; use PostgreSQL for multi-instance |
| **WebSocket disconnects** | Check browser console; ensure `/ws/` proxy is configured in Vite |
| **Docker build fails** | Run `docker-compose down -v` then `docker-compose up --build` |
| **Port already in use** | Stop other services on 8000/5173/5432/6379 or change ports in docker-compose.yml |

---

<p align="center">
  Built with ❤️ for the Indian trading community<br/>
  <strong>AlphaSync v2.0</strong> — Trade smart. Learn faster. Risk nothing.
</p>
