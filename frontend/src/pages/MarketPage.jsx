import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarketIndicesStore } from '../stores/useMarketIndicesStore';
import { TrendingUp, TrendingDown, BarChart3, ArrowUpRight, ArrowDownRight, Activity } from 'lucide-react';
import { formatPrice, formatPercent, pnlColorClass, cleanSymbol } from '../utils/formatters';
import { Skeleton } from '../components/ui';
import { cn } from '../utils/cn';

export default function MarketPage() {
    const navigate = useNavigate();
    const indices = useMarketIndicesStore((s) => s.indices);
    const tickerItems = useMarketIndicesStore((s) => s.tickerItems);
    const isLoading = useMarketIndicesStore((s) => s.isLoading);
    const fetchIndices = useMarketIndicesStore((s) => s.fetchIndices);

    // MarketTickerBar (in AppShell) manages the shared polling interval.
    // This page only triggers a one-time refresh of the indices list on mount.
    useEffect(() => {
        fetchIndices();
    }, [fetchIndices]);

    const stockItems = (tickerItems || []).filter((t) => t.symbol && !t.symbol.startsWith('^'));
    const gainers = [...stockItems]
        .filter((s) => s.change_percent > 0)
        .sort((a, b) => b.change_percent - a.change_percent)
        .slice(0, 10);
    const losers = [...stockItems]
        .filter((s) => s.change_percent < 0)
        .sort((a, b) => a.change_percent - b.change_percent)
        .slice(0, 10);

    const stats = useMemo(() => {
        const advances = stockItems.filter((s) => Number(s.change_percent ?? 0) > 0).length;
        const declines = stockItems.filter((s) => Number(s.change_percent ?? 0) < 0).length;
        const unchanged = Math.max(stockItems.length - advances - declines, 0);
        return { advances, declines, unchanged };
    }, [stockItems]);

    const topGainer = gainers[0] || null;
    const topLoser = losers[0] || null;

    return (
        <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-display font-semibold text-heading">Market</h1>
                </div>

                <div className="grid grid-cols-3 gap-2 lg:w-[460px]">
                    <div className="rounded-lg border border-edge/10 bg-surface-900/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">Advances</div>
                        <div className="text-sm font-price tabular-nums text-profit font-semibold">{stats.advances}</div>
                    </div>
                    <div className="rounded-lg border border-edge/10 bg-surface-900/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">Declines</div>
                        <div className="text-sm font-price tabular-nums text-loss font-semibold">{stats.declines}</div>
                    </div>
                    <div className="rounded-lg border border-edge/10 bg-surface-900/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">Unchanged</div>
                        <div className="text-sm font-price tabular-nums text-heading font-semibold">{stats.unchanged}</div>
                    </div>
                </div>
            </div>

            {isLoading && indices.length === 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    <Skeleton variant="stat-card" count={6} />
                </div>
            ) : indices.length > 0 ? (
                <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-4 lg:p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="section-title text-sm text-heading">Benchmark Indices</h2>
                        <span className="text-xs text-gray-500">Click an index to open terminal</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {indices.map((idx, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => idx.symbol && navigate(`/terminal?symbol=${encodeURIComponent(idx.symbol)}`)}
                                disabled={!idx.symbol}
                                title={idx.symbol ? `Open ${idx.name} in Terminal` : undefined}
                                className={cn(
                                    'rounded-xl border border-edge/10 bg-surface-800/55 p-4 text-left transition-all duration-200 min-h-[124px]',
                                    idx.symbol ? 'hover:border-primary-500/30 hover:bg-surface-800/80 cursor-pointer' : 'cursor-default'
                                )}
                            >
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{idx.name}</span>
                                    <div className={cn('p-1.5 rounded-lg', (idx.change ?? 0) >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10')}>
                                        {(idx.change ?? 0) >= 0
                                            ? <ArrowUpRight className="w-4 h-4 text-emerald-600" />
                                            : <ArrowDownRight className="w-4 h-4 text-red-500" />
                                        }
                                    </div>
                                </div>
                                <div className="text-3xl font-price font-semibold text-heading tabular-nums mb-1.5">
                                    {Number(idx.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                                </div>
                                <div className={cn('flex items-center gap-2 text-sm font-price tabular-nums', pnlColorClass(idx.change))}>
                                    <span>{(idx.change ?? 0) > 0 ? '+' : ''}{formatPrice(idx.change)}</span>
                                    <span className="opacity-75">({formatPercent(idx.change_percent)})</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <div className="glass-card p-12 text-center">
                    <BarChart3 className="w-12 h-12 mx-auto mb-3 text-gray-600 opacity-40" />
                    <p className="text-sm font-medium text-gray-500">Market data unavailable</p>
                    <p className="text-xs text-gray-600 mt-1">Data refreshes during market hours (9:15 AM – 3:30 PM IST)</p>
                </div>
            )}

            {stockItems.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="section-title text-sm text-heading flex items-center gap-2">
                                <TrendingUp className="w-4.5 h-4.5 text-emerald-500" />
                                Top Gainers
                            </h2>
                            {topGainer ? <span className="text-xs text-emerald-500 font-price">Leader: {cleanSymbol(topGainer.symbol)}</span> : null}
                        </div>
                        <div className="divide-y divide-edge/8 max-h-[420px] overflow-y-auto">
                            {gainers.map((stock, i) => (
                                <button
                                    type="button"
                                    key={stock.symbol}
                                    onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(stock.symbol)}`)}
                                    className="w-full flex items-center justify-between px-2 py-2.5 hover:bg-overlay/[0.03] transition-colors text-left"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <span className="w-5 text-center text-[11px] text-gray-500 font-price">{i + 1}</span>
                                        <span className="text-sm font-semibold text-heading truncate">{cleanSymbol(stock.symbol)}</span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="font-price text-sm text-heading tabular-nums">{formatPrice(stock.price)}</span>
                                        <span className="font-price text-sm text-emerald-500 font-semibold tabular-nums min-w-[72px] text-right">{formatPercent(stock.change_percent)}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="section-title text-sm text-heading flex items-center gap-2">
                                <TrendingDown className="w-4.5 h-4.5 text-red-500" />
                                Top Losers
                            </h2>
                            {topLoser ? <span className="text-xs text-red-500 font-price">Weakest: {cleanSymbol(topLoser.symbol)}</span> : null}
                        </div>
                        <div className="divide-y divide-edge/8 max-h-[420px] overflow-y-auto">
                            {losers.map((stock, i) => (
                                <button
                                    type="button"
                                    key={stock.symbol}
                                    onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(stock.symbol)}`)}
                                    className="w-full flex items-center justify-between px-2 py-2.5 hover:bg-overlay/[0.03] transition-colors text-left"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <span className="w-5 text-center text-[11px] text-gray-500 font-price">{i + 1}</span>
                                        <span className="text-sm font-semibold text-heading truncate">{cleanSymbol(stock.symbol)}</span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="font-price text-sm text-heading tabular-nums">{formatPrice(stock.price)}</span>
                                        <span className="font-price text-sm text-red-500 font-semibold tabular-nums min-w-[72px] text-right">{formatPercent(stock.change_percent)}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {stockItems.length === 0 && (
                <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-10 text-center">
                    <Activity className="w-10 h-10 mx-auto mb-2 text-gray-500 opacity-40" />
                    <p className="text-sm text-gray-500">Top movers are not available right now.</p>
                </div>
            )}
        </div>
    );
}
