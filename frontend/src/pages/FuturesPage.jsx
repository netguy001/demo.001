// FuturesPage.jsx — Real NSE futures data + paper trading
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, Search, TrendingUp, TrendingDown } from 'lucide-react';
import api from '../services/api';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import { cn } from '../utils/cn';
import { formatCurrency, formatPrice, formatQuantity } from '../utils/formatters';

// ── Popular F&O symbols ──────────────────────────────────────────────────────
const DEFAULT_SYMBOLS = [
    'NIFTY', 'BANKNIFTY', 'FINNIFTY',
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'SBIN', 'LT', 'ITC', 'AXISBANK', 'HINDUNILVR',
    'TATAMOTORS', 'BAJFINANCE', 'WIPRO', 'ADANIENT', 'MARUTI',
];

const sanitize = (s = '') => String(s).replace(/\.(NS|BO)$/i, '').trim().toUpperCase();

function pct(val) {
    if (val == null) return '—';
    const v = Number(val);
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
}

function chg(val) {
    if (val == null) return '—';
    const v = Number(val);
    const sign = v >= 0 ? '+' : '';
    return `${sign}${formatPrice(v)}`;
}

// ── Order modal ───────────────────────────────────────────────────────────────
function OrderModal({ isOpen, onClose, contract, spotPrice, onPlaced }) {
    const [side, setSide] = useState('BUY');
    const [orderType, setOrderType] = useState('MARKET');
    const [lots, setLots] = useState(1);
    const [limitPrice, setLimitPrice] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (contract) {
            setSide('BUY');
            setOrderType('MARKET');
            setLots(1);
            setLimitPrice(String(contract.ltp ?? contract.close ?? ''));
        }
    }, [contract]);

    if (!contract) return null;

    const lotSize = contract.lot_size ?? 1;
    const qty = lots * lotSize;
    const effectivePrice = orderType === 'MARKET'
        ? (contract.ltp ?? contract.close ?? 0)
        : Number(limitPrice || 0);
    const orderValue = qty * effectivePrice;

    const handlePlace = async () => {
        setLoading(true);
        try {
            await api.post('/futures/orders/place', {
                contract_symbol: contract.contract_symbol,
                side,
                order_type: orderType,
                quantity: qty,
                price: orderType === 'LIMIT' ? Number(limitPrice) : null,
                client_price: effectivePrice,
            });
            toast.success(`${side} order placed — ${contract.contract_symbol}`);
            onPlaced?.();
            onClose();
        } catch (err) {
            toast.error(err?.response?.data?.detail ?? 'Order failed. Try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Place Futures Order" size="md">
            <div className="p-5 space-y-4">
                <div className="rounded-lg border border-edge/10 bg-surface-900/50 p-3 space-y-1">
                    <p className="text-xs text-gray-500">Contract</p>
                    <p className="text-sm font-bold text-heading">{contract.contract_symbol}</p>
                    <div className="flex gap-4 text-xs text-gray-500 mt-0.5">
                        <span>Expiry: {contract.expiry_label ?? ''} ({contract.expiry_date ?? ''})</span>
                        <span>Lot: {lotSize}</span>
                        {contract.ltp != null && <span>LTP: ₹{formatPrice(contract.ltp)}</span>}
                    </div>
                </div>

                {/* BUY / SELL toggle */}
                <div className="flex rounded-xl overflow-hidden border border-edge/10 bg-surface-800/60 p-0.5">
                    {['BUY', 'SELL'].map((v) => (
                        <button
                            key={v}
                            onClick={() => setSide(v)}
                            className={cn(
                                'flex-1 py-2 text-sm font-bold rounded-lg transition-all duration-200',
                                side === v
                                    ? v === 'BUY' ? 'bg-bull text-white' : 'bg-bear text-white'
                                    : 'text-gray-500 hover:text-heading',
                            )}
                        >{v}</button>
                    ))}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="metric-label block mb-1">Order Type</label>
                        <select
                            value={orderType}
                            onChange={(e) => setOrderType(e.target.value)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none"
                        >
                            <option value="MARKET">MARKET</option>
                            <option value="LIMIT">LIMIT</option>
                        </select>
                    </div>
                    <div>
                        <label className="metric-label block mb-1">Lots</label>
                        <input
                            type="number"
                            min={1}
                            value={lots}
                            onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none"
                        />
                    </div>
                </div>

                {orderType === 'LIMIT' && (
                    <div>
                        <label className="metric-label block mb-1">Limit Price (₹)</label>
                        <input
                            type="number"
                            step="0.05"
                            value={limitPrice}
                            onChange={(e) => setLimitPrice(e.target.value)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm text-heading focus:outline-none"
                        />
                    </div>
                )}

                <div className="rounded-lg border border-edge/10 bg-surface-900/50 p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                        <span className="text-gray-500">Quantity</span>
                        <span className="text-heading font-medium">{formatQuantity(qty)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-gray-500">Estimated Value</span>
                        <span className="text-heading font-medium">{formatCurrency(orderValue)}</span>
                    </div>
                    {spotPrice != null && effectivePrice > 0 && (
                        <div className="flex justify-between">
                            <span className="text-gray-500">Basis (Fut − Spot)</span>
                            <span className={cn('font-medium', (effectivePrice - spotPrice) >= 0 ? 'text-bull' : 'text-bear')}>
                                {chg(effectivePrice - spotPrice)}
                            </span>
                        </div>
                    )}
                </div>

                <button
                    type="button"
                    onClick={handlePlace}
                    disabled={loading}
                    className={cn(
                        'w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all disabled:opacity-60',
                        side === 'BUY' ? 'bg-bull hover:brightness-110' : 'bg-bear hover:brightness-110',
                    )}
                >
                    {loading ? 'Placing…' : `Place ${side} Order`}
                </button>
            </div>
        </Modal>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FuturesPage() {
    const [symbol, setSymbol] = useState('NIFTY');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState(DEFAULT_SYMBOLS.map((s) => ({ symbol: s })));
    const [showResults, setShowResults] = useState(false);
    const searchRef = useRef(null);

    // Data state
    const [contracts, setContracts] = useState([]);
    const [quotes, setQuotes] = useState({});   // contract_symbol → quote
    const [spot, setSpot] = useState(null);
    const [loading, setLoading] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);

    // Positions / orders
    const [positions, setPositions] = useState([]);
    const [orders, setOrders] = useState([]);
    const [bottomTab, setBottomTab] = useState('positions');

    // Order modal
    const [orderModal, setOrderModal] = useState({ open: false, contract: null });

    // ── Fetch contracts + spot ────────────────────────────────────────────────
    const fetchContracts = useCallback(async (sym) => {
        setLoading(true);
        try {
            const [contractsRes, spotRes] = await Promise.all([
                api.get(`/futures/contracts/${sym}`),
                api.get(`/futures/spot/${sym}`),
            ]);

            const contractList = contractsRes.data.contracts ?? [];
            setContracts(contractList);
            setSpot(spotRes.data.ltp ?? null);
            setLastUpdated(new Date());

            // Fetch quotes for each contract in parallel
            if (contractList.length > 0) {
                const quoteResults = await Promise.allSettled(
                    contractList.map((c) => api.get(`/futures/quote/${c.contract_symbol}`))
                );
                const newQuotes = {};
                quoteResults.forEach((r, i) => {
                    if (r.status === 'fulfilled') {
                        newQuotes[contractList[i].contract_symbol] = r.value.data;
                    }
                });
                setQuotes(newQuotes);
            }
        } catch (err) {
            toast.error('Failed to load futures contracts.');
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchPositionsOrders = useCallback(async () => {
        try {
            const [posRes, ordRes] = await Promise.all([
                api.get('/futures/positions'),
                api.get('/futures/orders'),
            ]);
            setPositions(posRes.data.positions ?? []);
            setOrders(ordRes.data.orders ?? []);
        } catch { /* silent */ }
    }, []);

    // Load on symbol change
    useEffect(() => {
        setContracts([]);
        setQuotes({});
        setSpot(null);
        fetchContracts(symbol);
        fetchPositionsOrders();
    }, [symbol, fetchContracts, fetchPositionsOrders]);

    // Auto-refresh every 30s
    useEffect(() => {
        const id = setInterval(() => {
            fetchContracts(symbol);
        }, 30_000);
        return () => clearInterval(id);
    }, [symbol, fetchContracts]);

    // Search handling
    useEffect(() => {
        const q = searchQuery.trim().toUpperCase();
        if (!q) {
            setSearchResults(DEFAULT_SYMBOLS.map((s) => ({ symbol: s })));
            return;
        }
        const local = DEFAULT_SYMBOLS
            .filter((s) => s.includes(q))
            .map((s) => ({ symbol: s }));

        const t = setTimeout(async () => {
            try {
                const res = await api.get(`/market/search?q=${encodeURIComponent(q)}`);
                const api_results = (res.data.results ?? []).map((r) => ({ symbol: sanitize(r.symbol), name: r.name }));
                const merged = [...api_results, ...local]
                    .filter((r) => r.symbol)
                    .filter((r, i, arr) => arr.findIndex((x) => x.symbol === r.symbol) === i)
                    .slice(0, 80);
                setSearchResults(merged);
            } catch {
                setSearchResults(local);
            }
        }, 200);
        return () => clearTimeout(t);
    }, [searchQuery]);

    // Click outside to close search
    useEffect(() => {
        const handler = (e) => {
            if (searchRef.current && !searchRef.current.contains(e.target)) setShowResults(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleCancelOrder = async (orderId) => {
        try {
            await api.delete(`/futures/orders/${orderId}`);
            toast.success('Order cancelled.');
            fetchPositionsOrders();
        } catch (err) {
            toast.error(err?.response?.data?.detail ?? 'Cancel failed.');
        }
    };

    const openOrder = (contract) => {
        const q = quotes[contract.contract_symbol] ?? {};
        setOrderModal({ open: true, contract: { ...contract, ...q } });
    };

    return (
        <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
            {/* ── Header ── */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-display font-bold text-heading">Futures</h1>
                    <p className="text-sm text-gray-500 mt-1">Live NSE futures contracts • Paper trading</p>
                </div>
                <div className="flex items-center gap-2">
                    {lastUpdated && (
                        <span className="text-xs text-gray-500">
                            Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                    )}
                    <button
                        onClick={() => fetchContracts(symbol)}
                        disabled={loading}
                        className="p-1.5 rounded-lg text-gray-500 hover:text-heading hover:bg-overlay/5 transition-colors disabled:opacity-50"
                        title="Refresh"
                    >
                        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                    </button>
                    <Badge variant="success" className="font-semibold">NSE LIVE</Badge>
                </div>
            </div>

            {/* ── Controls ── */}
            <div className="glass-card p-4 flex flex-wrap items-center gap-3">
                {/* Symbol search */}
                <div className="relative flex-1 min-w-[220px]" ref={searchRef}>
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onFocus={() => setShowResults(true)}
                        placeholder={`Search symbol… (e.g. ${symbol})`}
                        className="w-full bg-surface-800/60 border border-edge/5 rounded-lg pl-10 pr-3 py-2 text-sm text-heading placeholder-gray-500 focus:outline-none focus:border-primary-500/30"
                    />
                    {showResults && (
                        <div className="absolute top-full left-0 mt-1 w-full bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 max-h-72 overflow-y-auto">
                            {searchResults.length > 0 ? searchResults.map((r) => (
                                <button
                                    key={r.symbol}
                                    onClick={() => { setSymbol(r.symbol); setSearchQuery(''); setShowResults(false); }}
                                    className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800 border-b border-gray-100 dark:border-slate-700 last:border-0"
                                >
                                    <span className="font-semibold text-gray-900 dark:text-slate-100">{r.symbol}</span>
                                    {r.name && r.name !== r.symbol && (
                                        <span className="text-xs text-gray-500 ml-2">{r.name}</span>
                                    )}
                                </button>
                            )) : (
                                <div className="px-4 py-3 text-center text-xs text-gray-500">No results</div>
                            )}
                        </div>
                    )}
                </div>

                {/* Spot price chip */}
                {spot != null && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-800/60 border border-edge/10 text-sm">
                        <span className="text-gray-500">Spot</span>
                        <span className="font-bold text-heading">₹{formatPrice(spot)}</span>
                    </div>
                )}
            </div>

            {/* ── Contracts table ── */}
            <div className="glass-card overflow-hidden">
                <div className="px-4 py-3 border-b border-edge/5 bg-surface-900/50 flex items-center justify-between">
                    <div>
                        <p className="text-sm font-bold text-heading">{symbol} Futures Contracts</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                            {contracts.length > 0 ? `${contracts.length} contracts available` : 'Loading…'}
                        </p>
                    </div>
                </div>

                {loading && contracts.length === 0 ? (
                    <div className="flex items-center justify-center py-16 text-gray-500 text-sm">
                        <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Fetching contracts…
                    </div>
                ) : contracts.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-500 text-sm gap-2">
                        <p>No contracts found for <span className="font-semibold text-heading">{symbol}</span></p>
                        <p className="text-xs">Try a different symbol or check market hours.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-edge/5 bg-surface-900/40">
                                    {['Contract', 'Expiry', 'Label', 'Lot Size', 'LTP', 'Chg', 'Chg %', 'Volume', 'OI', 'Basis', 'Action'].map((h) => (
                                        <th key={h} className="px-4 py-2.5 text-xs font-bold text-gray-500 uppercase text-left whitespace-nowrap">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {contracts.map((c) => {
                                    const q = quotes[c.contract_symbol] ?? {};
                                    const ltp = q.ltp ?? null;
                                    const change = ltp != null && q.close != null ? ltp - q.close : null;
                                    const changePct = q.close ? (change / q.close) * 100 : null;
                                    const basis = ltp != null && spot != null ? ltp - spot : null;
                                    const isUp = change != null && change >= 0;

                                    return (
                                        <tr key={c.contract_symbol} className="border-b border-edge/5 hover:bg-overlay/[0.03] transition-colors">
                                            <td className="px-4 py-3 font-mono text-xs font-semibold text-heading whitespace-nowrap">{c.contract_symbol}</td>
                                            <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{c.expiry_date}</td>
                                            <td className="px-4 py-3">
                                                <span className={cn(
                                                    'text-[10px] font-bold px-2 py-0.5 rounded-full',
                                                    c.expiry_label === 'Near' ? 'bg-primary-500/15 text-primary-500' :
                                                    c.expiry_label === 'Mid'  ? 'bg-amber-500/15 text-amber-500' :
                                                    'bg-gray-500/15 text-gray-400'
                                                )}>{c.expiry_label}</span>
                                            </td>
                                            <td className="px-4 py-3 text-xs tabular-nums text-heading">{formatQuantity(c.lot_size)}</td>
                                            <td className="px-4 py-3 text-xs tabular-nums font-semibold text-heading">
                                                {ltp != null ? `₹${formatPrice(ltp)}` : <span className="text-gray-500">—</span>}
                                            </td>
                                            <td className={cn('px-4 py-3 text-xs tabular-nums', change == null ? 'text-gray-500' : isUp ? 'text-bull' : 'text-bear')}>
                                                {chg(change)}
                                            </td>
                                            <td className={cn('px-4 py-3 text-xs tabular-nums', changePct == null ? 'text-gray-500' : isUp ? 'text-bull' : 'text-bear')}>
                                                {pct(changePct)}
                                            </td>
                                            <td className="px-4 py-3 text-xs tabular-nums text-gray-400">
                                                {q.volume != null ? formatQuantity(q.volume) : '—'}
                                            </td>
                                            <td className="px-4 py-3 text-xs tabular-nums text-gray-400">
                                                {q.oi != null && q.oi > 0 ? formatQuantity(q.oi) : '—'}
                                            </td>
                                            <td className={cn('px-4 py-3 text-xs tabular-nums', basis == null ? 'text-gray-500' : basis >= 0 ? 'text-bull' : 'text-bear')}>
                                                {basis != null ? chg(basis) : '—'}
                                            </td>
                                            <td className="px-4 py-3">
                                                <button
                                                    onClick={() => openOrder(c)}
                                                    className="px-3 py-1 rounded-md bg-primary-500/10 text-primary-600 text-xs font-semibold hover:bg-primary-500/20 transition-colors whitespace-nowrap"
                                                >
                                                    Trade
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* ── Positions / Orders ── */}
            <div className="glass-card overflow-hidden">
                <div className="border-b border-edge/5 flex">
                    {[
                        { key: 'positions', label: `Positions (${positions.length})` },
                        { key: 'orders',    label: `Orders (${orders.length})` },
                    ].map(({ key, label }) => (
                        <button
                            key={key}
                            onClick={() => setBottomTab(key)}
                            className={cn(
                                'px-5 py-3 text-sm font-semibold transition-colors border-b-2',
                                bottomTab === key
                                    ? 'text-primary-600 border-primary-500'
                                    : 'text-gray-500 border-transparent hover:text-heading',
                            )}
                        >{label}</button>
                    ))}
                </div>

                {bottomTab === 'positions' && (
                    positions.length === 0 ? (
                        <div className="flex items-center justify-center py-12 text-gray-500 text-sm">No open positions</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-edge/5 bg-surface-900/40">
                                        {['Contract', 'Side', 'Qty', 'Avg Price', 'LTP', 'P&L', 'Value'].map((h) => (
                                            <th key={h} className="px-4 py-2.5 text-xs font-bold text-gray-500 uppercase text-left">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {positions.map((p) => {
                                        const q = quotes[p.contract_symbol] ?? {};
                                        const ltp = q.ltp ?? p.average_price ?? 0;
                                        const pnl = (ltp - p.average_price) * p.quantity * (p.side === 'SELL' ? -1 : 1);
                                        return (
                                            <tr key={p.id} className="border-b border-edge/5 hover:bg-overlay/[0.03]">
                                                <td className="px-4 py-3 font-mono text-xs font-semibold text-heading">{p.contract_symbol}</td>
                                                <td className={cn('px-4 py-3 text-xs font-bold', p.side === 'BUY' ? 'text-bull' : 'text-bear')}>{p.side}</td>
                                                <td className="px-4 py-3 text-xs tabular-nums text-heading">{formatQuantity(p.quantity)}</td>
                                                <td className="px-4 py-3 text-xs tabular-nums text-heading">₹{formatPrice(p.average_price)}</td>
                                                <td className="px-4 py-3 text-xs tabular-nums text-heading">{ltp ? `₹${formatPrice(ltp)}` : '—'}</td>
                                                <td className={cn('px-4 py-3 text-xs tabular-nums font-semibold', pnl >= 0 ? 'text-bull' : 'text-bear')}>
                                                    {chg(pnl)}
                                                </td>
                                                <td className="px-4 py-3 text-xs tabular-nums text-gray-400">{formatCurrency(ltp * p.quantity)}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )
                )}

                {bottomTab === 'orders' && (
                    orders.length === 0 ? (
                        <div className="flex items-center justify-center py-12 text-gray-500 text-sm">No orders yet</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-edge/5 bg-surface-900/40">
                                        {['Contract', 'Side', 'Type', 'Qty', 'Price', 'Status', 'Time', ''].map((h) => (
                                            <th key={h} className="px-4 py-2.5 text-xs font-bold text-gray-500 uppercase text-left">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((o) => (
                                        <tr key={o.id} className="border-b border-edge/5 hover:bg-overlay/[0.03]">
                                            <td className="px-4 py-3 font-mono text-xs font-semibold text-heading">{o.contract_symbol}</td>
                                            <td className={cn('px-4 py-3 text-xs font-bold', o.side === 'BUY' ? 'text-bull' : 'text-bear')}>{o.side}</td>
                                            <td className="px-4 py-3 text-xs text-gray-400">{o.order_type}</td>
                                            <td className="px-4 py-3 text-xs tabular-nums text-heading">{formatQuantity(o.quantity)}</td>
                                            <td className="px-4 py-3 text-xs tabular-nums text-heading">
                                                {o.filled_price != null ? `₹${formatPrice(o.filled_price)}` : o.price != null ? `₹${formatPrice(o.price)}` : 'MKT'}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={cn(
                                                    'text-[10px] font-bold px-2 py-0.5 rounded-full',
                                                    o.status === 'FILLED'    ? 'bg-bull/15 text-bull' :
                                                    o.status === 'OPEN'      ? 'bg-primary-500/15 text-primary-500' :
                                                    o.status === 'CANCELLED' ? 'bg-gray-500/15 text-gray-400' :
                                                    'bg-amber-500/15 text-amber-500'
                                                )}>{o.status}</span>
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                                                {o.created_at ? new Date(o.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}
                                            </td>
                                            <td className="px-4 py-3">
                                                {o.status === 'OPEN' && (
                                                    <button
                                                        onClick={() => handleCancelOrder(o.id)}
                                                        className="px-2 py-0.5 rounded text-[10px] font-semibold bg-bear/10 text-bear hover:bg-bear/20 transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )
                )}
            </div>

            {/* ── Order modal ── */}
            <OrderModal
                isOpen={orderModal.open}
                onClose={() => setOrderModal({ open: false, contract: null })}
                contract={orderModal.contract}
                spotPrice={spot}
                onPlaced={fetchPositionsOrders}
            />
        </div>
    );
}
