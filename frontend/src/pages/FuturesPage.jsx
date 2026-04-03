import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';
import Modal from '../components/ui/Modal';
import Badge from '../components/ui/Badge';
import { useMarketIndicesStore } from '../stores/useMarketIndicesStore';
import { cn } from '../utils/cn';
import { formatCurrency, formatQuantity, formatPrice } from '../utils/formatters';
import { Search, LineChart, TrendingUp, BarChart3 } from 'lucide-react';

const FALLBACK_STOCKS = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'SBIN', 'LT', 'ITC', 'AXISBANK', 'HINDUNILVR',
];

const EXPIRIES = ['24-MAR-2026', '30-MAR-2026', '07-APR-2026', '13-APR-2026', '21-APR-2026', '28-APR-2026', '26-MAY-2026'];

const LOT_SIZE_MAP = {
    RELIANCE: 250, TCS: 150, HDFCBANK: 300, INFY: 300, ICICIBANK: 350,
    SBIN: 750, LT: 175, ITC: 1600, AXISBANK: 400, HINDUNILVR: 300,
};

const sanitizeSymbol = (symbol = '') => String(symbol).replace(/\.(NS|BO)$/i, '').trim().toUpperCase();

function symbolHash(input) {
    let hash = 0;
    const normalized = String(input || '');
    for (let index = 0; index < normalized.length; index += 1) {
        hash = (hash << 5) - hash + normalized.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash);
}

function lotSize(symbol) {
    return LOT_SIZE_MAP[symbol] || 250;
}

function priceStep(spotPrice) {
    if (spotPrice < 300) return 5;
    if (spotPrice < 1000) return 10;
    if (spotPrice < 3000) return 20;
    return 50;
}

function dummySpot(symbol) {
    const base = 120 + (symbolHash(symbol) % 4200);
    return Number((base + 0.35).toFixed(2));
}

/** Approximation of error function (erf) */
function erfApprox(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
}

