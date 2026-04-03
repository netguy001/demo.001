import { useState, useEffect, useMemo, useCallback } from 'react';
import { BarChart3, Search, ShieldCheck, Bot, RefreshCw, Funnel } from 'lucide-react';
import { formatCurrency, cleanSymbol, formatQuantity, pnlColorClass } from '../utils/formatters';
import { Skeleton } from '../components/ui';
import { cn } from '../utils/cn';
import { usePortfolioStore } from '../store/usePortfolioStore';

const ORDER_TABS = [
    { key: 'open', label: 'Open' },
    { key: 'trade', label: 'Trade' },
    { key: 'executed', label: 'Executed' },
];

const OPEN_STATUSES = new Set(['OPEN', 'PENDING', 'TRIGGER_PENDING', 'AMO_RECEIVED', 'MODIFY_PENDING']);
const EXECUTED_STATUSES = new Set(['FILLED', 'COMPLETE']);

const normalizeStatus = (status) => String(status || '').toUpperCase();
const normalizeSymbol = (symbol) => String(symbol || '').replace(/\.(NS|BO)$/i, '').trim();
const normalizeSide = (side) => String(side || '').toUpperCase();

function parseOrderTimestamp(order) {
    const raw = order.executed_at || order.updated_at || order.created_at || null;
    if (!raw) return null;
    const normalizedRaw =
        typeof raw === 'string' && !/[zZ]|[+\-]\d{2}:?\d{2}$/.test(raw)
            ? `${raw}Z`
            : raw;
    const date = new Date(normalizedRaw);
    return Number.isNaN(date.getTime()) ? null : date;
}

function computeOrderPnL(orders) {
    const pnlMap = new Map();
    const books = new Map();

    const executed = orders
        .filter((order) => EXECUTED_STATUSES.has(normalizeStatus(order.status_norm)))
        .sort((a, b) => {
            const ta = a.ts ? a.ts.getTime() : 0;
            const tb = b.ts ? b.ts.getTime() : 0;
            return ta - tb;
        });

    for (const order of executed) {
        const status = normalizeStatus(order.status_norm);
        if (!EXECUTED_STATUSES.has(status)) continue;

        const symbol = order.symbol_norm;
        const side = normalizeSide(order.side_norm);
        const price = Number(order.exec_price ?? 0);
        const qty = Number(order.exec_qty ?? 0);

        if (!symbol || !Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) continue;

        if (!books.has(symbol)) books.set(symbol, []);
        const lots = books.get(symbol);
        const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
        let remaining = qty;
        let realized = 0;

        while (remaining > 0) {
            const oppositeIndex = lots.findIndex((lot) => lot.side === oppositeSide && lot.qty > 0);
            if (oppositeIndex === -1) break;

            const lot = lots[oppositeIndex];
            const closeQty = Math.min(remaining, lot.qty);

            if (lot.side === 'BUY') {
                realized += (price - lot.price) * closeQty;
            } else {
                realized += (lot.price - price) * closeQty;
            }

            lot.qty -= closeQty;
            remaining -= closeQty;
            if (lot.qty <= 0) {
                lots.splice(oppositeIndex, 1);
            }
        }

        if (remaining > 0) {
            lots.push({ side, price, qty: remaining });
        }

        if (Math.abs(realized) > 0.000001) {
            pnlMap.set(order.uid, Math.round(realized * 100) / 100);
        }
    }

    return pnlMap;
}

/**
 * Format order timestamp for display in IST (Asia/Kolkata).
 * Backend stores UTC — we must explicitly convert to IST.
 */
function formatOrderTime(order) {
    const d = order.ts ?? parseOrderTimestamp(order);
    if (!d) return '—';

    const timeStr = d.toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true, timeZone: 'Asia/Kolkata',
    });

    const today = new Date();
    const todayIST = today.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const dateIST = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (dateIST === todayIST) return timeStr;

    const dateFmt = d.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata',
    });
    return `${dateFmt} ${timeStr}`;
}

