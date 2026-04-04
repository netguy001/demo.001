// OptionsPage.jsx — Live NSE option chain (real market data, paper trading)
import { useEffect, useMemo, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { TrendingUp, RefreshCw } from 'lucide-react';
import Badge from '../components/ui/Badge';
import OptionChain from '../components/trading/OptionChain';
import { useOptionsStore } from '../stores/useOptionsStore';
import { cn } from '../utils/cn';
import { formatCurrency, formatPrice, pnlColorClass } from '../utils/formatters';
import { useBreakpoint } from '../hooks/useBreakpoint';
import api from '../services/api';

// ── Underlyings ──────────────────────────────────────────────────────────────
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'];

// Standard NSE lot sizes per underlying
const LOT_SIZES = {
    NIFTY: 75, BANKNIFTY: 30, SENSEX: 10, FINNIFTY: 40,
    MIDCPNIFTY: 50, NIFTYNXT50: 25,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLotSize(symbol) {
    return LOT_SIZES[symbol?.toUpperCase()] ?? 75;
}

/** Transform NSE API chain row → format expected by OptionChain component */
function transformRow(row) {
    const empty = { ltp: 0, bid: 0, ask: 0, iv: 0, delta: 0, oi: 0, oiChange: 0, volume: 0 };
    const mapSide = (d) =>
        d
            ? {
                  ltp:      d.ltp      ?? 0,
                  bid:      d.bid      ?? 0,
                  ask:      d.ask      ?? 0,
                  iv:       d.iv       ?? 0,
                  delta:    d.delta    ?? 0,
                  oi:       d.oi       ?? 0,
                  oiChange: d.oi_change ?? 0,
                  volume:   d.volume   ?? 0,
              }
            : { ...empty };

    return {
        strike: row.strike,
        ce:     mapSide(row.CE),
        pe:     mapSide(row.PE),
    };
}

function formatExpiryChip(dateStr) {
    const parsed = new Date(dateStr);
    if (Number.isNaN(parsed.getTime())) return dateStr;
    return parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ── Component ────────────────────────────────────────────────────────────────
export default function OptionsPage() {
    // Paper trading (local store — orders/positions only, no chain data)
    const {
        addPosition,
        closePosition,
        placeOptionOrder,
        positions,
        orders,
    } = useOptionsStore();

    const { isMobile } = useBreakpoint();

    // ── Live chain state ───────────────────────────────────────────────────
    const [selectedUnderlying, setSelectedUnderlying] = useState('NIFTY');
    const [selectedExpiry,     setSelectedExpiry]     = useState(null);
    const [expiryList,         setExpiryList]         = useState([]);
    const [underlyingPrice,    setUnderlyingPrice]    = useState(0);
    const [optionChain,        setOptionChain]        = useState([]);
    const [loading,            setLoading]            = useState(false);
    const [error,              setError]              = useState(null);
    const [lastUpdated,        setLastUpdated]        = useState(null);

    // ── Order form state ───────────────────────────────────────────────────
    const [selectedStrike,  setSelectedStrike]  = useState(null);
    const [optionType,      setOptionType]      = useState('CE');
    const [side,            setSide]            = useState('BUY');
    const [orderType,       setOrderType]       = useState('MARKET');
    const [lots,            setLots]            = useState(1);
    const [limitPrice,      setLimitPrice]      = useState('');
    const [premium,         setPremium]         = useState('0');
    const [selectedGreeks,  setSelectedGreeks]  = useState({ delta: 0, theta: 0, iv: 0 });
    const [activeBottomTab, setActiveBottomTab] = useState('positions');
    const [orderSheetOpen,  setOrderSheetOpen]  = useState(false);

    // ── Fetch chain from NSE API ───────────────────────────────────────────
    const fetchChain = useCallback(async (symbol, expiry) => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ strikes: 20 });
            if (expiry) params.append('expiry', expiry);
            const { data } = await api.get(`/options/chain/${symbol}?${params}`);

            const dates = data.expiry_dates ?? [];
            setExpiryList(dates);

            // Auto-select nearest expiry on first load
            if (!expiry && dates.length) {
                setSelectedExpiry(dates[0]);
            }

            setUnderlyingPrice(data.underlying_price ?? 0);
            setOptionChain((data.chain ?? []).map(transformRow));
            setLastUpdated(new Date());
        } catch (err) {
            const msg = err?.response?.data?.detail ?? 'Failed to fetch option chain data.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    }, []);

    // Reload on underlying change
    useEffect(() => {
        setSelectedExpiry(null);
        setOptionChain([]);
        setExpiryList([]);
        fetchChain(selectedUnderlying, null);
    }, [selectedUnderlying, fetchChain]);

    // Reload on expiry change
    useEffect(() => {
        if (selectedExpiry) {
            fetchChain(selectedUnderlying, selectedExpiry);
        }
    }, [selectedExpiry]); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-refresh every 60 s
    useEffect(() => {
        const interval = setInterval(() => {
            fetchChain(selectedUnderlying, selectedExpiry);
        }, 60_000);
        return () => clearInterval(interval);
    }, [selectedUnderlying, selectedExpiry, fetchChain]);

    // ── Helpers ────────────────────────────────────────────────────────────
    const nearestRow = useMemo(() => {
        if (!optionChain.length) return null;
        return optionChain.reduce((closest, row) => {
            if (!closest) return row;
            return Math.abs(row.strike - underlyingPrice) <
                Math.abs(closest.strike - underlyingPrice)
                ? row
                : closest;
        }, null);
    }, [optionChain, underlyingPrice]);

    // Auto-select ATM when chain loads
    useEffect(() => {
        if (!nearestRow) return;
        setSelectedStrike(nearestRow.strike);
        setOptionType('CE');
        setPremium(String(nearestRow.ce.ltp));
        setSelectedGreeks({ delta: nearestRow.ce.delta, theta: 0, iv: nearestRow.ce.iv });
        setSide('BUY');
        setOrderType('MARKET');
        setLimitPrice('');
        setLots(1);
    }, [selectedUnderlying, nearestRow]);

    const getCurrentLtp = (strike, type) => {
        const row = optionChain.find((r) => r.strike === strike);
        if (!row) return 0;
        return type === 'CE' ? row.ce.ltp : row.pe.ltp;
    };

    const lotSize = getLotSize(selectedUnderlying);
    const premiumValue = Number(premium) || 0;
    const effectivePrice = orderType === 'LIMIT' ? Number(limitPrice || premiumValue) : premiumValue;
    const totalValue = lots * lotSize * effectivePrice;

    const selectedSymbol = `${selectedUnderlying} ${selectedStrike ?? nearestRow?.strike ?? 0} ${optionType}`;

    const handleSelectOption = (strike, type, data) => {
        setSelectedStrike(strike);
        setOptionType(type);
        setSide(data?.side || 'BUY');
        setPremium(String(data?.ltp ?? 0));
        setSelectedGreeks({ delta: data?.delta ?? 0, theta: 0, iv: data?.iv ?? 0 });
        if (isMobile) setOrderSheetOpen(true);
    };

    const handleContextAction = ({ action }) => {
        if (action === 'WATCHLIST') toast.success('Added to watchlist (simulation)');
    };

    const handlePlaceOrder = () => {
        if (!selectedStrike) {
            toast.error('Select a strike from the option chain');
            return;
        }
        const order = placeOptionOrder({
            symbol: selectedSymbol,
            underlying: selectedUnderlying,
            expiry: selectedExpiry,
            optionType,
            side,
            lots,
            lotSize,
            premium: effectivePrice,
            type: orderType,
            status: 'EXECUTED',
        });
        addPosition({
            id: `pos_${order.id}`,
            symbol: selectedSymbol,
            strike: selectedStrike,
            optionType,
            side,
            lots,
            lotSize,
            avgPremium: effectivePrice,
            underlying: selectedUnderlying,
            expiry: selectedExpiry,
            time: order.time,
        });
        toast.success(`${side === 'BUY' ? 'Buy' : 'Sell'} order executed (paper trade)`);
    };

    const enrichedPositions = useMemo(() =>
        positions.map((pos) => {
            const ltp = getCurrentLtp(pos.strike, pos.optionType);
            const raw = (ltp - pos.avgPremium) * pos.lots * pos.lotSize;
            return { ...pos, ltp, pnl: pos.side === 'BUY' ? raw : -raw };
        }),
        [positions, optionChain] // eslint-disable-line react-hooks/exhaustive-deps
    );

    // ── Order panel ────────────────────────────────────────────────────────
    const orderPanel = (
        <div className="flex flex-col h-full bg-surface-900 border-l border-edge/10">
            <div className="px-4 py-3 border-b border-edge/5">
                <h3 className="section-title text-xs mb-3">Options Order</h3>
                <div className="space-y-2">
                    <Badge variant="primary" className="font-semibold">{selectedSymbol}</Badge>
                    <div className="text-xs text-gray-500">Expiry: {selectedExpiry}</div>
                    <div className="flex rounded-xl overflow-hidden border border-edge/10 bg-surface-800/60 p-0.5">
                        {['CE', 'PE'].map((type) => (
                            <button key={type} onClick={() => setOptionType(type)}
                                className={cn('flex-1 py-1.5 text-xs font-bold rounded-lg transition-all duration-200',
                                    optionType === type
                                        ? 'bg-primary-600/20 text-primary-600 border border-primary-500/30'
                                        : 'text-gray-500 hover:text-gray-700')}>
                                {type}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                <div className="flex rounded-xl overflow-hidden border border-edge/10 bg-surface-800/60 p-0.5">
                    {[['BUY','bull'],['SELL','bear']].map(([s, cls]) => (
                        <button key={s} onClick={() => setSide(s)}
                            className={cn('flex-1 py-2 text-sm font-bold rounded-lg transition-all duration-200',
                                side === s ? `bg-${cls} text-white shadow-lg shadow-${cls === 'bull' ? 'emerald' : 'red'}-500/20` : 'text-gray-500 hover:text-gray-700')}>
                            {s}
                        </button>
                    ))}
                </div>

                <div>
                    <label className="metric-label block mb-1">Lot Size</label>
                    <select value={lotSize} onChange={() => null}
                        className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none">
                        <option value={lotSize}>1 Lot = {lotSize} Qty</option>
                    </select>
                </div>

                <div>
                    <label className="metric-label block mb-1">Number of Lots</label>
                    <div className="flex items-center border border-edge/10 rounded-lg overflow-hidden bg-surface-800/60">
                        <button type="button" onClick={() => setLots((v) => Math.max(1, v - 1))}
                            className="px-3 py-2 text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all text-lg font-bold flex-shrink-0">−</button>
                        <input type="number" min={1} value={lots}
                            onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))}
                            className="min-w-0 flex-1 text-center bg-transparent text-heading text-sm font-price py-2 focus:outline-none tabular-nums" />
                        <button type="button" onClick={() => setLots((v) => v + 1)}
                            className="px-3 py-2 text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all text-lg font-bold flex-shrink-0">+</button>
                    </div>
                </div>

                <div>
                    <label className="metric-label block mb-1">Order Type</label>
                    <div className="flex rounded-lg overflow-hidden border border-edge/10 bg-surface-800/40 p-0.5 gap-0.5">
                        {['MARKET', 'LIMIT'].map((type) => (
                            <button key={type} onClick={() => setOrderType(type)}
                                className={cn('flex-1 py-1.5 text-xs font-semibold rounded-md transition-all duration-150',
                                    orderType === type ? 'bg-primary-600/25 text-primary-600 shadow-sm' : 'text-gray-500 hover:text-gray-700 hover:bg-surface-700/40')}>
                                {type}
                            </button>
                        ))}
                    </div>
                </div>

                {orderType === 'LIMIT' && (
                    <div>
                        <label className="metric-label block mb-1">Limit Price (₹)</label>
                        <input type="number" step="0.05" value={limitPrice}
                            onChange={(e) => setLimitPrice(e.target.value)}
                            placeholder={formatPrice(premiumValue)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-price text-heading placeholder-gray-600 focus:outline-none focus:border-primary-500/30 tabular-nums" />
                    </div>
                )}

                <div>
                    <label className="metric-label block mb-1">Premium (₹)</label>
                    <input type="number" step="0.05" value={premium}
                        onChange={(e) => setPremium(e.target.value)}
                        className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-price text-heading placeholder-gray-600 focus:outline-none focus:border-primary-500/30 tabular-nums" />
                </div>

                <div className="rounded-xl bg-surface-800/40 border border-edge/5 p-3 space-y-2">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Total Value</span>
                        <span className="font-price text-heading font-semibold tabular-nums">{formatCurrency(totalValue)}</span>
                    </div>
                    {side === 'SELL' && (
                        <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Max Loss</span>
                            <span className="font-price text-bear font-semibold tabular-nums">{formatCurrency(premiumValue * lots * lotSize)}</span>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="default" className="text-[11px]">Delta: {formatPrice(selectedGreeks.delta)}</Badge>
                    <Badge variant="default" className="text-[11px]">IV: {formatPrice(selectedGreeks.iv)}%</Badge>
                </div>
            </div>

            <div className="sticky bottom-0 px-4 py-3 border-t border-edge/5 bg-surface-900">
                <button onClick={handlePlaceOrder}
                    className={cn('w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all',
                        side === 'BUY' ? 'bg-bull hover:brightness-110 shadow-bull' : 'bg-bear hover:brightness-110 shadow-bear')}>
                    {side === 'BUY' ? 'Place Buy Order' : 'Place Sell Order'}
                </button>
            </div>
        </div>
    );

    // ── Render ─────────────────────────────────────────────────────────────
    return (
        <div className="min-h-[calc(100vh-56px)] bg-surface-950 p-4 md:p-6 space-y-4 overflow-y-auto">

            {/* Header toolbar */}
            <div className="rounded-xl border border-edge/5 bg-surface-900/60 px-4 py-3 space-y-3">
                <div className="flex flex-col xl:flex-row xl:items-center gap-3 xl:justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                        {UNDERLYINGS.map((u) => (
                            <button key={u} onClick={() => setSelectedUnderlying(u)}
                                className={cn('px-3 py-1.5 rounded-full text-xs font-semibold border transition-all',
                                    selectedUnderlying === u
                                        ? 'bg-primary-600/20 border-primary-500/40 text-primary-600'
                                        : 'bg-surface-800/80 border-edge/20 text-gray-400 hover:text-gray-700 hover:border-edge/40')}>
                                {u}
                            </button>
                        ))}

                        {underlyingPrice > 0 && (
                            <div className="ml-2 text-2xl font-price font-semibold text-heading tabular-nums">
                                ₹{Number(underlyingPrice).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {lastUpdated && (
                            <span className="text-[11px] text-gray-500">
                                Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                        )}
                        <button onClick={() => fetchChain(selectedUnderlying, selectedExpiry)}
                            disabled={loading}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-heading hover:bg-overlay/5 transition-colors disabled:opacity-50">
                            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                        </button>
                        <Badge variant="primary" dot>NSE LIVE</Badge>
                    </div>
                </div>

                {/* Expiry chips */}
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {expiryList.length === 0 && loading && (
                        <span className="text-xs text-gray-500 animate-pulse">Loading expiry dates…</span>
                    )}
                    {expiryList.map((date) => (
                        <button key={date} onClick={() => setSelectedExpiry(date)}
                            className={cn('whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-semibold border transition-all',
                                selectedExpiry === date
                                    ? 'bg-primary-600/20 border-primary-500/40 text-primary-600'
                                    : 'bg-surface-800/80 border-edge/20 text-gray-400 hover:text-gray-700 hover:border-edge/40')}>
                            {formatExpiryChip(date)}
                        </button>
                    ))}
                </div>
            </div>

            {/* Error state */}
            {error && !loading && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400 flex items-center gap-2">
                    <span>⚠</span>
                    <span>{error} — NSE data may be unavailable outside market hours.</span>
                </div>
            )}

            {/* Option chain + order panel */}
            <div className="flex flex-col lg:flex-row gap-4 min-h-[520px]">
                <div className="flex-1 min-w-0">
                    {loading && optionChain.length === 0 ? (
                        <div className="rounded-xl border border-edge/5 bg-surface-900/60 flex items-center justify-center h-64 text-sm text-gray-500 animate-pulse">
                            Fetching live option chain from NSE…
                        </div>
                    ) : (
                        <OptionChain
                            chain={optionChain}
                            spotPrice={underlyingPrice}
                            onSelectOption={handleSelectOption}
                            onContextAction={handleContextAction}
                        />
                    )}
                </div>

                {!isMobile && (
                    <div className="w-[320px] min-w-[320px] rounded-xl overflow-hidden border border-edge/10 bg-surface-900/60">
                        {orderPanel}
                    </div>
                )}
            </div>

            {/* Positions / Orders */}
            <div className="rounded-xl border border-edge/5 bg-surface-900/60 overflow-hidden">
                <div className="flex border-b border-edge/5">
                    {[['positions', positions.length], ['orders', orders.length]].map(([tab, count]) => (
                        <button key={tab} onClick={() => setActiveBottomTab(tab)}
                            className={cn('px-4 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors',
                                activeBottomTab === tab
                                    ? 'text-primary-600 border-b-2 border-primary-500'
                                    : 'text-gray-500 hover:text-gray-700')}>
                            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({count})
                        </button>
                    ))}
                </div>

                <div className="overflow-x-auto">
                    {activeBottomTab === 'positions' ? (
                        enrichedPositions.length > 0 ? (
                            <table className="w-full text-sm min-w-[860px]">
                                <thead>
                                    <tr className="border-b border-edge/5">
                                        {['Symbol','Type','Lots','Avg Premium','LTP','P&L','Action'].map((h) => (
                                            <th key={h} className={cn('py-3 px-3 text-[11px] font-medium tracking-wider uppercase text-gray-500',
                                                h === 'Symbol' ? 'text-left' : 'text-right')}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {enrichedPositions.map((pos) => (
                                        <tr key={pos.id} className="border-b border-edge/[0.025] hover:bg-overlay/[0.02] transition-colors">
                                            <td className="py-3 px-3 font-medium text-heading">{pos.symbol}</td>
                                            <td className="py-3 px-3 text-right">
                                                <Badge variant={pos.side === 'BUY' ? 'bull' : 'bear'}>{pos.side}</Badge>
                                            </td>
                                            <td className="py-3 px-3 text-right font-price tabular-nums text-gray-400">{pos.lots}</td>
                                            <td className="py-3 px-3 text-right font-price tabular-nums text-gray-400">₹{formatPrice(pos.avgPremium)}</td>
                                            <td className="py-3 px-3 text-right font-price tabular-nums text-heading">₹{formatPrice(pos.ltp)}</td>
                                            <td className={cn('py-3 px-3 text-right font-price tabular-nums font-semibold', pnlColorClass(pos.pnl))}>
                                                {pos.pnl >= 0 ? '+' : ''}{formatCurrency(pos.pnl)}
                                            </td>
                                            <td className="py-3 px-3 text-right">
                                                <button onClick={() => closePosition(pos.id)}
                                                    className="text-xs px-2 py-1 rounded border border-edge/20 text-gray-400 hover:text-heading hover:bg-overlay/[0.04] transition-colors">
                                                    Close
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="text-center py-10 text-sm text-gray-500">No open option positions.</div>
                        )
                    ) : (
                        orders.length > 0 ? (
                            <table className="w-full text-sm min-w-[860px]">
                                <thead>
                                    <tr className="border-b border-edge/5">
                                        {['Time','Symbol','Type','B/S','Lots','Premium','Status'].map((h, i) => (
                                            <th key={h} className={cn('py-3 px-3 text-[11px] font-medium tracking-wider uppercase text-gray-500',
                                                i < 4 ? 'text-left' : 'text-right')}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((order) => (
                                        <tr key={order.id} className="border-b border-edge/[0.025] hover:bg-overlay/[0.02] transition-colors">
                                            <td className="py-3 px-3 text-gray-400 font-price tabular-nums text-xs">
                                                {new Date(order.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                            </td>
                                            <td className="py-3 px-3 font-medium text-heading">{order.symbol}</td>
                                            <td className="py-3 px-3 text-gray-400">{order.optionType}</td>
                                            <td className="py-3 px-3">
                                                <Badge variant={order.side === 'BUY' ? 'bull' : 'bear'}>{order.side}</Badge>
                                            </td>
                                            <td className="py-3 px-3 text-right font-price tabular-nums text-gray-400">{order.lots}</td>
                                            <td className="py-3 px-3 text-right font-price tabular-nums text-heading">₹{formatPrice(order.premium)}</td>
                                            <td className="py-3 px-3 text-right">
                                                <Badge variant={order.status === 'EXECUTED' ? 'primary' : 'default'}>{order.status}</Badge>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="text-center py-10 text-sm text-gray-500">No option orders yet.</div>
                        )
                    )}
                </div>
            </div>

            {/* Mobile floating order button */}
            {isMobile && (
                <>
                    <button onClick={() => setOrderSheetOpen(true)}
                        className="fixed bottom-5 right-4 z-30 px-4 py-2 rounded-full bg-primary-600 text-white text-sm font-semibold shadow-panel">
                        Options Order
                    </button>

                    {orderSheetOpen && (
                        <div className="fixed inset-0 z-40">
                            <div className="absolute inset-0 bg-black/55" onClick={() => setOrderSheetOpen(false)} />
                            <div className="absolute left-0 right-0 bottom-0 rounded-t-2xl border-t border-edge/10 bg-surface-900 max-h-[82vh] overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2.5 border-b border-edge/10">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-heading">
                                        <TrendingUp className="w-4 h-4 text-primary-600" />
                                        Options Order
                                    </div>
                                    <button onClick={() => setOrderSheetOpen(false)}
                                        className="text-gray-400 hover:text-heading text-lg font-light">✕</button>
                                </div>
                                <div className="overflow-y-auto max-h-[calc(82vh-48px)]">{orderPanel}</div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
