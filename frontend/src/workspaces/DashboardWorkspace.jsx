// ─── DashboardWorkspace ──────────────────────────────────────────────────────
// Expanded dashboard hub — KPI overview, indices, holdings, orders, and navigation.
import { useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/useAuthStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { useMarketStore } from '../store/useMarketStore';
import { useMarketIndicesStore } from '../stores/useMarketIndicesStore';
import {
    TrendingUp, TrendingDown, IndianRupee,
    BarChart3, ArrowRight, Zap, Briefcase,
    ShieldCheck, ClipboardList, Globe, Landmark,
} from 'lucide-react';
import { formatCurrency, formatPrice, formatPercent, pnlColorClass, cleanSymbol } from '../utils/formatters';
import { Skeleton } from '../components/ui';
import { cn } from '../utils/cn';

const NAV_CARDS = [
    { to: '/terminal', icon: BarChart3, label: 'Terminal', desc: 'Live charts & order execution', accent: true },
    { to: '/market', icon: Globe, label: 'Market', desc: 'Indices & market overview' },
    { to: '/futures', icon: Landmark, label: 'Futures', desc: 'Dummy futures strikes by stock' },
    { to: '/portfolio', icon: Briefcase, label: 'Portfolio', desc: 'Holdings & performance' },
    { to: '/orders', icon: ClipboardList, label: 'Orders', desc: 'Order history & status' },
    { to: '/algo', icon: Zap, label: 'Algo Trading', desc: 'Automated strategies' },
    { to: '/zeroloss', icon: ShieldCheck, label: 'ZeroLoss', desc: 'Confidence-gated strategy' },
];

function MiniSparkline({ data = [], color = 'var(--bullish)', width = 80, height = 24 }) {
    if (!data || data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const points = data.map((value, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((value - min) / range) * height;
        return `${x},${y}`;
    }).join(' ');

    return (
        <svg width={width} height={height} className="flex-shrink-0 opacity-60" aria-hidden="true">
            <polyline
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={points}
            />
        </svg>
    );
}

export default function DashboardWorkspace() {
    const navigate = useNavigate();
    const user = useAuthStore((s) => s.user);
    const portfolio = usePortfolioStore((s) => s.summary);
    const holdings = usePortfolioStore((s) => s.holdings);
    const orders = usePortfolioStore((s) => s.orders);
    const pnl = usePortfolioStore((s) => s.pnl);
    const loading = usePortfolioStore((s) => s.isLoading);
    const refreshPortfolio = usePortfolioStore((s) => s.refreshPortfolio);
    const liveQuotes = useMarketStore((s) => s.symbols);

    const indices = useMarketIndicesStore((s) => s.indices);
    const fetchIndices = useMarketIndicesStore((s) => s.fetchIndices);
    const startPolling = useMarketIndicesStore((s) => s.startPolling);
    const stopPolling = useMarketIndicesStore((s) => s.stopPolling);

    useEffect(() => {
        refreshPortfolio();
    }, [refreshPortfolio]);

    useEffect(() => {
        fetchIndices();
        startPolling();
        return () => stopPolling();
    }, [fetchIndices, startPolling, stopPolling]);

    const liveHoldings = useMemo(() => {
        return (holdings || []).map((holding) => {
            const symbol = holding?.symbol;
            if (!symbol) return holding;

            const wsQuote = liveQuotes[symbol] || liveQuotes[symbol.replace('.NS', '')] || liveQuotes[`${symbol}.NS`];
            const livePrice = Number(wsQuote?.price ?? wsQuote?.lp ?? wsQuote?.ltp ?? wsQuote?.last_price);
            if (!Number.isFinite(livePrice) || livePrice <= 0) return holding;

            const quantity = Number(holding.quantity ?? 0);
            const avgPrice = Number(holding.avg_price ?? 0);
            const investedValue = avgPrice * quantity;
            const currentValue = livePrice * quantity;
            const unrealizedPnl = currentValue - investedValue;
            const unrealizedPct = investedValue > 0 ? (unrealizedPnl / investedValue) * 100 : 0;

            return {
                ...holding,
                current_price: livePrice,
                current_value: currentValue,
                pnl: unrealizedPnl,
                pnl_percent: unrealizedPct,
            };
        });
    }, [holdings, liveQuotes]);

    const liveTotals = useMemo(() => {
        const invested = liveHoldings.reduce((sum, holding) => {
            const qty = Number(holding.quantity ?? 0);
            const avg = Number(holding.avg_price ?? 0);
            return sum + avg * qty;
        }, 0);
        const current = liveHoldings.reduce((sum, holding) => sum + Number(holding.current_value ?? 0), 0);
        const unrealized = liveHoldings.reduce((sum, holding) => sum + Number(holding.pnl ?? 0), 0);
        return { invested, current, unrealized };
    }, [liveHoldings]);

    const totalInvested = liveTotals.invested || Number(portfolio?.total_invested ?? 0);
    const currentValue = liveTotals.current || Number(portfolio?.current_value ?? 0);
    const availableCash = Number(portfolio?.available_capital ?? 0);
    const totalCapital = availableCash + currentValue;
    const totalPnl = liveTotals.unrealized || Number(pnl?.total ?? portfolio?.total_pnl ?? 0);
    const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    const topHoldings = liveHoldings.slice(0, 5);
    const recentOrders = (orders || []).slice(0, 5);

    const kpiCards = [
        { label: 'TOTAL CAPITAL', value: formatCurrency(totalCapital), icon: IndianRupee, iconColor: 'text-primary-600' },
        { label: 'AVAILABLE CASH', value: formatCurrency(availableCash), icon: IndianRupee, iconColor: 'text-accent-cyan' },
        { label: 'INVESTED', value: formatCurrency(totalInvested), icon: BarChart3, iconColor: 'text-primary-600' },
        { label: 'CURRENT VALUE', value: formatCurrency(currentValue), icon: TrendingUp, iconColor: 'text-accent-emerald' },
    ];

    return (
        <div className="p-4 lg:p-6 space-y-5 animate-fade-in relative">
            {/* Loading overlay — fades out smoothly */}
            <div
                className="absolute inset-0 z-10 p-4 lg:p-6 space-y-6 transition-opacity duration-300"
                style={{
                    opacity: loading ? 1 : 0,
                    pointerEvents: loading ? 'auto' : 'none',
                    background: 'var(--bg-base, #0f0f1e)',
                }}
            >
                <Skeleton variant="text" className="h-8 w-48" />
                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className={cn('kpi-card', i === 4 && 'col-span-2')}>
                            <Skeleton variant="text" className="h-3 w-20" />
                            <Skeleton variant="text" className="h-7 w-28 mt-2" />
                        </div>
                    ))}
                </div>
                <Skeleton variant="chart" className="h-40" />
            </div>

            {/* Welcome Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-display font-semibold text-heading">
                        Welcome, {user?.full_name?.split(' ')[0] || user?.username || 'Trader'}
                    </h1>
                    <p className="text-slate-600 dark:text-slate-400 text-sm mt-0.5">Your trading overview</p>
                </div>
                <Link to="/terminal" className="btn-primary text-sm hidden sm:inline-flex items-center gap-2" aria-label="Open trading terminal">
                    Trade Now <ArrowRight className="w-4 h-4" />
                </Link>
            </div>

            {/* KPI Bar */}
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                {kpiCards.map(({ label, value, icon: Icon, iconColor }) => (
                    <div key={label} className="kpi-card">
                        <div className="flex items-center justify-between">
                            <span className="metric-label">{label}</span>
                            <Icon className={cn('w-4 h-4', iconColor)} />
                        </div>
                        <span className="text-lg font-price font-semibold text-heading tabular-nums mt-1">
                            {value}
                        </span>
                    </div>
                ))}

                <div className={cn(
                    'kpi-card-highlight',
                    totalPnl >= 0
                        ? 'bg-gradient-to-br from-green-500/[0.07] to-surface-900/60 border-green-500/10'
                        : 'bg-gradient-to-br from-red-500/[0.07] to-surface-900/60 border-red-500/10'
                )}>
                    <div className="flex items-center justify-between">
                        <span className="metric-label">TOTAL P&amp;L</span>
                        {totalPnl >= 0
                            ? <TrendingUp className="w-5 h-5 text-profit" />
                            : <TrendingDown className="w-5 h-5 text-loss" />
                        }
                    </div>
                    <div className="flex items-end gap-3 mt-1">
                        <span className={cn('text-3xl font-price font-semibold tabular-nums', pnlColorClass(totalPnl))}>
                            {totalPnl >= 0 ? '+' : ''}{formatCurrency(totalPnl)}
                        </span>
                        <span className={cn('text-sm font-price mb-1 tabular-nums', pnlColorClass(totalPnl))}>
                            {totalPnl >= 0 ? '▲' : '▼'} {formatPercent(totalPnlPct)}
                        </span>
                    </div>
                </div>
            </div>

            {/* Market + Quick Actions */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                <div className="lg:col-span-3 rounded-xl border border-edge/5 bg-surface-900/60 p-5">
                    <h2 className="section-title text-sm text-heading mb-4">Market Indices</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {indices.length > 0 ? indices.slice(0, 6).map((idx, i) => {
                            const isUp = (idx.change ?? 0) >= 0;
                            return (
                                <button
                                    type="button"
                                    key={i}
                                    onClick={() => idx.symbol && navigate(`/terminal?symbol=${encodeURIComponent(idx.symbol)}`)}
                                    disabled={!idx.symbol}
                                    title={idx.symbol ? `Open ${idx.name} in Terminal` : undefined}
                                    className={cn(
                                        'flex items-center justify-between p-3.5 rounded-lg bg-surface-800/40 border border-edge/[0.04] transition-colors text-left',
                                        idx.symbol ? 'hover:border-edge/10 cursor-pointer' : 'cursor-default'
                                    )}
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{idx.name}</div>
                                        <div className="text-xl font-price font-semibold text-heading tabular-nums mt-0.5">
                                            {Number(idx.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                                        </div>
                                    </div>
                                    <div className={cn('text-right flex flex-col items-end gap-0.5', pnlColorClass(idx.change))}>
                                        <div className="flex items-center gap-1 text-sm font-price font-semibold tabular-nums">
                                            {isUp ? '▲' : '▼'}
                                            {(idx.change ?? 0) > 0 ? '+' : ''}{formatPrice(idx.change)}
                                        </div>
                                        <div className="text-xs font-price tabular-nums opacity-70">{formatPercent(idx.change_percent)}</div>
                                        <MiniSparkline
                                            data={[100, 102, 99, 101, 98, 103, 100 + (idx.change ?? 0) / 10]}
                                            color={isUp ? 'var(--bullish)' : 'var(--bearish)'}
                                            width={56}
                                            height={18}
                                        />
                                    </div>
                                </button>
                            );
                        }) : (
                            <div className="col-span-2 text-center py-8 text-gray-600">
                                <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-40" />
                                <p className="text-sm">Market data loading...</p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="lg:col-span-2 rounded-xl border border-edge/5 bg-surface-900/60 p-5">
                    <h2 className="section-title text-sm text-heading mb-4">Quick Actions</h2>
                    <div className="space-y-2">
                        {NAV_CARDS.slice(0, 4).map(({ to, icon: Icon, label, desc, accent }) => (
                            <Link
                                key={to}
                                to={to}
                                className={cn(
                                    'flex items-center justify-between p-3.5 rounded-lg border transition-all duration-150 group',
                                    accent
                                        ? 'border-primary-500/20 bg-primary-600/[0.04] hover:border-primary-500/35'
                                        : 'border-edge/10 bg-surface-800/40 hover:border-edge/20'
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                                        accent ? 'bg-primary-500/15' : 'bg-surface-800/80'
                                    )}>
                                        <Icon className={cn('w-4 h-4', accent ? 'text-primary-600' : 'text-gray-500')} />
                                    </div>
                                    <div>
                                        <span className={cn('text-sm font-semibold block', accent ? 'text-primary-600' : 'text-heading')}>
                                            {label}
                                        </span>
                                        <span className="text-[11px] text-gray-600">{desc}</span>
                                    </div>
                                </div>
                                <ArrowRight className={cn('w-4 h-4 group-hover:translate-x-0.5 transition-transform', accent ? 'text-primary-600' : 'text-gray-500')} />
                            </Link>
                        ))}
                    </div>
                </div>
            </div>

            {/* Holdings + Recent Orders */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl border border-edge/5 bg-surface-900/60 p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="section-title text-sm text-heading">Top Holdings</h2>
                        <Link to="/portfolio" className="text-xs text-primary-600 hover:text-primary-500 transition-colors font-medium">View All →</Link>
                    </div>
                    {topHoldings.length > 0 ? (
                        <div className="space-y-0.5">
                            {topHoldings.map((holding, i) => (
                                <button
                                    type="button"
                                    key={`${holding.symbol}-${i}`}
                                    onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(holding.symbol)}`)}
                                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-surface-800/40 transition-colors text-left"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center text-[11px] font-semibold text-primary-600 flex-shrink-0">
                                            {(cleanSymbol(holding.symbol) || '??').slice(0, 2)}
                                        </div>
                                        <div>
                                            <div className="text-sm font-semibold text-heading">{cleanSymbol(holding.symbol)}</div>
                                            <div className="text-[11px] text-gray-600 font-price tabular-nums">
                                                {holding.quantity} × {formatCurrency(holding.avg_price)}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-sm font-price font-semibold text-heading tabular-nums">{formatCurrency(holding.current_value)}</div>
                                        <div className={cn('text-[11px] font-price tabular-nums', pnlColorClass(holding.pnl))}>
                                            {(holding.pnl ?? 0) >= 0 ? '+' : ''}{formatCurrency(holding.pnl)} ({formatPercent(holding.pnl_percent)})
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-10">
                            <IndianRupee className="w-10 h-10 mx-auto mb-2 text-gray-600 opacity-30" />
                            <p className="text-sm font-medium text-gray-500">No holdings yet</p>
                            <Link to="/terminal" className="inline-flex items-center gap-1.5 mt-2 text-xs text-primary-600 hover:text-primary-500 font-medium transition-colors">
                                Start trading <ArrowRight className="w-3 h-3" />
                            </Link>
                        </div>
                    )}
                </div>

                <div className="rounded-xl border border-edge/5 bg-surface-900/60 p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="section-title text-sm text-heading">Recent Orders</h2>
                        <Link to="/orders" className="text-xs text-primary-600 hover:text-primary-500 transition-colors font-medium">View All →</Link>
                    </div>
                    {recentOrders.length > 0 ? (
                        <div className="space-y-0.5">
                            {recentOrders.map((order, i) => (
                                <button
                                    type="button"
                                    key={`${order.id || order.order_id || i}`}
                                    onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(order.symbol || '')}`)}
                                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-surface-800/40 transition-colors text-left"
                                >
                                    <div className="flex items-center gap-3">
                                        <span className={cn(
                                            'text-[11px] font-semibold px-2 py-0.5 rounded-md',
                                            order.side === 'BUY' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'
                                        )}>
                                            {order.side || '—'}
                                        </span>
                                        <div>
                                            <div className="text-sm font-semibold text-heading">{cleanSymbol(order.symbol || 'N/A')}</div>
                                            <div className="text-[11px] text-gray-600 font-price tabular-nums">{order.quantity ?? 0} qty</div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-sm font-price font-semibold text-heading tabular-nums">
                                            {formatCurrency(order.filled_price ?? order.price)}
                                        </div>
                                        <span className={cn(
                                            'text-[10px] px-1.5 py-0.5 rounded font-semibold',
                                            order.status === 'FILLED'
                                                ? 'text-profit bg-profit/10'
                                                : order.status === 'REJECTED' || order.status === 'CANCELLED'
                                                    ? 'text-loss bg-loss/10'
                                                    : 'text-primary-600 bg-primary-500/10'
                                        )}>
                                            {order.status || 'PENDING'}
                                        </span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-10">
                            <ClipboardList className="w-10 h-10 mx-auto mb-2 text-gray-600 opacity-30" />
                            <p className="text-sm font-medium text-gray-500">No orders yet</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Full Navigation */}
            <div>
                <h2 className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">Explore Modules</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {NAV_CARDS.map(({ to, icon: Icon, label, desc, accent }) => (
                        <Link
                            key={to}
                            to={to}
                            className={cn(
                                'glass-card-hover p-5 flex items-start gap-4 group border transition-all duration-200',
                                accent
                                    ? 'border-blue-200 dark:border-primary-500/15 bg-blue-50 dark:bg-primary-600/[0.04]'
                                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50'
                            )}
                        >
                            <div className={cn(
                                'p-2.5 rounded-lg flex-shrink-0',
                                accent ? 'bg-blue-100 dark:bg-primary-500/10' : 'bg-slate-100 dark:bg-surface-800/60'
                            )}>
                                <Icon className={cn('w-5 h-5', accent ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400')} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className={cn('text-sm font-semibold', accent ? 'text-blue-600 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300')}>
                                        {label}
                                    </span>
                                    <ArrowRight className={cn(
                                        'w-3.5 h-3.5 group-hover:translate-x-0.5 transition-all',
                                        accent
                                            ? 'text-blue-600 dark:text-blue-400 group-hover:text-blue-600 dark:group-hover:text-blue-400'
                                            : 'text-slate-600 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-300'
                                    )} />
                                </div>
                                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{desc}</p>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>
        </div>
    );
}
