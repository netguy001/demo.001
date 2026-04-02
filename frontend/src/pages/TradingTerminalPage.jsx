// ─── TradingTerminalPage — watchlist wired to store ───────────────────────────
// Watchlist state (items, prices, id) is now owned by useWatchlistStore.
// TradingTerminalPage no longer manages watchlist local state at all.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMarketStore } from '../store/useMarketStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { useMarketData } from '../hooks/useMarketData';
import ZebuLiveChart from '../components/trading/ZebuLiveChart';
import { useZeroLossStore } from '../stores/useZeroLossStore';
import Watchlist from '../components/trading/Watchlist';
import OrderPanel from '../components/trading/OrderPanel';
import Modal from '../components/ui/Modal';
import { StrategyDock } from '../strategy/components';
import { runEngine, getAvailableStrategies } from '../strategy';
import ErrorBoundary from '../components/ErrorBoundary';
import { cn } from '../utils/cn';
import { formatPrice, formatPercent, pnlColorClass, cleanSymbol } from '../utils/formatters';
import { CHART_PERIODS, DEFAULT_CHART_PERIOD, ORDER_STATUS_CLASS } from '../utils/constants';

// ── Compact period dropdown for symbol header bar ─────────────────────────────
function PeriodDropdown({ period, onPeriodChange }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return;
        const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [open]);

    const current = CHART_PERIODS[period] || CHART_PERIODS[DEFAULT_CHART_PERIOD];

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200',
                    open
                        ? 'bg-primary-600/20 border-primary-500/40 text-primary-600'
                        : 'bg-surface-800/80 border-edge/20 text-gray-400 hover:text-gray-700 hover:border-edge/40'
                )}
            >
                {current.label}
                <svg className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {open && (
                <div className="absolute top-full right-0 mt-1 w-28 bg-surface-800 border border-edge/10 rounded-xl shadow-panel z-50 animate-slide-in overflow-hidden py-1">
                    {Object.entries(CHART_PERIODS).map(([key, cfg]) => (
                        <button
                            key={key}
                            onClick={() => { onPeriodChange(key); setOpen(false); }}
                            className={cn(
                                'w-full text-left px-3 py-1.5 text-xs font-semibold transition-colors',
                                period === key
                                    ? 'bg-primary-500/15 text-primary-600'
                                    : 'text-gray-400 hover:text-gray-700 hover:bg-overlay/[0.04]'
                            )}
                        >
                            {cfg.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Bottom tabs: positions + order history ────────────────────────────────────
function BottomTabs({ holdings, orders }) {
    const [activeTab, setActiveTab] = useState('positions');
    return (
        <div className="h-[200px] border-t border-slate-200 dark:border-edge/5 flex-shrink-0 flex flex-col bg-white dark:bg-surface-900">
            <div className="flex border-b border-slate-200 dark:border-edge/5 flex-shrink-0">
                {[
                    { key: 'positions', label: `Positions (${holdings.length})` },
                    { key: 'orders', label: `Orders (${orders.length})` },
                ].map(({ key, label }) => (
                    <button key={key} onClick={() => setActiveTab(key)}
                        className={cn(
                            'px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors',
                            activeTab === key
                                ? 'text-primary-600 border-b-2 border-primary-500'
                                : 'text-gray-500 hover:text-gray-700'
                        )}>
                        {label}
                    </button>
                ))}
            </div>
            <div className="overflow-y-auto flex-1 px-3 py-2 bg-white dark:bg-surface-900">
                {activeTab === 'positions' ? (
                    holdings.length > 0 ? (
                        <table className="w-full text-xs min-w-[500px]">
                            <thead>
                                <tr className="text-gray-500 uppercase">
                                    <th className="text-left pb-2 font-medium metric-label">Symbol</th>
                                    <th className="text-right pb-2 font-medium metric-label">Qty</th>
                                    <th className="text-right pb-2 font-medium metric-label">Avg</th>
                                    <th className="text-right pb-2 font-medium metric-label">LTP</th>
                                    <th className="text-right pb-2 font-medium metric-label">P&L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {holdings.map((h, i) => {
                                    const qty = Number(h.quantity ?? 0);
                                    const isShort = qty < 0;
                                    return (
                                        <tr key={h.symbol || i} className="border-t border-edge/[0.03] hover:bg-overlay/[0.02] transition-colors">
                                            <td className="py-1.5 font-medium text-heading">
                                                {cleanSymbol(h.symbol)}
                                                {isShort && <span className="ml-1 text-[9px] font-bold text-amber-400">SHORT</span>}
                                            </td>
                                            <td className={cn('py-1.5 text-right font-price tabular-nums', isShort ? 'text-amber-400' : 'text-gray-600')}>{h.quantity}</td>
                                            <td className="py-1.5 text-right font-price text-gray-600 tabular-nums">{formatPrice(h.avg_price)}</td>
                                            <td className="py-1.5 text-right font-price text-heading tabular-nums">{formatPrice(h.current_price)}</td>
                                            <td className={cn('py-1.5 text-right font-price font-medium tabular-nums', pnlColorClass(h.pnl ?? 0))}>
                                                {(h.pnl ?? 0) >= 0 ? '+' : ''}₹{formatPrice(h.pnl ?? 0)}{' '}
                                                ({formatPercent(h.pnl_percent ?? 0)})
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    ) : (
                        <div className="text-center py-6 text-gray-600 text-xs">No open positions. Place a trade to get started.</div>
                    )
                ) : (
                    orders.length > 0 ? (
                        <table className="w-full text-xs min-w-[600px]">
                            <thead>
                                <tr className="text-gray-500 uppercase">
                                    <th className="text-left pb-2 font-medium metric-label">Symbol</th>
                                    <th className="text-left pb-2 font-medium metric-label">Side</th>
                                    <th className="text-left pb-2 font-medium metric-label">Type</th>
                                    <th className="text-right pb-2 font-medium metric-label">Qty</th>
                                    <th className="text-right pb-2 font-medium metric-label">Price</th>
                                    <th className="text-right pb-2 font-medium metric-label">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {orders.map((o, i) => (
                                    <tr key={o.id || i} className="border-t border-edge/[0.03] hover:bg-overlay/[0.02] transition-colors">
                                        <td className="py-1.5 font-medium text-heading">{cleanSymbol(o.symbol)}</td>
                                        <td className={cn('py-1.5 font-medium', o.side === 'BUY' ? 'text-bull' : 'text-bear')}>{o.side}</td>
                                        <td className="py-1.5 text-gray-400">{o.order_type}</td>
                                        <td className="py-1.5 text-right font-price text-gray-600 tabular-nums">{o.quantity}</td>
                                        <td className="py-1.5 text-right font-price text-heading tabular-nums">
                                            {formatPrice(o.filled_price ?? o.price ?? null)}
                                        </td>
                                        <td className="py-1.5 text-right">
                                            <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium', ORDER_STATUS_CLASS[o.status] || ORDER_STATUS_CLASS.PENDING)}>
                                                {o.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <div className="text-center py-6 text-gray-600 text-xs">No orders yet.</div>
                    )
                )}
            </div>
        </div>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TradingTerminalPage() {
    const [searchParams] = useSearchParams();
    const symbolFromUrl = searchParams.get('symbol') || 'RELIANCE.NS';
    const [selectedSymbol, setSelectedSymbol] = useState(symbolFromUrl);

    useEffect(() => {
        if (symbolFromUrl && symbolFromUrl !== selectedSymbol) {
            setSelectedSymbol(symbolFromUrl);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbolFromUrl]);

    const zlConfidence = useZeroLossStore((s) => s.confidence[selectedSymbol] || null);

    const [chartPeriod, setChartPeriod] = useState(DEFAULT_CHART_PERIOD);
    const [isTerminalFocused, setIsTerminalFocused] = useState(false);
    const [strategyDockOpen, setStrategyDockOpen] = useState(false);
    const [watchlistOpen, setWatchlistOpen] = useState(true);
    const [bottomTabsOpen, setBottomTabsOpen] = useState(false);

    // ── Stores ────────────────────────────────────────────────────────────────
    const { holdings, orders, refreshPortfolio, applyLiveQuote } = usePortfolioStore();
    const liveQuotes = useMarketStore((s) => s.symbols);
    const setGlobalSelectedSymbol = useMarketStore((s) => s.setSelectedSymbol);
    const batchUpdateQuotes = useMarketStore((s) => s.batchUpdateQuotes);

    // ── Watchlist store — single source of truth ──────────────────────────────
    const { loadWatchlist, fetchPrices, updatePrices } = useWatchlistStore();

    // Hook: quote + candles for the selected symbol
    const { quote, candles, isLoading: chartLoading, fetchCandles } = useMarketData(selectedSymbol);

    // Compute trend data for chart overlay — deferred so it doesn't block chart render
    const [trendData, setTrendData] = useState(null);
    useEffect(() => {
        if (!candles || candles.length === 0) {
            setTrendData(null);
            return;
        }
        // setTimeout(0) yields to the browser so the chart can paint first
        const id = setTimeout(() => {
            const strategies = getAvailableStrategies();
            const enabledIds = strategies.map((s) => s.id);
            const result = runEngine(candles, enabledIds);
            setTrendData({
                overall: result.overall,
                confidence: result.confidence,
                weightedScore: result.weightedScore ?? 0,
            });
        }, 0);
        return () => clearTimeout(id);
    }, [candles]);

    // Re-fetch candles when period or symbol changes
    useEffect(() => {
        const cfg = CHART_PERIODS[chartPeriod] || CHART_PERIODS[DEFAULT_CHART_PERIOD];
        fetchCandles(cfg.period, cfg.interval);
    }, [selectedSymbol, chartPeriod, fetchCandles]);

    // Load portfolio on mount + poll every 30s as fallback for missed WS events
    useEffect(() => {
        refreshPortfolio();
        const id = setInterval(() => refreshPortfolio(), 30_000);
        return () => clearInterval(id);
    }, [refreshPortfolio]);

    // ── Load watchlist from store on mount ────────────────────────────────────
    useEffect(() => {
        loadWatchlist();
    }, [loadWatchlist]);

    // ── Poll watchlist prices every 5s — sync to other stores in one batch ─
    const syncPricesRef = useRef(null);
    syncPricesRef.current = { batchUpdateQuotes, applyLiveQuote };
    useEffect(() => {
        let mounted = true;
        const poll = async () => {
            await fetchPrices();
            if (!mounted) return;
            // Sync to MarketStore + PortfolioStore using a microtask
            // to batch React updates and reduce cascading re-renders
            const { prices } = useWatchlistStore.getState();
            if (!prices || typeof prices !== 'object') return;
            syncPricesRef.current.batchUpdateQuotes(prices);
            Object.entries(prices).forEach(([symbol, quote]) => {
                if (quote) syncPricesRef.current.applyLiveQuote(symbol, quote);
            });
        };
        poll();
        const id = setInterval(poll, 15_000);
        return () => { mounted = false; clearInterval(id); };
    }, [fetchPrices]);

    const [orderSide, setOrderSide] = useState(null);
    const [orderSideKey, setOrderSideKey] = useState(0);

    // Quick order modal — opens when SELL/EXIT/BUY is clicked from positions/watchlist
    const [quickOrderOpen, setQuickOrderOpen] = useState(false);
    const [quickOrderSymbol, setQuickOrderSymbol] = useState(null);
    const [quickOrderSide, setQuickOrderSide] = useState(null);
    const [quickOrderKey, setQuickOrderKey] = useState(0);

    const handleSelectSymbol = useCallback((symbol) => setSelectedSymbol(symbol), []);

    // Watchlist / position buy/sell → open quick order popup modal
    const handleBuy = useCallback((symbol) => {
        setQuickOrderSymbol(symbol);
        setQuickOrderSide('BUY');
        setQuickOrderKey((k) => k + 1);
        setQuickOrderOpen(true);
    }, []);
    const handleSell = useCallback((symbol) => {
        setQuickOrderSymbol(symbol);
        setQuickOrderSide('SELL');
        setQuickOrderKey((k) => k + 1);
        setQuickOrderOpen(true);
    }, []);

    useEffect(() => {
        setGlobalSelectedSymbol(selectedSymbol);
    }, [selectedSymbol, setGlobalSelectedSymbol]);

    const liveHoldings = useMemo(() => {
        return (holdings || []).map((h) => {
            const symbol = h?.symbol;
            if (!symbol) return h;

            const wsQuote =
                liveQuotes[symbol] ||
                liveQuotes[symbol.replace('.NS', '')] ||
                liveQuotes[`${symbol}.NS`];

            const livePrice = Number(
                wsQuote?.price ?? wsQuote?.lp ?? wsQuote?.ltp ?? wsQuote?.last_price
            );
            if (!Number.isFinite(livePrice) || livePrice <= 0) return h;

            const quantity = Number(h.quantity ?? 0);
            const avgPrice = Number(h.avg_price ?? 0);
            const investedValue = Number(h.invested_value ?? avgPrice * quantity);
            const currentValue = livePrice * quantity;
            const pnl = currentValue - investedValue;
            // For short positions (negative qty/invested), use absolute invested value
            const absInvested = Math.abs(investedValue);
            const pnlPercent = absInvested > 0 ? (pnl / absInvested) * 100 : 0;

            return {
                ...h,
                current_price: livePrice,
                current_value: currentValue,
                pnl,
                pnl_percent: pnlPercent,
            };
        });
    }, [holdings, liveQuotes]);

    return (
        <div
            className="h-full flex overflow-hidden"
            onFocus={() => setIsTerminalFocused(true)}
            onBlur={() => setIsTerminalFocused(false)}
        >
            {/* ── CENTER: Chart + bottom tabs ────────────────────────────── */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
                {/* ── Floating Watchlist overlay ──────────────────────── */}
                {watchlistOpen && (
                    <>
                        {/* Backdrop */}
                        <div
                            className="absolute inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
                            onClick={() => setWatchlistOpen(false)}
                        />
                        {/* Panel */}
                        <div className="absolute left-0 top-0 h-full w-[220px] z-50 flex flex-col shadow-2xl border-r border-edge/10 bg-surface-900">
                            <Watchlist
                                selectedSymbol={selectedSymbol}
                                onSelectSymbol={(sym) => { handleSelectSymbol(sym); setWatchlistOpen(false); }}
                                onBuy={handleBuy}
                                onSell={handleSell}
                                onClose={() => setWatchlistOpen(false)}
                            />
                        </div>
                    </>
                )}

                {/* Symbol header bar */}
                <div className="flex items-center gap-4 px-4 py-2.5 border-b border-edge/5 bg-surface-900/30 flex-shrink-0">
                    <div>
                        <h2 className="text-lg font-display font-semibold text-heading leading-none">
                            {cleanSymbol(selectedSymbol)}
                        </h2>
                        <span className="text-[11px] text-gray-500">{quote?.name || selectedSymbol} • NSE</span>
                    </div>

                    <div className={cn("flex items-baseline gap-3 transition-opacity duration-300", quote?.price != null ? "opacity-100" : "opacity-0")}>
                        <span className="text-2xl font-semibold font-price text-heading tabular-nums">
                            {quote?.price != null ? formatPrice(quote.price) : '—'}
                        </span>
                        {quote?.change != null && (
                            <span className={cn('text-sm font-price font-semibold tabular-nums', pnlColorClass(quote.change))}>
                                {quote.change >= 0 ? '▲' : '▼'}{' '}
                                {quote.change >= 0 ? '+' : ''}{formatPrice(quote.change)}{' '}
                                ({formatPercent(quote.change_percent)})
                            </span>
                        )}
                    </div>

                    {/* Spacer + right-aligned controls */}
                    <div className="flex items-center gap-2 ml-auto">
                        {/* OHLC — xl only */}
                        <div className="hidden xl:flex items-center gap-4 text-xs text-gray-500 mr-2">
                            {[
                                ['Open', quote?.open],
                                ['High', quote?.high],
                                ['Low', quote?.low],
                                ['Prev', quote?.prev_close],
                            ].map(([label, val]) => val != null && (
                                <div key={label} className="flex items-center gap-1">
                                    <span className="metric-label text-[10px]">{label}</span>
                                    <span className="font-price text-gray-400 tabular-nums">{formatPrice(val)}</span>
                                </div>
                            ))}
                        </div>

                        {/* Watchlist toggle */}
                        <button
                            onClick={() => setWatchlistOpen((v) => !v)}
                            className={cn(
                                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200',
                                watchlistOpen
                                    ? 'bg-primary-600/20 border-primary-500/40 text-primary-600'
                                    : 'bg-surface-800/80 border-edge/20 text-gray-400 hover:text-gray-700 hover:border-edge/40'
                            )}
                            title="Toggle Watchlist"
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M4 6h16M4 10h16M4 14h10M4 18h6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Watchlist
                        </button>

                        {/* Period dropdown */}
                        <PeriodDropdown period={chartPeriod} onPeriodChange={setChartPeriod} />

                        {/* Strategy toggle */}
                        <button
                            onClick={() => setStrategyDockOpen((v) => !v)}
                            className={cn(
                                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200',
                                strategyDockOpen
                                    ? 'bg-primary-600/20 border-primary-500/40 text-primary-600'
                                    : 'bg-surface-800/80 border-edge/20 text-gray-400 hover:text-gray-700 hover:border-edge/40'
                            )}
                            title="Toggle Strategy Dock"
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 20V10M18 20V4M6 20v-4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Strategies
                        </button>
                    </div>
                </div>

                {/* Chart — fills remaining height */}
                <div className={cn('min-h-0 relative', bottomTabsOpen ? 'flex-1' : 'flex-[1_1_0%]')}>
                    <ErrorBoundary fallback="Chart failed to load. Please refresh.">
                        <ZebuLiveChart
                            candles={candles}
                            period={chartPeriod}
                            isLoading={chartLoading}
                            symbol={selectedSymbol}
                            trendData={trendData}
                            zeroLossTrend={zlConfidence}
                            onPeriodChange={setChartPeriod}
                        />
                    </ErrorBoundary>
                </div>

                {/* Bottom tabs (collapsible) */}
                <div className="border-t border-slate-200 dark:border-edge/5 bg-white dark:bg-surface-900">
                    <button
                        onClick={() => setBottomTabsOpen((v) => !v)}
                        className="w-full h-7 flex items-center justify-center gap-2 bg-gray-100 dark:bg-surface-800 hover:bg-gray-200 dark:hover:bg-surface-700 text-gray-500 hover:text-primary-600 transition-colors text-[11px] font-semibold tracking-wide"
                    >
                        <svg className={cn('w-3.5 h-3.5 transition-transform duration-200', bottomTabsOpen ? 'rotate-0' : 'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        POSITIONS ({liveHoldings.length}) &middot; ORDERS ({orders.length})
                    </button>
                    {bottomTabsOpen && <BottomTabs holdings={liveHoldings} orders={orders} />}
                </div>
            </div>

            {/* ── RIGHT: Order panel (full height) ──────────────────────── */}
            <div className="w-[300px] min-w-[300px] flex-shrink-0 hidden lg:flex flex-col overflow-hidden border-l border-edge/10">
                <OrderPanel
                    symbol={selectedSymbol}
                    currentPrice={quote?.price ?? 0}
                    isTerminalFocused={isTerminalFocused}
                    initialSide={orderSide}
                    initialSideKey={orderSideKey}
                />
            </div>

            {/* ── Floating Strategy Dock popup ───────────────────────────── */}
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
                title={`${quickOrderSide === 'BUY' ? 'Buy / Exit Short' : 'Sell'} — ${cleanSymbol(quickOrderSymbol) || ''}`}
                size="sm"
            >
                <div className="h-[520px] overflow-y-auto">
                    <OrderPanel
                        symbol={quickOrderSymbol || selectedSymbol}
                        currentPrice={liveQuotes[quickOrderSymbol]?.price ?? 0}
                        initialSide={quickOrderSide}
                        initialSideKey={quickOrderKey}
                    />
                </div>
            </Modal>
        </div>
    );
}
