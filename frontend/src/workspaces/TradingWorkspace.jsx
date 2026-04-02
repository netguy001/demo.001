// ─── TradingWorkspace ────────────────────────────────────────────────────────
// CSS Grid layout: Watchlist | (ChartHeader + Chart + BottomDock) | OrderPanel
// + floating StrategyDock
// Responsive: Desktop grid → Tablet (no watchlist) → Mobile (drawers + trade bar)
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { useMarketStore } from '../store/useMarketStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { useStrategyStore } from '../stores/useStrategyStore';
import { useMarketData } from '../hooks/useMarketData';
import { useBreakpoint } from '../hooks/useBreakpoint';
import ChartHeader from '../components/trading/ChartHeader';
import ZebuLiveChart from '../components/trading/ZebuLiveChart';
import Watchlist from '../components/trading/Watchlist';
import OrderPanel from '../components/trading/OrderPanel';
import ResizablePanel from '../components/layout/ResizablePanel';
import ResponsiveDrawer from '../components/layout/ResponsiveDrawer';
import DockContainer from '../components/layout/DockContainer';
import MobileTradeBar from '../components/layout/MobileTradeBar';
import { PositionsPanel, OrderHistoryPanel } from '../panels';
import { StrategyDock } from '../strategy/components';
import { runEngine, getAvailableStrategies } from '../strategy';
import Modal from '../components/ui/Modal';
import ErrorBoundary from '../components/ErrorBoundary';
import { cn } from '../utils/cn';
import { CHART_PERIODS, DEFAULT_CHART_PERIOD, isMcxSymbol } from '../utils/constants';
import { useZeroLossStore } from '../stores/useZeroLossStore';
import { PanelLeftOpen, PanelLeftClose } from 'lucide-react';

