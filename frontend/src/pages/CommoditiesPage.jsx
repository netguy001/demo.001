import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarketStore } from '../store/useMarketStore';
import { useCommodityStore } from '../stores/useCommodityStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatCurrency, formatPercent, pnlColorClass } from '../utils/formatters';
import { MCX_SYMBOLS } from '../utils/constants';
import { Skeleton } from '../components/ui';
import { cn } from '../utils/cn';
import {
    Gem, Flame, Wheat,
    Search, TrendingUp, TrendingDown, Radio, Wifi, WifiOff,
} from 'lucide-react';

/* ─── Category config ──────────────────────────────────────── */
const CATEGORY_CONFIG = {
    all:         { label: 'All',          icon: null },
    metals:      { label: 'Metals',       icon: Gem },
    energy:      { label: 'Energy',       icon: Flame },
    agriculture: { label: 'Agriculture',  icon: Wheat },
};

/* ─── Tiny sparkline (SVG) ─────────────────────────────────── */
function Sparkline({ data = [], width = 80, height = 24, color = '#22c55e' }) {
    if (data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const points = data
        .map((v, i) => {
            const x = (i / (data.length - 1)) * width;
            const y = height - ((v - min) / range) * height;
            return `${x},${y}`;
        })
        .join(' ');
    return (
        <svg width={width} height={height} className="flex-shrink-0">
            <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/* ─── Flash wrapper — animates on price change ─────────────── */
function FlashCell({ flash, children, className }) {
    return (
        <span
            className={cn(
                className,
                'transition-colors duration-500',
                flash === 'up' && 'animate-pulse text-emerald-400',
                flash === 'down' && 'animate-pulse text-red-400',
            )}
        >
            {children}
        </span>
    );
}

/* ─── Main page ────────────────────────────────────────────── */
export default function CommoditiesPage() {
    const navigate = useNavigate();
    const { status: wsStatus, subscribe } = useWebSocket();

    // Stores
    const quotes = useCommodityStore((s) => s.quotes);
    const tickHistory = useCommodityStore((s) => s.tickHistory);
    const isLoading = useCommodityStore((s) => s.isLoading);
    const source = useCommodityStore((s) => s.source);
    const fetchCommodities = useCommodityStore((s) => s.fetchCommodities);
    const applyTick = useCommodityStore((s) => s.applyTick);
    const getFlash = useCommodityStore((s) => s.getFlash);

    // MarketStore — receives WS quotes
    const marketSymbols = useMarketStore((s) => s.symbols);

    const [activeCategory, setActiveCategory] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');

    // ── Initial load ──────────────────────────────────────────
    useEffect(() => {
        fetchCommodities();
    }, [fetchCommodities]);

    // ── Subscribe MCX symbols to WebSocket ────────────────────
    useEffect(() => {
        const mcxSymbols = [...MCX_SYMBOLS];
        if (mcxSymbols.length > 0) {
            subscribe(mcxSymbols);
        }
    }, [subscribe]);

    // ── Bridge: pipe WS quotes from MarketStore into CommodityStore ──
    useEffect(() => {
        // Check each MCX symbol in MarketStore for new data
        for (const sym of MCX_SYMBOLS) {
            const wsQuote = marketSymbols[sym];
            if (wsQuote && wsQuote.price) {
                applyTick(sym, wsQuote);
            }
        }
    }, [marketSymbols, applyTick]);

    // ── Derive display list from store ────────────────────────
    const commodityList = useMemo(() => {
        return Object.values(quotes).filter((q) => q && q.symbol);
    }, [quotes]);

    const filtered = useMemo(() => {
        let items = commodityList;
        if (activeCategory !== 'all') {
            items = items.filter((c) => c.category === activeCategory);
        }
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toUpperCase();
            items = items.filter(
                (c) =>
                    (c.name || '').toUpperCase().includes(q) ||
                    (c.symbol || '').toUpperCase().includes(q)
            );
        }
        return items;
    }, [commodityList, activeCategory, searchQuery]);

    const gainers = useMemo(() =>
        [...filtered].filter((c) => (c.change_percent ?? 0) > 0)
            .sort((a, b) => b.change_percent - a.change_percent),
        [filtered]
    );
    const losers = useMemo(() =>
        [...filtered].filter((c) => (c.change_percent ?? 0) < 0)
            .sort((a, b) => a.change_percent - b.change_percent),
        [filtered]
    );

    const stats = useMemo(() => ({
        total: filtered.length,
        up: filtered.filter((c) => (c.change_percent ?? 0) > 0).length,
        down: filtered.filter((c) => (c.change_percent ?? 0) < 0).length,
        flat: filtered.filter((c) => (c.change_percent ?? 0) === 0).length,
    }), [filtered]);

    return (
        <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
            {/* ── Header ────────────────────────────────────────── */}
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-display font-semibold text-heading">Commodities</h1>
                    <div className="flex items-center gap-2 mt-1">
                        <p className="text-gray-500 text-sm">MCX & NCDEX commodity futures</p>
                        {/* Connection + source badge */}
                        {wsStatus === 'connected' ? (
                            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium">
                                <Wifi className="w-3 h-3" /> WS LIVE
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-500/10 text-gray-400 font-medium">
                                <WifiOff className="w-3 h-3" /> {wsStatus}
                            </span>
                        )}
                        {source === 'live' ? (
                            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">
                                <Radio className="w-3 h-3" /> Zebu
                            </span>
                        ) : source === 'simulated' ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                                SIMULATED
                            </span>
                        ) : null}
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-2 lg:w-[360px]">
                    <div className="rounded-lg border border-edge/10 bg-surface-900/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">Up</div>
                        <div className="text-sm font-price tabular-nums text-profit font-semibold">{stats.up}</div>
                    </div>
                    <div className="rounded-lg border border-edge/10 bg-surface-900/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">Down</div>
                        <div className="text-sm font-price tabular-nums text-loss font-semibold">{stats.down}</div>
                    </div>
                    <div className="rounded-lg border border-edge/10 bg-surface-900/60 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">Flat</div>
                        <div className="text-sm font-price tabular-nums text-heading font-semibold">{stats.flat}</div>
                    </div>
                </div>
            </div>

            {/* ── Category tabs + Search ────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex gap-1.5 bg-surface-900/50 rounded-xl p-1 border border-edge/8">
                    {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => (
                        <button
                            key={key}
                            onClick={() => setActiveCategory(key)}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                                activeCategory === key
                                    ? 'bg-primary-500/15 text-primary-400 shadow-sm'
                                    : 'text-gray-500 hover:text-heading hover:bg-overlay/[0.04]'
                            )}
                        >
                            {cfg.icon && <cfg.icon className="w-3.5 h-3.5" />}
                            {cfg.label}
                        </button>
                    ))}
                </div>
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                        type="text"
                        placeholder="Search commodities..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-edge/10 bg-surface-900/60 text-heading placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
                    />
                </div>
            </div>

            {/* ── Main table ────────────────────────────────────── */}
            {isLoading && commodityList.length === 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    <Skeleton variant="stat-card" count={6} />
                </div>
            ) : filtered.length > 0 ? (
                <>
                    <div className="rounded-xl border border-edge/8 bg-surface-900/55 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-edge/10 bg-surface-800/40">
                                        <th className="text-left px-4 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Symbol</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">LTP</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Change</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Bid</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Ask</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Volume</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">OI</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">High</th>
                                        <th className="text-right px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Low</th>
                                        <th className="text-center px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Trend</th>
                                        <th className="text-center px-3 py-3 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Trade</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-edge/6">
                                    {filtered.map((c) => {
                                        const flash = getFlash(c.symbol);
                                        const chg = c.change ?? 0;
                                        const chgPct = c.change_percent ?? 0;
                                        const sparkData = tickHistory[c.symbol] || [];
                                        const sparkColor = chg >= 0 ? '#22c55e' : '#ef4444';

                                        return (
                                            <tr
                                                key={c.symbol}
                                                onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(c.symbol)}`)}
                                                className="hover:bg-overlay/[0.06] transition-colors cursor-pointer group"
                                            >
                                                {/* Symbol + meta */}
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <div>
                                                            <div className="font-semibold text-heading text-sm group-hover:text-primary-400 transition-colors">{c.symbol}</div>
                                                            <div className="text-[10px] text-gray-500">{c.name}</div>
                                                        </div>
                                                        <span className={cn(
                                                            'text-[8px] px-1 py-0.5 rounded font-medium',
                                                            c.exchange === 'MCX' ? 'bg-blue-500/10 text-blue-400' : 'bg-teal-500/10 text-teal-400',
                                                        )}>{c.exchange}</span>
                                                    </div>
                                                </td>

                                                {/* LTP with flash */}
                                                <td className="text-right px-3 py-3">
                                                    <FlashCell flash={flash} className="font-price font-semibold text-heading tabular-nums">
                                                        {formatCurrency(c.price)}
                                                    </FlashCell>
                                                    <div className="text-[9px] text-gray-600">{c.unit}</div>
                                                </td>

                                                {/* Change */}
                                                <td className="text-right px-3 py-3">
                                                    <div className={cn('font-price tabular-nums font-medium', pnlColorClass(chg))}>
                                                        {chg > 0 ? '+' : ''}{formatCurrency(chg)}
                                                    </div>
                                                    <div className={cn('text-[10px] font-price tabular-nums', pnlColorClass(chg))}>
                                                        {formatPercent(chgPct)}
                                                    </div>
                                                </td>

                                                {/* Bid */}
                                                <td className="text-right px-3 py-3 font-price tabular-nums text-emerald-400">
                                                    {c.bid_price ? formatCurrency(c.bid_price) : '—'}
                                                    {c.bid_qty > 0 && <div className="text-[9px] text-gray-600">{c.bid_qty}</div>}
                                                </td>

                                                {/* Ask */}
                                                <td className="text-right px-3 py-3 font-price tabular-nums text-red-400">
                                                    {c.ask_price ? formatCurrency(c.ask_price) : '—'}
                                                    {c.ask_qty > 0 && <div className="text-[9px] text-gray-600">{c.ask_qty}</div>}
                                                </td>

                                                {/* Volume */}
                                                <td className="text-right px-3 py-3 font-price tabular-nums text-gray-400">
                                                    {c.volume ? Number(c.volume).toLocaleString('en-IN') : '—'}
                                                </td>

                                                {/* OI */}
                                                <td className="text-right px-3 py-3 font-price tabular-nums text-gray-400">
                                                    {c.oi ? Number(c.oi).toLocaleString('en-IN') : '—'}
                                                </td>

                                                {/* High */}
                                                <td className="text-right px-3 py-3 font-price tabular-nums text-gray-300">
                                                    {c.high ? formatCurrency(c.high) : '—'}
                                                </td>

                                                {/* Low */}
                                                <td className="text-right px-3 py-3 font-price tabular-nums text-gray-300">
                                                    {c.low ? formatCurrency(c.low) : '—'}
                                                </td>

                                                {/* Sparkline */}
                                                <td className="text-center px-3 py-3">
                                                    <Sparkline data={sparkData} color={sparkColor} />
                                                </td>

                                                {/* Trade buttons */}
                                                <td className="text-center px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                                    <div className="flex items-center justify-center gap-1.5">
                                                        <button
                                                            onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(c.symbol)}&side=BUY`)}
                                                            className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-all"
                                                        >
                                                            B
                                                        </button>
                                                        <button
                                                            onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(c.symbol)}&side=SELL`)}
                                                            className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/40 transition-all"
                                                        >
                                                            S
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* ── Gainers & Losers ──────────────────────────── */}
                    {(gainers.length > 0 || losers.length > 0) && (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            {gainers.length > 0 && (
                                <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-4">
                                    <h2 className="section-title text-sm text-heading flex items-center gap-2 mb-3">
                                        <TrendingUp className="w-4.5 h-4.5 text-emerald-500" /> Gainers
                                    </h2>
                                    <div className="divide-y divide-edge/8">
                                        {gainers.map((c, i) => (
                                            <div
                                                key={c.symbol}
                                                onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(c.symbol)}`)}
                                                className="flex items-center justify-between px-2 py-2.5 cursor-pointer hover:bg-overlay/[0.04] rounded-lg transition-colors"
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <span className="w-5 text-center text-[11px] text-gray-500 font-price">{i + 1}</span>
                                                    <div>
                                                        <span className="text-sm font-semibold text-heading">{c.symbol}</span>
                                                        <span className="text-[10px] text-gray-500 ml-1.5">{c.name}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <span className="font-price text-sm text-heading tabular-nums">{formatCurrency(c.price)}</span>
                                                    <span className="font-price text-sm text-emerald-500 font-semibold tabular-nums min-w-[72px] text-right">{formatPercent(c.change_percent)}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {losers.length > 0 && (
                                <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-4">
                                    <h2 className="section-title text-sm text-heading flex items-center gap-2 mb-3">
                                        <TrendingDown className="w-4.5 h-4.5 text-red-500" /> Losers
                                    </h2>
                                    <div className="divide-y divide-edge/8">
                                        {losers.map((c, i) => (
                                            <div
                                                key={c.symbol}
                                                onClick={() => navigate(`/terminal?symbol=${encodeURIComponent(c.symbol)}`)}
                                                className="flex items-center justify-between px-2 py-2.5 cursor-pointer hover:bg-overlay/[0.04] rounded-lg transition-colors"
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <span className="w-5 text-center text-[11px] text-gray-500 font-price">{i + 1}</span>
                                                    <div>
                                                        <span className="text-sm font-semibold text-heading">{c.symbol}</span>
                                                        <span className="text-[10px] text-gray-500 ml-1.5">{c.name}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <span className="font-price text-sm text-heading tabular-nums">{formatCurrency(c.price)}</span>
                                                    <span className="font-price text-sm text-red-500 font-semibold tabular-nums min-w-[72px] text-right">{formatPercent(c.change_percent)}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </>
            ) : (
                <div className="rounded-xl border border-edge/8 bg-surface-900/55 p-12 text-center">
                    <Gem className="w-12 h-12 mx-auto mb-3 text-gray-600 opacity-40" />
                    <p className="text-sm font-medium text-gray-500">No commodities found</p>
                </div>
            )}
        </div>
    );
}