/** Approximate Greeks using simplified Black-Scholes */
function calculateGreeks(S, K, T, r, sigma, optionType) {
    if (T <= 0) T = 0.01;
    if (sigma <= 0) sigma = 0.25;

    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);

    const Phi = (x) => (1 + erfApprox(x / Math.sqrt(2))) / 2;
    const phi = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

    if (optionType === 'call') {
        const delta = Phi(d1);
        const gamma = phi(d1) / (S * sigma * Math.sqrt(T));
        const vega = S * phi(d1) * Math.sqrt(T) / 100;
        const theta = (-S * phi(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * Phi(d2);
        return {
            delta: Math.max(0, Math.min(1, delta)),
            gamma: Math.max(0, Math.min(1, gamma)),
            vega: vega / 100,
            theta: theta / 365,
        };
    } else {
        const delta = Phi(d1) - 1;
        const gamma = phi(d1) / (S * sigma * Math.sqrt(T));
        const vega = S * phi(d1) * Math.sqrt(T) / 100;
        const theta = (-S * phi(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * Phi(-d2);
        return {
            delta: Math.max(-1, Math.min(0, delta)),
            gamma: Math.max(0, Math.min(1, gamma)),
            vega: vega / 100,
            theta: theta / 365,
        };
    }
}

function buildChainWithGreeks(symbol, spotPrice) {
    const step = priceStep(spotPrice);
    const atm = Math.round(spotPrice / step) * step;
    const rows = [];
    const T = 30 / 365; // 30 days to expiry
    const r = 0.05; // Risk-free rate

    for (let index = -4; index <= 5; index += 1) {
        const K = atm + index * step;
        const rowHash = symbolHash(`${symbol}-${K}`);

        // Base prices
        const callLtp = Number((Math.max(1, spotPrice - K + (rowHash % 120) / 10 + 8)).toFixed(2));
        const putLtp = Number((Math.max(1, K - spotPrice + (rowHash % 110) / 10 + 8)).toFixed(2));

        // IV varies by strike (volatility smile)
        const moneyness = Math.abs(spotPrice - K) / spotPrice;
        const baseIV = 0.20 + moneyness * 0.08;
        const callIV = baseIV + (rowHash % 50) / 1000;
        const putIV = baseIV + (rowHash % 60) / 1000;

        // Greeks
        const callGreeks = calculateGreeks(spotPrice, K, T, r, callIV, 'call');
        const putGreeks = calculateGreeks(spotPrice, K, T, r, putIV, 'put');

        // Volume and OI
        const callVolume = 1000 + (rowHash % 8000);
        const putVolume = 1200 + (rowHash % 9000);
        const callOi = 15000 + (rowHash % 135000);
        const putOi = 18000 + (rowHash % 145000);

        // Bid-Ask spreads
        const callBid = (callLtp * 0.98).toFixed(2);
        const callAsk = (callLtp * 1.02).toFixed(2);
        const putBid = (putLtp * 0.98).toFixed(2);
        const putAsk = (putLtp * 1.02).toFixed(2);

        rows.push({
            strike: K,
            moneyness: moneyness > 0.05 ? (spotPrice > K ? 'ITM' : 'OTM') : 'ATM',
            
            // Call data
            callLtp: Number(callLtp.toFixed(2)),
            callBid: Number(callBid),
            callAsk: Number(callAsk),
            callIV: (callIV * 100).toFixed(2),
            callDelta: callGreeks.delta.toFixed(2),
            callGamma: callGreeks.gamma.toFixed(4),
            callVega: callGreeks.vega.toFixed(3),
            callTheta: callGreeks.theta.toFixed(4),
            callVolume,
            callOi,
            callChange: ((rowHash % 240) - 120) / 45,

            // Put data
            putLtp: Number(putLtp.toFixed(2)),
            putBid: Number(putBid),
            putAsk: Number(putAsk),
            putIV: (putIV * 100).toFixed(2),
            putDelta: putGreeks.delta.toFixed(2),
            putGamma: putGreeks.gamma.toFixed(4),
            putVega: putGreeks.vega.toFixed(3),
            putTheta: putGreeks.theta.toFixed(4),
            putVolume,
            putOi,
            putChange: ((rowHash % 220) - 110) / 45,

            lot: lotSize(symbol),
        });
    }

    return rows;
}

function getMoneynessBgColor(moneyness) {
    if (moneyness === 'ITM') return 'bg-emerald-500/10 border-emerald-500/20';
    if (moneyness === 'OTM') return 'bg-red-500/10 border-red-500/20';
    return 'bg-amber-500/10 border-amber-500/20';
}

function getMoneynessBadgeColor(moneyness) {
    if (moneyness === 'ITM') return 'bg-emerald-500/20 text-emerald-500';
    if (moneyness === 'OTM') return 'bg-red-500/20 text-red-500';
    return 'bg-amber-500/20 text-amber-500';
}

function FuturesOrderModal({ isOpen, onClose, symbol, expiry, row, side }) {
    const [orderSide, setOrderSide] = useState(side || 'BUY');
    const [orderType, setOrderType] = useState('LIMIT');
    const [productType, setProductType] = useState('NRML');
    const [lots, setLots] = useState(1);
    const [limitPrice, setLimitPrice] = useState('');

    useEffect(() => {
        setOrderSide(side || 'BUY');
        setOrderType('LIMIT');
        setProductType('NRML');
        setLots(1);
        if (row) setLimitPrice(String(row.callLtp));
    }, [row, side]);

    if (!row) return null;

    const qty = lots * row.lot;
    const effectivePrice = Number(limitPrice || row.callLtp);
    const orderValue = qty * effectivePrice;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Futures Order" size="md">
            <div className="p-5 space-y-4">
                <div className="rounded-lg border border-edge/10 bg-surface-900/50 p-3">
                    <p className="text-xs text-gray-500">Contract</p>
                    <p className="text-sm font-semibold text-heading mt-1">{symbol} FUT {expiry}</p>
                    <p className="text-xs text-gray-500 mt-1">Strike {row.strike} • Lot {row.lot}</p>
                </div>

                <div className="flex rounded-xl overflow-hidden border border-edge/10 bg-surface-800/60 p-0.5">
                    {['BUY', 'SELL'].map((value) => (
                        <button
                            key={value}
                            onClick={() => setOrderSide(value)}
                            className={cn(
                                'flex-1 py-2 text-sm font-bold rounded-lg transition-all duration-200',
                                orderSide === value
                                    ? value === 'BUY' ? 'bg-bull text-white' : 'bg-bear text-white'
                                    : 'text-gray-500 hover:text-gray-700'
                            )}
                        >
                            {value}
                        </button>
                    ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className="metric-label block mb-1">Order Type</label>
                        <select
                            value={orderType}
                            onChange={(event) => setOrderType(event.target.value)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none"
                        >
                            <option value="LIMIT">LIMIT</option>
                            <option value="MARKET">MARKET</option>
                        </select>
                    </div>
                    <div>
                        <label className="metric-label block mb-1">Product</label>
                        <select
                            value={productType}
                            onChange={(event) => setProductType(event.target.value)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none"
                        >
                            <option value="NRML">NRML</option>
                            <option value="MIS">MIS</option>
                        </select>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className="metric-label block mb-1">Lots</label>
                        <input
                            type="number"
                            min={1}
                            value={lots}
                            onChange={(event) => setLots(Math.max(1, Number(event.target.value) || 1))}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="metric-label block mb-1">Limit Price (₹)</label>
                        <input
                            type="number"
                            step="0.05"
                            value={limitPrice}
                            onChange={(event) => setLimitPrice(event.target.value)}
                            disabled={orderType === 'MARKET'}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none disabled:opacity-60"
                        />
                    </div>
                </div>

                <div className="rounded-lg border border-edge/10 bg-surface-900/50 p-3 space-y-1.5">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Quantity</span>
                        <span className="text-heading font-medium tabular-nums">{formatQuantity(qty)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Estimated Value</span>
                        <span className="text-heading font-medium tabular-nums">{formatCurrency(orderValue)}</span>
                    </div>
                </div>

                <button
                    type="button"
                    className={cn(
                        'w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all',
                        orderSide === 'BUY' ? 'bg-bull hover:brightness-110' : 'bg-bear hover:brightness-110'
                    )}
                >
                    Place {orderSide} Order
                </button>
            </div>
        </Modal>
    );
}

export default function FuturesPage() {
    const tickerItems = useMarketIndicesStore((state) => state.tickerItems);
    const fetchTicker = useMarketIndicesStore((state) => state.fetchTicker);

    const [selectedExpiry, setSelectedExpiry] = useState(EXPIRIES[0]);
    const [selectedSymbol, setSelectedSymbol] = useState(FALLBACK_STOCKS[0]);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [showResults, setShowResults] = useState(false);
    const [orderPopup, setOrderPopup] = useState({ open: false, row: null, side: 'BUY' });
    const [viewMode, setViewMode] = useState('standard'); // 'standard' | 'greeks' | 'iv'
    const [filterMoneyness, setFilterMoneyness] = useState('all'); // 'all' | 'itm' | 'atm' | 'otm'

    const searchRef = useRef(null);

    useEffect(() => {
        fetchTicker();
    }, [fetchTicker]);

    const stockUniverse = useMemo(() => {
        const fromTicker = tickerItems
            .filter((item) => item.kind !== 'index')
            .map((item) => sanitizeSymbol(item.symbol || item.name));

        return [...FALLBACK_STOCKS, ...fromTicker]
            .filter(Boolean)
            .filter((value, index, self) => self.indexOf(value) === index)
            .sort((a, b) => a.localeCompare(b));
    }, [tickerItems]);

    useEffect(() => {
        if (!stockUniverse.includes(selectedSymbol)) {
            setSelectedSymbol(stockUniverse[0] || FALLBACK_STOCKS[0]);
        }
    }, [stockUniverse, selectedSymbol]);

    useEffect(() => {
        if (searchQuery.trim().length < 1) {
            setSearchResults(stockUniverse.slice(0, 100).map((symbol) => ({ symbol, name: symbol, exchange: 'NSE' })));
            return;
        }

        const localMatches = stockUniverse
            .filter((symbol) => symbol.includes(searchQuery.trim().toUpperCase()))
            .slice(0, 60)
            .map((symbol) => ({ symbol, name: symbol, exchange: 'NSE' }));

        const timeout = setTimeout(async () => {
            try {
                const response = await api.get(`/market/search?q=${encodeURIComponent(searchQuery.trim())}`);
                const apiResults = (response.data.results || []).map((item) => ({
                    symbol: sanitizeSymbol(item.symbol),
                    name: item.name || sanitizeSymbol(item.symbol),
                    exchange: item.exchange || 'NSE',
                }));

                const merged = [...apiResults, ...localMatches]
                    .filter((item) => item.symbol)
                    .filter((item, index, self) => self.findIndex((target) => target.symbol === item.symbol) === index)
                    .slice(0, 100);

                setSearchResults(merged);
            } catch {
                setSearchResults(localMatches);
            }
        }, 200);

        return () => clearTimeout(timeout);
    }, [searchQuery, stockUniverse]);

    useEffect(() => {
        const onOutside = (event) => {
            if (searchRef.current && !searchRef.current.contains(event.target)) {
                setShowResults(false);
            }
        };
        document.addEventListener('mousedown', onOutside);
        return () => document.removeEventListener('mousedown', onOutside);
    }, []);

    const spot = useMemo(() => dummySpot(selectedSymbol), [selectedSymbol]);
    const rows = useMemo(() => buildChainWithGreeks(selectedSymbol, spot), [selectedSymbol, spot]);

    const filteredRows = useMemo(() => {
        if (filterMoneyness === 'all') return rows;
        return rows.filter((r) => r.moneyness.toLowerCase() === filterMoneyness);
    }, [rows, filterMoneyness]);

    const openOrderPopup = (row, side) => setOrderPopup({ open: true, row, side });

    // Calculate IV statistics
    const avgCallIV = (rows.reduce((sum, r) => sum + parseFloat(r.callIV), 0) / rows.length).toFixed(2);
    const avgPutIV = (rows.reduce((sum, r) => sum + parseFloat(r.putIV), 0) / rows.length).toFixed(2);

    return (
        <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
            {/* Header */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-display font-bold text-heading">Options Chain</h1>
                </div>
                <div className="flex gap-2">
                    <Badge variant="primary" className="font-semibold">Simulation Data Only</Badge>
                </div>
            </div>

            {/* Controls */}
            <div className="glass-card p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative flex-1 lg:w-[380px]" ref={searchRef}>
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            onFocus={() => setShowResults(true)}
                            placeholder="Search stocks… (e.g. RELIANCE, TCS)"
                            className={cn(
                                'w-full bg-surface-800/60 border border-edge/5 rounded-lg',
                                'pl-10 pr-3 py-2 text-sm text-heading placeholder-gray-500',
                                'focus:outline-none focus:border-primary-500/30'
                            )}
                        />

                        {showResults && (
                            <div className="absolute top-full left-0 mt-1 w-full bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 max-h-[320px] overflow-y-auto">
                                {searchResults.length > 0 ? (
                                    searchResults.map((stock) => (
                                        <button
                                            key={stock.symbol}
                                            onClick={() => {
                                                setSelectedSymbol(sanitizeSymbol(stock.symbol));
                                                setSearchQuery('');
                                                setShowResults(false);
                                            }}
                                            className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800 border-b border-gray-100 dark:border-slate-700 last:border-0"
                                        >
                                            <span className="font-semibold text-gray-900 dark:text-slate-100">{sanitizeSymbol(stock.symbol)}</span>
                                        </button>
                                    ))
                                ) : (
                                    <div className="px-4 py-3 text-center text-xs text-gray-500">No stocks found</div>
                                )}
                            </div>
                        )}
                    </div>

                    <select
                        value={selectedExpiry}
                        onChange={(event) => setSelectedExpiry(event.target.value)}
                        className="h-10 min-w-[150px] bg-surface-800/60 border border-edge/10 rounded-lg px-3 text-sm font-semibold text-heading focus:outline-none"
                    >
                        {EXPIRIES.map((expiry) => (
                            <option key={expiry} value={expiry}>{expiry}</option>
                        ))}
                    </select>
                </div>

                {/* View Mode & Filters */}
                <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-edge/5">
                    <div className="flex gap-2">
                        {[
                            { mode: 'standard', label: 'Standard', icon: '◧' },
                            { mode: 'greeks', label: 'Greeks', icon: 'Δ' },
                            { mode: 'iv', label: 'IV Analysis', icon: '◐' },
                        ].map(({ mode, label, icon }) => (
                            <button
                                key={mode}
                                onClick={() => setViewMode(mode)}
                                className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                                    viewMode === mode
                                        ? 'bg-primary-600/20 border border-primary-500/40 text-primary-600'
                                        : 'bg-surface-800/60 border border-edge/10 text-gray-500 hover:text-heading'
                                )}
                            >
                                {icon} {label}
                            </button>
                        ))}
                    </div>

                    <div className="flex gap-2 ml-auto">
                        {['all', 'itm', 'atm', 'otm'].map((filter) => (
                            <button
                                key={filter}
                                onClick={() => setFilterMoneyness(filter)}
                                className={cn(
                                    'px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all',
                                    filterMoneyness === filter
                                        ? 'bg-primary-600/20 border border-primary-500/40 text-primary-600'
                                        : 'bg-surface-800/60 border border-edge/10 text-gray-500 hover:text-heading'
                                )}
                            >
                                {filter.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Summary Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                    { label: 'Spot Price', value: `₹${formatPrice(spot)}`, trend: null },
                    { label: 'Call IV (Avg)', value: `${avgCallIV}%`, trend: null },
                    { label: 'Put IV (Avg)', value: `${avgPutIV}%`, trend: null },
                    { label: 'Total Rows', value: filteredRows.length, trend: null },
                ].map(({ label, value, trend }) => (
                    <div key={label} className="glass-card p-3 rounded-xl">
                        <p className="text-[11px] text-gray-500 uppercase font-semibold">{label}</p>
                        <p className="text-lg font-bold text-heading mt-1">{value}</p>
                    </div>
                ))}
            </div>

            {/* Options Chain Table */}
            <div className="glass-card overflow-hidden">
                <div className="px-4 py-3 border-b border-edge/5 bg-surface-900/50">
                    <p className="text-sm font-bold text-heading">{selectedSymbol} Options Chain • {selectedExpiry}</p>
                    <p className="text-xs text-gray-500 mt-0.5">View: {viewMode === 'standard' ? 'Price & Volume' : viewMode === 'greeks' ? 'Greeks & Risk Metrics' : 'Implied Volatility'}</p>
                </div>

                <div className="overflow-x-auto">
                    <div className="min-w-max">
                        {viewMode === 'standard' && (
                            <StandardView rows={filteredRows} spot={spot} onOrderPopup={openOrderPopup} />
                        )}
                        {viewMode === 'greeks' && (
                            <GreeksView rows={filteredRows} spot={spot} onOrderPopup={openOrderPopup} />
                        )}
                        {viewMode === 'iv' && (
                            <IVView rows={filteredRows} spot={spot} onOrderPopup={openOrderPopup} />
                        )}
                    </div>
                </div>
            </div>

            <FuturesOrderModal
                isOpen={orderPopup.open}
                onClose={() => setOrderPopup({ open: false, row: null, side: 'BUY' })}
                symbol={selectedSymbol}
                expiry={selectedExpiry}
                row={orderPopup.row}
                side={orderPopup.side}
            />
        </div>
    );
}

/** Standard View: Price, Volume, OI */
function StandardView({ rows, spot, onOrderPopup }) {
    return (
        <>
            <div className="grid grid-cols-[1fr_0.8fr_0.8fr_0.6fr_0.8fr_0.8fr_1fr] gap-px bg-edge/10">
                {/* Headers */}
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Call IV</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Call LTP</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Call Vol</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Strike</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Put Vol</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Put LTP</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Put IV</div>
            </div>

            {rows.map((row) => (
                <div
                    key={row.strike}
                    className={cn(
                        'grid grid-cols-[1fr_0.8fr_0.8fr_0.6fr_0.8fr_0.8fr_1fr] gap-px bg-edge/10 hover:bg-primary-500/5 transition-colors',
                        row.moneyness === 'ATM' && 'bg-amber-500/5'
                    )}
                >
                    {/* Call IV */}
                    <div className="bg-surface-900/60 px-3 py-2.5 text-xs text-gray-400 text-center">{row.callIV}%</div>

                    {/* Call LTP */}
                    <div className="bg-surface-900/60 px-3 py-2.5 text-center">
                        <p className="text-sm font-semibold text-heading">{formatPrice(row.callLtp)}</p>
                        <p className={cn('text-[10px] font-medium', row.callChange >= 0 ? 'text-profit' : 'text-loss')}>
                            {row.callChange >= 0 ? '+' : ''}{row.callChange.toFixed(2)}
                        </p>
                    </div>

                    {/* Call Volume */}
                    <div className="bg-surface-900/60 px-3 py-2.5 text-xs text-gray-400 text-center">{(row.callVolume / 1000).toFixed(1)}K</div>

                    {/* Strike */}
                    <div className={cn('px-3 py-2.5 text-center relative', getMoneynessBgColor(row.moneyness))}>
                        <span className="text-sm font-bold text-heading">{formatPrice(row.strike)}</span>
                        <span className={cn('absolute -top-1 -right-1 px-1.5 py-0.5 rounded text-[8px] font-bold', getMoneynessBadgeColor(row.moneyness))}>
                            {row.moneyness}
                        </span>
                    </div>

                    {/* Put Volume */}
                    <div className="bg-surface-900/60 px-3 py-2.5 text-xs text-gray-400 text-center">{(row.putVolume / 1000).toFixed(1)}K</div>

                    {/* Put LTP */}
                    <div className="bg-surface-900/60 px-3 py-2.5 text-center">
                        <p className="text-sm font-semibold text-heading">{formatPrice(row.putLtp)}</p>
                        <p className={cn('text-[10px] font-medium', row.putChange >= 0 ? 'text-profit' : 'text-loss')}>
                            {row.putChange >= 0 ? '+' : ''}{row.putChange.toFixed(2)}
                        </p>
                    </div>

                    {/* Put IV */}
                    <div className="bg-surface-900/60 px-3 py-2.5 text-xs text-gray-400 text-center">{row.putIV}%</div>
                </div>
            ))}
        </>
    );
}

/** Greeks View: Delta, Gamma, Vega, Theta */
function GreeksView({ rows, spot, onOrderPopup }) {
    return (
        <>
            <div className="grid grid-cols-[1fr_0.7fr_0.7fr_0.7fr_0.7fr_0.6fr_0.7fr_0.7fr_0.7fr_0.7fr_1fr] gap-px bg-edge/10">
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Δ</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Γ</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Θ</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">ν</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Vol</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Strike</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Vol</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">ν</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Θ</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Γ</div>
                <div className="bg-surface-900 px-2 py-2.5 text-[10px] font-bold text-gray-500 uppercase text-center">Δ</div>
            </div>

            {rows.map((row) => (
                <div key={row.strike} className="grid grid-cols-[1fr_0.7fr_0.7fr_0.7fr_0.7fr_0.6fr_0.7fr_0.7fr_0.7fr_0.7fr_1fr] gap-px bg-edge/10 hover:bg-primary-500/5">
                    <div className="bg-surface-900/60 px-2 py-2 text-xs font-mono text-center">{row.callDelta}</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs font-mono text-center">{row.callGamma}</div>
                    <div className={cn('px-2 py-2 text-xs font-mono text-center', row.callTheta < 0 ? 'text-loss' : 'text-profit')}>{row.callTheta}</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs font-mono text-center">{row.callVega}</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs text-center text-gray-500">{(row.callVolume / 1000).toFixed(0)}K</div>
                    <div className={cn('px-2 py-2 text-xs font-bold text-center', getMoneynessBgColor(row.moneyness))}>{formatPrice(row.strike)}</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs text-center text-gray-500">{(row.putVolume / 1000).toFixed(0)}K</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs font-mono text-center">{row.putVega}</div>
                    <div className={cn('px-2 py-2 text-xs font-mono text-center', row.putTheta < 0 ? 'text-loss' : 'text-profit')}>{row.putTheta}</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs font-mono text-center">{row.putGamma}</div>
                    <div className="bg-surface-900/60 px-2 py-2 text-xs font-mono text-center">{row.putDelta}</div>
                </div>
            ))}
        </>
    );
}

/** IV View: Implied Volatility Analysis */
function IVView({ rows, spot, onOrderPopup }) {
    const maxIV = Math.max(...rows.map((r) => Math.max(parseFloat(r.callIV), parseFloat(r.putIV))));

    return (
        <>
            <div className="grid grid-cols-[1fr_1fr_1fr_0.6fr_1fr_1fr_1fr] gap-px bg-edge/10">
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Call IV</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">IV Chart</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">IV Skew</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Strike</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">IV Skew</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">IV Chart</div>
                <div className="bg-surface-900 px-3 py-2.5 text-xs font-bold text-gray-500 uppercase text-center">Put IV</div>
            </div>

            {rows.map((row) => {
                const callIVRatio = parseFloat(row.callIV) / maxIV;
                const putIVRatio = parseFloat(row.putIV) / maxIV;
                const ivSkew = (parseFloat(row.putIV) - parseFloat(row.callIV)).toFixed(2);

                return (
                    <div key={row.strike} className="grid grid-cols-[1fr_1fr_1fr_0.6fr_1fr_1fr_1fr] gap-px bg-edge/10 hover:bg-primary-500/5">
                        {/* Call IV */}
                        <div className="bg-surface-900/60 px-3 py-2.5 text-sm font-mono text-heading text-center">{row.callIV}%</div>

                        {/* Call IV Chart */}
                        <div className="bg-surface-900/60 px-3 py-2.5 flex items-center justify-center">
                            <div className="w-full h-5 bg-surface-800 rounded-sm relative overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-sm"
                                    style={{ width: `${callIVRatio * 100}%` }}
                                />
                            </div>
                        </div>

                        {/* IV Skew Call */}
                        <div className={cn('px-3 py-2.5 text-xs font-mono text-center', ivSkew < 0 ? 'text-blue-400' : ivSkew > 0 ? 'text-red-400' : 'text-gray-400')}>
                            {ivSkew}
                        </div>

                        {/* Strike */}
                        <div className={cn('px-3 py-2.5 text-sm font-bold text-center', getMoneynessBgColor(row.moneyness))}>{formatPrice(row.strike)}</div>

                        {/* IV Skew Put */}
                        <div className={cn('px-3 py-2.5 text-xs font-mono text-center', ivSkew < 0 ? 'text-blue-400' : ivSkew > 0 ? 'text-red-400' : 'text-gray-400')}>
                            {ivSkew}
                        </div>

                        {/* Put IV Chart */}
                        <div className="bg-surface-900/60 px-3 py-2.5 flex items-center justify-center">
                            <div className="w-full h-5 bg-surface-800 rounded-sm relative overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-red-500 to-orange-500 rounded-sm"
                                    style={{ width: `${putIVRatio * 100}%` }}
                                />
                            </div>
                        </div>

                        {/* Put IV */}
                        <div className="bg-surface-900/60 px-3 py-2.5 text-sm font-mono text-heading text-center">{row.putIV}%</div>
                    </div>
                );
            })}
        </>
    );
}