// ── Main workspace ───────────────────────────────────────────────────────────
export default function TradingWorkspace() {
    const MIN_BOTTOM_HEIGHT = 32;
    const EXPANDED_MIN_HEIGHT = 120;
    const MAX_BOTTOM_HEIGHT = 420;
    const DEFAULT_BOTTOM_HEIGHT = 200;
    const ORDER_FLOAT_WIDTH = 360;

    const [searchParams] = useSearchParams();
    const initialSymbol = searchParams.get('symbol') || 'RELIANCE.NS';

    const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol);
    const [chartPeriod, setChartPeriod] = useState(DEFAULT_CHART_PERIOD);
    const [isTerminalFocused, setIsTerminalFocused] = useState(false);
    const [strategyDockOpen, setStrategyDockOpen] = useState(false);
    const [watchlistToggleBusy, setWatchlistToggleBusy] = useState(false);
    const [bottomCollapsed, setBottomCollapsed] = useState(false);
    const [bottomHeight, setBottomHeight] = useState(DEFAULT_BOTTOM_HEIGHT);
    const [watchlistVisible, setWatchlistVisible] = useState(true);
    const [orderPanelVisible, setOrderPanelVisible] = useState(false);
    const getDefaultOrderPanelPos = useCallback(() => ({
        x: Math.max(16, window.innerWidth - ORDER_FLOAT_WIDTH - 16),
        y: 72,
    }), [ORDER_FLOAT_WIDTH]);
    const [orderPanelPos, setOrderPanelPos] = useState(() => getDefaultOrderPanelPos());
    const orderPanelDrag = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

    // Sync selectedSymbol when URL ?symbol= changes (e.g. ticker bar click)
    useEffect(() => {
        const urlSymbol = searchParams.get('symbol');
        if (urlSymbol && urlSymbol !== selectedSymbol) {
            setSelectedSymbol(urlSymbol);
        }
        // Auto-open order panel if ?side=BUY or ?side=SELL is in the URL
        const urlSide = searchParams.get('side');
        if (urlSide === 'BUY' || urlSide === 'SELL') {
            setOrderSide(urlSide);
            setOrderSideKey((k) => k + 1);
            setOrderPanelVisible(true);
            setOrderDrawerOpen(true);
        }
    }, [searchParams]);

    // Responsive drawer states
    const [watchlistDrawerOpen, setWatchlistDrawerOpen] = useState(false);
    const [orderDrawerOpen, setOrderDrawerOpen] = useState(false);

    // Breakpoint
    const { isMobile, isCompact, isWide } = useBreakpoint();

    // ── Stores ────────────────────────────────────────────────────────────────
    const { holdings, orders, refreshPortfolio } = usePortfolioStore();
    const setGlobalSelectedSymbol = useMarketStore((s) => s.setSelectedSymbol);
    const batchUpdateQuotes = useMarketStore((s) => s.batchUpdateQuotes);

    // ── Watchlist store — FIX: use proper reactive selectors, NOT broken JS getters ──
    // The store previously had `get items()` and `get watchlistId()` as JS getters.
    // Those were removed. Now we must select raw state and derive what we need.
    const watchlists = useWatchlistStore((s) => s.watchlists);
    const activeId = useWatchlistStore((s) => s.activeId);
    const watchlistPrices = useWatchlistStore((s) => s.prices);
    const loadWatchlist = useWatchlistStore((s) => s.loadWatchlist);
    const fetchWatchlistPrices = useWatchlistStore((s) => s.fetchPrices);
    const addWatchlistItem = useWatchlistStore((s) => s.addItem);
    const removeWatchlistItem = useWatchlistStore((s) => s.removeItem);

    // Derive items safely — only recomputes when watchlists/activeId actually change
    const watchlistItems = useMemo(
        () => watchlists.find(w => w.id === activeId)?.items ?? [],
        [watchlists, activeId]
    );

    const currentWatchlistItem = useMemo(() => {
        if (!selectedSymbol) return null;
        return watchlistItems.find((item) =>
            String(item.symbol || '').toUpperCase() === String(selectedSymbol).toUpperCase()
        ) || null;
    }, [watchlistItems, selectedSymbol]);

    // Strategy store — the StrategyDock writes engine output here;
    // the chart badge reads it so both always show the same result.
    const engineOutput = useStrategyStore((s) => s.engineOutput);
    const setEngineOutput = useStrategyStore((s) => s.setEngineOutput);

    // ── Hooks ─────────────────────────────────────────────────────────────────
    const { quote, candles, isLoading: chartLoading, fetchCandles } = useMarketData(selectedSymbol);

    const zlConfidence = useZeroLossStore((s) => s.confidence[selectedSymbol] || null);
    const allSymbolQuotes = useMarketStore((s) => s.symbols);

    // ── Derived: Trend data from the shared strategy store ─────────────────
    // The StrategyDock computes engine results with user-enabled strategies
    // and writes them to the store. We read from the store here so the chart
    // badge always matches the dock. If the dock hasn't run yet (e.g. first
    // load), compute a fallback with all strategies.
    const trendData = useMemo(() => {
        if (engineOutput && engineOutput.signals?.length > 0) {
            return {
                overall: engineOutput.overall,
                confidence: engineOutput.confidence,
                weightedScore: engineOutput.weightedScore ?? 0,
            };
        }
        // Fallback: compute with all strategies if dock hasn't run yet
        if (!candles || candles.length === 0) return null;
        const strategies = getAvailableStrategies();
        const enabledIds = strategies.map((s) => s.id);
        const result = runEngine(candles, enabledIds);
        return {
            overall: result.overall,
            confidence: result.confidence,
            weightedScore: result.weightedScore ?? 0,
        };
    }, [engineOutput, candles, setEngineOutput]);

    // ── Effects ───────────────────────────────────────────────────────────────
    useEffect(() => {
        const cfg = CHART_PERIODS[chartPeriod] || CHART_PERIODS[DEFAULT_CHART_PERIOD];
        fetchCandles(cfg.period, cfg.interval);
    }, [selectedSymbol, chartPeriod, fetchCandles]);

    useEffect(() => { refreshPortfolio(); }, [refreshPortfolio]);
    useEffect(() => { loadWatchlist(); }, [loadWatchlist]);
    useEffect(() => { setGlobalSelectedSymbol(selectedSymbol); }, [selectedSymbol, setGlobalSelectedSymbol]);

    // FIX: watchlistItems is now always a valid array (never undefined).
    // Keep polling conservative; WebSocket delivers real-time updates.
    useEffect(() => {
        if (watchlistItems.length === 0) return;
        fetchWatchlistPrices();
        const id = setInterval(fetchWatchlistPrices, 15_000);
        return () => clearInterval(id);
    }, [watchlistItems, fetchWatchlistPrices]);

    useEffect(() => {
        if (Object.keys(watchlistPrices).length > 0) {
            batchUpdateQuotes(watchlistPrices);
        }
    }, [watchlistPrices, batchUpdateQuotes]);

    // Close drawers on breakpoint change to desktop
    useEffect(() => {
        if (isWide) {
            setWatchlistDrawerOpen(false);
            setOrderDrawerOpen(false);
        }
    }, [isWide]);

    const clampOrderPanelPos = useCallback((p) => ({
        x: Math.max(0, Math.min(window.innerWidth - ORDER_FLOAT_WIDTH, p.x)),
        y: Math.max(0, Math.min(window.innerHeight - 120, p.y)),
    }), [ORDER_FLOAT_WIDTH]);

    useEffect(() => {
        const handleResize = () => {
            setOrderPanelPos((p) => clampOrderPanelPos(p));
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [clampOrderPanelPos]);

    // ── Handlers ──────────────────────────────────────────────────────────────
    const [orderSide, setOrderSide] = useState(null);
    const [orderSideKey, setOrderSideKey] = useState(0);

    // Quick order modal — opens when SELL/EXIT/BUY is clicked from positions
    const [quickOrderOpen, setQuickOrderOpen] = useState(false);
    const [quickOrderSymbol, setQuickOrderSymbol] = useState(null);
    const [quickOrderSide, setQuickOrderSide] = useState(null);
    const [quickOrderKey, setQuickOrderKey] = useState(0);

    const handleSelectSymbol = useCallback((symbol) => {
        setSelectedSymbol(symbol);
        if (isCompact) setWatchlistDrawerOpen(false);
    }, [isCompact]);

    const handleToggleWatchlist = useCallback(async () => {
        if (!selectedSymbol || watchlistToggleBusy) return;
        setWatchlistToggleBusy(true);
        try {
            if (currentWatchlistItem?.id) {
                await removeWatchlistItem(currentWatchlistItem.id);
            } else {
                await addWatchlistItem(selectedSymbol, isMcxSymbol(selectedSymbol) ? 'MCX' : 'NSE');
            }
        } finally {
            setWatchlistToggleBusy(false);
        }
    }, [selectedSymbol, watchlistToggleBusy, currentWatchlistItem, addWatchlistItem, removeWatchlistItem]);

    const handleBuy = useCallback(() => {
        setOrderSide('BUY');
        setOrderSideKey((k) => k + 1);
        setOrderDrawerOpen(true);
    }, []);

    const handleSell = useCallback(() => {
        setOrderSide('SELL');
        setOrderSideKey((k) => k + 1);
        setOrderDrawerOpen(true);
    }, []);

    // Position SELL/EXIT → open quick order popup modal
    const handlePositionSell = useCallback((symbol) => {
        setQuickOrderSymbol(symbol);
        setQuickOrderSide('SELL');
        setQuickOrderKey((k) => k + 1);
        setQuickOrderOpen(true);
    }, []);

    const handlePositionBuy = useCallback((symbol) => {
        setQuickOrderSymbol(symbol);
        setQuickOrderSide('BUY');
        setQuickOrderKey((k) => k + 1);
        setQuickOrderOpen(true);
    }, []);

    const handleOrderPanelGrab = useCallback((event) => {
        if (event.target.closest('button') || event.target.closest('input')) return;
        event.preventDefault();
        orderPanelDrag.current = {
            active: true,
            sx: event.clientX,
            sy: event.clientY,
            ox: orderPanelPos.x,
            oy: orderPanelPos.y,
        };
        const onMove = (moveEvent) => {
            if (!orderPanelDrag.current.active) return;
            setOrderPanelPos(clampOrderPanelPos({
                x: orderPanelDrag.current.ox + (moveEvent.clientX - orderPanelDrag.current.sx),
                y: orderPanelDrag.current.oy + (moveEvent.clientY - orderPanelDrag.current.sy),
            }));
        };
        const onUp = () => {
            orderPanelDrag.current.active = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [orderPanelPos, clampOrderPanelPos]);

    const closeFloatingOrderPanel = useCallback(() => {
        setOrderPanelVisible(false);
        setOrderPanelPos(getDefaultOrderPanelPos());
        setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
    }, [getDefaultOrderPanelPos]);

    const openFloatingOrderPanel = useCallback((side = null) => {
        if (side) {
            setOrderSide(side);
            setOrderSideKey((k) => k + 1);
        }
        setOrderPanelPos(clampOrderPanelPos(getDefaultOrderPanelPos()));
        setOrderPanelVisible(true);
        setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
    }, [clampOrderPanelPos, getDefaultOrderPanelPos]);

    // ── Handle bottom panel collapse/expand ────────────────────────────────────
    const handleBottomPanelToggle = useCallback(() => {
        setBottomCollapsed((v) => {
            const nextCollapsed = !v;
            if (!nextCollapsed && bottomHeight < EXPANDED_MIN_HEIGHT) {
                setBottomHeight(DEFAULT_BOTTOM_HEIGHT);
            }
            return nextCollapsed;
        });
        // Trigger chart resize after layout transition completes
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 250);
    }, [bottomHeight]);

    const handleBottomResizeStart = useCallback((event) => {
        if (isCompact) return;

        event.preventDefault();
        const startY = event.clientY;
        const initialHeight = bottomCollapsed ? DEFAULT_BOTTOM_HEIGHT : bottomHeight;

        if (bottomCollapsed) {
            setBottomCollapsed(false);
        }

        const onMouseMove = (moveEvent) => {
            const delta = startY - moveEvent.clientY;
            const nextHeight = Math.max(
                MIN_BOTTOM_HEIGHT,
                Math.min(MAX_BOTTOM_HEIGHT, initialHeight + delta)
            );

            if (nextHeight <= 56) {
                setBottomCollapsed(true);
                setBottomHeight(MIN_BOTTOM_HEIGHT);
            } else {
                setBottomCollapsed(false);
                setBottomHeight(nextHeight);
            }

            window.dispatchEvent(new Event('resize'));
        };

        const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }, [bottomCollapsed, bottomHeight, isCompact]);

    // ── Dock tabs ─────────────────────────────────────────────────────────────
    const dockTabs = useMemo(() => [
        {
            key: 'positions',
            label: 'Positions',
            count: holdings.length,
            content: <PositionsPanel showHeader={false} holdings={holdings} onSell={handlePositionSell} onBuy={handlePositionBuy} />,
        },
        {
            key: 'orders',
            label: 'Orders',
            count: orders.length,
            content: <OrderHistoryPanel showHeader={false} orders={orders} />,
        },
    ], [holdings, orders]);

    // ── Shared watchlist element ───────────────────────────────────────────────
    // NOTE: Watchlist now reads everything from useWatchlistStore internally.
    // We no longer need to pass items/prices/watchlistId as props.
    const watchlistEl = (
        <Watchlist
            selectedSymbol={selectedSymbol}
            onSelectSymbol={handleSelectSymbol}
            onBuy={handlePositionBuy}
            onSell={handlePositionSell}
        />
    );

    const orderPanelEl = (
        <OrderPanel
            symbol={selectedSymbol}
            currentPrice={quote?.price ?? 0}
            isTerminalFocused={isTerminalFocused}
            initialSide={orderSide}
            initialSideKey={orderSideKey}
            isFloating={isWide}
        />
    );

    return (
        <div
            className="terminal-grid h-[calc(100vh-56px-36px)]"
            onFocus={() => setIsTerminalFocused(true)}
            onBlur={() => setIsTerminalFocused(false)}
        >
            {/* ── WATCHLIST AREA ─────────────────────────────────────── */}
            {isWide ? (
                watchlistVisible ? (
                    <ResizablePanel
                        side="left"
                        defaultSize={300}
                        minSize={220}
                        maxSize={460}
                        className="terminal-area-watchlist hidden lg:flex"
                    >
                        {watchlistEl}
                    </ResizablePanel>
                ) : null
            ) : (
                <ResponsiveDrawer
                    open={watchlistDrawerOpen}
                    onClose={() => setWatchlistDrawerOpen(false)}
                    side="left"
                    isCompact={true}
                    width="w-[280px]"
                >
                    {watchlistEl}
                </ResponsiveDrawer>
            )}

            {/* ── CHART HEADER AREA ─────────────────────────────────── */}
            <div className="terminal-area-header min-w-0 flex items-center">
                {/* Watchlist toggle — desktop only */}
                {isWide && (
                    <button
                        onClick={() => {
                            setWatchlistVisible((v) => !v);
                            setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
                        }}
                        className={cn(
                            "flex-shrink-0 p-1.5 ml-1 rounded-md transition-all duration-200",
                            "text-slate-400 hover:text-heading hover:bg-overlay/[0.06]",
                            !watchlistVisible && "text-primary-500 bg-primary-500/10"
                        )}
                        title={watchlistVisible ? "Hide watchlist" : "Show watchlist"}
                    >
                        {watchlistVisible ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                    </button>
                )}
                <div className="flex-1 min-w-0">
                    <ChartHeader
                        symbol={selectedSymbol}
                        quote={quote}
                        period={chartPeriod}
                        onPeriodChange={setChartPeriod}
                        strategyDockOpen={strategyDockOpen}
                        isWatchlisted={Boolean(currentWatchlistItem)}
                        onToggleWatchlist={handleToggleWatchlist}
                        watchlistBusy={watchlistToggleBusy}
                        onToggleStrategyDock={() => setStrategyDockOpen((v) => !v)}
                        trendData={trendData}
                        isMobile={isMobile}
                        hasPositions={holdings.length > 0}
                        orderPanelVisible={orderPanelVisible}
                        onToggleOrderPanel={() => {
                            if (orderPanelVisible) {
                                closeFloatingOrderPanel();
                            } else {
                                openFloatingOrderPanel();
                            }
                        }}
                    />
                </div>
            </div>

            {/* ── CHART AREA ────────────────────────────────────────── */}
            <div className="terminal-area-chart min-w-0 min-h-0 relative overflow-hidden">
                <ErrorBoundary fallback="Chart failed to load. Please refresh.">
                    <ZebuLiveChart
                        candles={candles}
                        isLoading={chartLoading}
                        trendData={trendData}
                        symbol={selectedSymbol}
                        period={chartPeriod}
                        onPeriodChange={setChartPeriod}
                        zeroLossTrend={zlConfidence}
                    />
                </ErrorBoundary>
            </div>

            {/* ── BOTTOM DOCK ───────────────────────────────────────── */}
            <div className={cn(
                'terminal-area-bottom min-w-0',
                'transition-all duration-200'
            )}
                style={{ height: `${bottomCollapsed ? MIN_BOTTOM_HEIGHT : bottomHeight}px` }}
            >
                <DockContainer
                    tabs={dockTabs}
                    defaultTab="positions"
                    collapsed={bottomCollapsed}
                    onToggleCollapse={handleBottomPanelToggle}
                    onResizeStart={handleBottomResizeStart}
                />
            </div>

            {/* ── ORDER PANEL AREA ──────────────────────────────────── */}
            {isWide ? (
                orderPanelVisible ? (
                    <div
                        className="fixed z-50 hidden lg:flex flex-col rounded-2xl select-none bg-surface-900/95 border border-edge/10 shadow-2xl shadow-black/40 overflow-hidden"
                        style={{
                            left: orderPanelPos.x,
                            top: orderPanelPos.y,
                            width: ORDER_FLOAT_WIDTH,
                            height: 'min(calc(100vh - 140px), 620px)',
                            backdropFilter: 'blur(24px)',
                        }}
                    >
                        <div
                            onMouseDown={handleOrderPanelGrab}
                            className="h-8 px-3 flex items-center justify-between cursor-move border-b border-edge/10 flex-shrink-0"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-semibold text-heading">Order Panel</span>
                            </div>
                            <button
                                onClick={closeFloatingOrderPanel}
                                className="w-5 h-5 rounded-md flex items-center justify-center text-gray-500 hover:text-heading hover:bg-surface-800 transition-all duration-150"
                                title="Close"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden">
                            {orderPanelEl}
                        </div>
                    </div>
                ) : null
            ) : (
                <ResponsiveDrawer
                    open={orderDrawerOpen}
                    onClose={() => setOrderDrawerOpen(false)}
                    side="right"
                    isCompact={true}
                    width="w-[320px]"
                >
                    {orderPanelEl}
                </ResponsiveDrawer>
            )}

            {/* ── MOBILE/TABLET TRADE BAR ────────────────────────── */}
            {isCompact && (
                <div className="terminal-area-tradebar">
                    <MobileTradeBar
                        symbol={selectedSymbol}
                        price={quote?.price ?? 0}
                        onBuy={handleBuy}
                        onSell={handleSell}
                        onToggleWatchlist={() => setWatchlistDrawerOpen((v) => !v)}
                    />
                </div>
            )}

            {/* ── Floating Strategy Dock popup ───────────────────────── */}
            <ErrorBoundary fallback="Strategy dock failed to load.">
                <StrategyDock
                    candles={candles}
                    isOpen={strategyDockOpen}
                    onClose={() => setStrategyDockOpen(false)}
                />
            </ErrorBoundary>

            {/* ── Quick Order Modal (positions SELL/EXIT/BUY popup) ──── */}
            <Modal
                isOpen={quickOrderOpen}
                onClose={() => setQuickOrderOpen(false)}
                title={`${quickOrderSide === 'BUY' ? 'Buy / Exit Short' : 'Sell'} — ${quickOrderSymbol?.replace('.NS', '') || ''}`}
                size="sm"
            >
                <div className="h-[520px] overflow-y-auto">
                    <OrderPanel
                        symbol={quickOrderSymbol || selectedSymbol}
                        currentPrice={allSymbolQuotes[quickOrderSymbol]?.price ?? 0}
                        initialSide={quickOrderSide}
                        initialSideKey={quickOrderKey}
                    />
                </div>
            </Modal>
        </div>
    );
}