export default function OrdersPage() {
    const orders = usePortfolioStore((s) => s.orders) || [];
    const refreshPortfolio = usePortfolioStore((s) => s.refreshPortfolio);
    const [activeTab, setActiveTab] = useState('trade');
    const [searchQuery, setSearchQuery] = useState('');
    const [strategyFilter, setStrategyFilter] = useState('all');
    const [isRefreshing, setIsRefreshing] = useState(true);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

    const loadOrders = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await refreshPortfolio();
            setLastUpdatedAt(new Date());
        } finally {
            setIsRefreshing(false);
        }
    }, [refreshPortfolio]);

    useEffect(() => {
        loadOrders();
    }, [loadOrders]);

    const normalizedOrders = useMemo(() => {
        return (orders || [])
            .map((order, index) => {
                const ts = parseOrderTimestamp(order);
                const execPriceRaw = order.filled_price ?? order.average_price ?? order.price;
                const execQtyRaw = order.filled_quantity ?? order.executed_quantity ?? order.quantity;

                return {
                    ...order,
                    uid: String(order.id ?? order.order_id ?? order.exchange_order_id ?? `${order.symbol || 'ORD'}-${index}`),
                    symbol_norm: normalizeSymbol(order.symbol),
                    side_norm: normalizeSide(order.side),
                    status_norm: normalizeStatus(order.status),
                    strategy_tag: String(order.tag || order.strategy || '').toUpperCase(),
                    ts,
                    tsMs: ts ? ts.getTime() : 0,
                    exec_price: Number(execPriceRaw ?? 0),
                    exec_qty: Number(execQtyRaw ?? 0),
                    display_qty: Number(order.quantity ?? execQtyRaw ?? 0),
                    display_price: execPriceRaw,
                };
            })
            .sort((a, b) => b.tsMs - a.tsMs);
    }, [orders]);

    const pnlMap = useMemo(() => computeOrderPnL(normalizedOrders), [normalizedOrders]);

    const tabCounts = useMemo(() => {
        const openCount = normalizedOrders.filter((o) => OPEN_STATUSES.has(o.status_norm)).length;
        const executedCount = normalizedOrders.filter((o) => EXECUTED_STATUSES.has(o.status_norm)).length;
        return {
            open: openCount,
            trade: normalizedOrders.length,
            executed: executedCount,
        };
    }, [normalizedOrders]);

    const tabOrders = useMemo(() => {
        if (activeTab === 'open') {
            return normalizedOrders.filter((o) => OPEN_STATUSES.has(o.status_norm));
        }
        if (activeTab === 'executed') {
            return normalizedOrders.filter((o) => EXECUTED_STATUSES.has(o.status_norm));
        }
        return normalizedOrders;
    }, [normalizedOrders, activeTab]);

    const strategyFilteredOrders = useMemo(() => {
        if (strategyFilter === 'all') return tabOrders;
        if (strategyFilter === 'manual') {
            return tabOrders.filter((o) => !o.strategy_tag || (o.strategy_tag !== 'ALGO' && o.strategy_tag !== 'ZEROLOSS'));
        }
        return tabOrders.filter((o) => o.strategy_tag === strategyFilter.toUpperCase());
    }, [tabOrders, strategyFilter]);

    const visibleOrders = useMemo(() => {
        const query = searchQuery.trim().toUpperCase();
        if (!query) return strategyFilteredOrders;
        return strategyFilteredOrders.filter((o) => {
            const symbol = o.symbol_norm.toUpperCase();
            const side = o.side_norm;
            const status = o.status_norm;
            return symbol.includes(query) || side.includes(query) || status.includes(query);
        });
    }, [strategyFilteredOrders, searchQuery]);

    const summary = useMemo(() => {
        const executedOrders = normalizedOrders.filter((o) => EXECUTED_STATUSES.has(o.status_norm));
        const openOrders = normalizedOrders.filter((o) => OPEN_STATUSES.has(o.status_norm));
        const grossTurnover = executedOrders.reduce((sum, o) => {
            const qty = Number(o.exec_qty || o.display_qty || 0);
            const price = Number(o.exec_price || o.display_price || 0);
            return sum + (Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0);
        }, 0);
        const realizedPnl = [...pnlMap.values()].reduce((sum, value) => sum + value, 0);

        return {
            totalOrders: normalizedOrders.length,
            executedOrders: executedOrders.length,
            openOrders: openOrders.length,
            grossTurnover,
            realizedPnl,
        };
    }, [normalizedOrders, pnlMap]);

    const emptyMessage =
        searchQuery.trim().length > 0
            ? 'No matching stocks found in this section.'
            : activeTab === 'open'
                ? 'No open orders.'
                : activeTab === 'executed'
                    ? 'No executed orders yet.'
                    : 'No trade history yet.';

    if (isRefreshing && normalizedOrders.length === 0) {
        return (
            <div className="p-4 lg:p-6 space-y-6">
                <Skeleton variant="text" className="h-8 w-48" />
                <Skeleton variant="table-row" count={8} />
            </div>
        );
    }

    return (
        <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-display font-semibold text-heading">Orders</h1>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={loadOrders}
                        disabled={isRefreshing}
                        className={cn(
                            'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                            'border-edge/10 bg-surface-900/40 text-heading hover:border-edge/20 disabled:opacity-60 disabled:cursor-not-allowed'
                        )}
                    >
                        <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
                        Refresh
                    </button>
                    <span className="text-[11px] text-gray-500">
                        {lastUpdatedAt
                            ? `Updated ${lastUpdatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                            : '—'}
                    </span>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="glass-card p-4">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Total Orders</p>
                    <p className="mt-1 text-xl font-semibold text-heading tabular-nums">{formatQuantity(summary.totalOrders)}</p>
                </div>
                <div className="glass-card p-4">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Executed</p>
                    <p className="mt-1 text-xl font-semibold text-heading tabular-nums">{formatQuantity(summary.executedOrders)}</p>
                </div>
                <div className="glass-card p-4">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Open</p>
                    <p className="mt-1 text-xl font-semibold text-heading tabular-nums">{formatQuantity(summary.openOrders)}</p>
                </div>
                <div className="glass-card p-4">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">Realized P&L</p>
                    <p className={cn('mt-1 text-xl font-semibold tabular-nums', pnlColorClass(summary.realizedPnl))}>
                        {summary.realizedPnl > 0 ? '+' : ''}{formatCurrency(summary.realizedPnl)}
                    </p>
                </div>
            </div>

            <div className="glass-card p-3 lg:p-4">
                <div className="flex flex-wrap items-center gap-2 lg:gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {ORDER_TABS.map((tab) => (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setActiveTab(tab.key)}
                                className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border',
                                    activeTab === tab.key
                                        ? 'bg-primary-500/15 text-primary-600 border-primary-500/30'
                                        : 'bg-surface-900/40 text-gray-500 border-edge/10 hover:text-heading hover:border-edge/20'
                                )}
                            >
                                {tab.label}
                                <span className="ml-1.5 text-[10px] font-mono tabular-nums opacity-80">{tabCounts[tab.key]}</span>
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center gap-1.5 ml-auto">
                        <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                            <Funnel className="h-3 w-3" />
                            Filter
                        </span>
                        <button
                            type="button"
                            onClick={() => setStrategyFilter('all')}
                            className={cn(
                                'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors',
                                strategyFilter === 'all'
                                    ? 'bg-primary-500/15 text-primary-600 border-primary-500/30'
                                    : 'bg-surface-900/40 text-gray-500 border-edge/10 hover:text-heading hover:border-edge/20'
                            )}
                        >
                            All
                        </button>
                        <button
                            type="button"
                            onClick={() => setStrategyFilter('manual')}
                            className={cn(
                                'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors',
                                strategyFilter === 'manual'
                                    ? 'bg-primary-500/15 text-primary-600 border-primary-500/30'
                                    : 'bg-surface-900/40 text-gray-500 border-edge/10 hover:text-heading hover:border-edge/20'
                            )}
                        >
                            Manual
                        </button>
                        <button
                            type="button"
                            onClick={() => setStrategyFilter('zeroloss')}
                            className={cn(
                                'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors',
                                strategyFilter === 'zeroloss'
                                    ? 'bg-primary-500/15 text-primary-600 border-primary-500/30'
                                    : 'bg-surface-900/40 text-gray-500 border-edge/10 hover:text-heading hover:border-edge/20'
                            )}
                        >
                            ZeroLoss
                        </button>
                        <button
                            type="button"
                            onClick={() => setStrategyFilter('algo')}
                            className={cn(
                                'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors',
                                strategyFilter === 'algo'
                                    ? 'bg-primary-500/15 text-primary-600 border-primary-500/30'
                                    : 'bg-surface-900/40 text-gray-500 border-edge/10 hover:text-heading hover:border-edge/20'
                            )}
                        >
                            Algo
                        </button>
                    </div>

                    <div className="relative w-full lg:w-[380px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search by symbol, side, or status…"
                            aria-label="Search orders"
                            className={cn(
                                'w-full bg-surface-800/60 border border-edge/5 rounded-lg',
                                'pl-10 pr-3 py-2 text-sm text-heading placeholder-gray-500',
                                'focus:outline-none focus:border-primary-500/30 transition-all duration-200'
                            )}
                        />
                    </div>
                </div>
            </div>

            {visibleOrders.length > 0 ? (
                <div className="glass-card overflow-hidden">
                    <div className="grid grid-cols-8 gap-3 px-5 py-3 border-b border-edge/5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                        <span>Symbol</span>
                        <span>Side</span>
                        <span>Qty</span>
                        <span>Price</span>
                        <span>Type</span>
                        <span>Time</span>
                        <span className="text-right">P&L</span>
                        <span className="text-right">Status</span>
                    </div>
                    <div className="divide-y divide-edge/[0.03]">
                        {visibleOrders.map((o) => {
                            const pnl = pnlMap.get(o.uid);
                            const hasPnl = pnl !== undefined;

                            return (
                                <div key={o.uid} className="grid grid-cols-8 gap-3 px-5 py-3.5 hover:bg-overlay/[0.03] transition-colors items-center">
                                    <span className="text-sm font-semibold text-heading flex items-center gap-1.5">
                                        {cleanSymbol(o.symbol_norm || o.symbol)}
                                        {o.strategy_tag === 'ZEROLOSS' && (
                                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-[9px] font-bold text-emerald-500" title="ZeroLoss Strategy">
                                                <ShieldCheck className="w-2.5 h-2.5" /> ZL
                                            </span>
                                        )}
                                        {o.strategy_tag === 'ALGO' && (
                                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/25 text-[9px] font-bold text-blue-400" title="Algo Strategy">
                                                <Bot className="w-2.5 h-2.5" /> ALGO
                                            </span>
                                        )}
                                    </span>
                                    <span className={cn(
                                        'text-xs font-semibold px-2.5 py-0.5 rounded w-fit',
                                        o.side_norm === 'BUY' ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'
                                    )}>
                                        {o.side_norm || '—'}
                                    </span>
                                    <span className="text-sm font-mono text-gray-400">{formatQuantity(o.display_qty)}</span>
                                    <span className="text-sm font-mono font-semibold text-heading">{formatCurrency(o.display_price)}</span>
                                    <span className="text-xs text-gray-500">{o.product_type || o.order_type || '—'}</span>
                                    <span className="text-xs text-gray-400 font-mono">{formatOrderTime(o)}</span>
                                    <span className="text-right">
                                        {hasPnl ? (
                                            <span className={cn(
                                                'text-xs font-mono font-semibold',
                                                pnlColorClass(pnl)
                                            )}>
                                                {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-gray-600">—</span>
                                        )}
                                    </span>
                                    <span className="text-right">
                                        <span className={cn(
                                            'text-[11px] px-2 py-0.5 rounded font-medium',
                                            EXECUTED_STATUSES.has(o.status_norm) ? 'text-profit bg-profit/10' :
                                                o.status_norm === 'CANCELLED' ? 'text-gray-400 bg-gray-400/10' :
                                                    o.status_norm === 'REJECTED' || o.status_norm === 'EXPIRED' ? 'text-bear bg-bear/10' :
                                                    'text-primary-600 bg-primary-500/10'
                                        )}>
                                            {o.status_norm || 'PENDING'}
                                        </span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div className="glass-card p-12 text-center">
                    <BarChart3 className="w-12 h-12 mx-auto mb-3 text-gray-600 opacity-30" />
                    <p className="text-sm font-medium text-gray-500">{emptyMessage}</p>
                    <p className="text-xs text-gray-600 mt-1">
                        {searchQuery.trim().length > 0
                            ? 'Try another symbol name.'
                            : 'Place your first trade from the terminal'}
                    </p>
                </div>
            )}

            <div className="text-[11px] text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
                <span>Rows: {formatQuantity(visibleOrders.length)}</span>
                <span>Gross Turnover: {formatCurrency(summary.grossTurnover)}</span>
                <span>Sort: Latest first</span>
            </div>
        </div>
    );
}
