import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';
import { cn } from '../utils/cn';
import { pnlColorClass, cleanSymbol } from '../utils/formatters';
import {
    Zap, Play, Pause, Plus,
    Clock, X, Pencil, Trash2,
} from 'lucide-react';

// ── Strategy type definitions ─────────────────────────────────────────────────
const STRATEGY_TYPES = [
    { value: 'SMA_CROSSOVER', label: 'SMA Crossover', desc: 'Golden/death cross + RSI zone + MACD momentum + volume confirmation' },
    { value: 'RSI', label: 'RSI Strategy', desc: 'Oversold/overbought bounce + EMA trend filter + MACD turning + volume surge' },
    { value: 'MACD', label: 'MACD Signal', desc: 'Signal crossover + histogram momentum + RSI zone + zero-line strength' },
    { value: 'BOLLINGER', label: 'Bollinger Bands', desc: 'Band touch + RSI divergence + trend filter (no falling knives) + volume spike' },
    { value: 'EMA_CROSSOVER', label: 'EMA Crossover', desc: 'Fast/slow EMA cross + MACD alignment + RSI confirmation + volume surge' },
    { value: 'VWAP_BOUNCE', label: 'VWAP Bounce', desc: 'VWAP support/resistance bounce + RSI + MACD + volume — best for intraday' },
];

// ── Per-strategy configurable parameters ──────────────────────────────────────
const STRATEGY_PARAMS = {
    SMA_CROSSOVER: [
        { key: 'short_period', label: 'Short SMA', type: 'number', default: 10, min: 2, max: 100, hint: 'Fast moving average period' },
        { key: 'long_period', label: 'Long SMA', type: 'number', default: 20, min: 5, max: 200, hint: 'Slow moving average period' },
    ],
    RSI: [
        { key: 'period', label: 'RSI Period', type: 'number', default: 14, min: 2, max: 50, hint: 'Lookback period for RSI' },
        { key: 'oversold', label: 'Oversold', type: 'number', default: 30, min: 10, max: 45, hint: 'Buy below this RSI level' },
        { key: 'overbought', label: 'Overbought', type: 'number', default: 70, min: 55, max: 90, hint: 'Sell above this RSI level' },
    ],
    MACD: [
        { key: 'fast_period', label: 'Fast EMA', type: 'number', default: 12, min: 2, max: 50, hint: 'Fast EMA period' },
        { key: 'slow_period', label: 'Slow EMA', type: 'number', default: 26, min: 10, max: 100, hint: 'Slow EMA period' },
        { key: 'signal_period', label: 'Signal', type: 'number', default: 9, min: 2, max: 30, hint: 'Signal line smoothing' },
    ],
    BOLLINGER: [
        { key: 'period', label: 'BB Period', type: 'number', default: 20, min: 5, max: 50, hint: 'Moving average period' },
        { key: 'std_dev', label: 'Std Dev', type: 'number', step: 0.1, default: 2.0, min: 0.5, max: 4.0, hint: 'Band width multiplier' },
    ],
    EMA_CROSSOVER: [
        { key: 'fast_period', label: 'Fast EMA', type: 'number', default: 9, min: 2, max: 50, hint: 'Fast EMA period (default 9)' },
        { key: 'slow_period', label: 'Slow EMA', type: 'number', default: 21, min: 5, max: 100, hint: 'Slow EMA period (default 21)' },
    ],
    VWAP_BOUNCE: [
        { key: 'bounce_threshold', label: 'Bounce %', type: 'number', step: 0.1, default: 0.2, min: 0.1, max: 1.0, hint: 'Max distance from VWAP to trigger (%)' },
    ],
};

function getDefaultParams(type) {
    const fields = STRATEGY_PARAMS[type] || [];
    const p = { quantity: 1 };
    fields.forEach(f => { p[f.key] = f.default; });
    return p;
}

// ── Inline param fields component ─────────────────────────────────────────────
function ParamFields({ type, params, onChange }) {
    const fields = STRATEGY_PARAMS[type] || [];
    return (
        <>
            <div>
                <label className="label-text">Trade Qty</label>
                <input type="number" min="1" max="1000"
                    value={params.quantity ?? 1}
                    onChange={e => onChange({ ...params, quantity: parseInt(e.target.value) || 1 })}
                    className="input-field" />
                <p className="text-[10px] text-gray-600 mt-0.5">Shares per signal</p>
            </div>
            {fields.map(f => (
                <div key={f.key}>
                    <label className="label-text">{f.label}</label>
                    <input
                        type="number"
                        step={f.step || 1}
                        min={f.min}
                        max={f.max}
                        value={params[f.key] ?? f.default}
                        onChange={e => onChange({ ...params, [f.key]: f.step ? parseFloat(e.target.value) : parseInt(e.target.value) })}
                        className="input-field"
                    />
                    {f.hint && <p className="text-[10px] text-gray-600 mt-0.5">{f.hint}</p>}
                </div>
            ))}
        </>
    );
}

// ── Edit modal ────────────────────────────────────────────────────────────────
function EditModal({ strategy, onClose, onSave }) {
    const [form, setForm] = useState({
        name: strategy.name,
        description: strategy.description || '',
        max_position_size: strategy.max_position_size,
        stop_loss_percent: strategy.stop_loss_percent,
        take_profit_percent: strategy.take_profit_percent,
        parameters: { ...getDefaultParams(strategy.strategy_type), ...(strategy.parameters || {}) },
    });
    const [saving, setSaving] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setSaving(true);
        await onSave(strategy.id, form);
        setSaving(false);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-lg bg-surface-800 border border-edge/10 rounded-2xl shadow-2xl animate-slide-up">
                <div className="flex items-center justify-between px-5 py-3 border-b border-edge/5">
                    <h3 className="text-sm font-semibold text-heading">Edit Strategy</h3>
                    <button onClick={onClose} className="p-1 rounded hover:bg-surface-700 text-gray-500 hover:text-heading transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                            <label className="label-text">Name</label>
                            <input type="text" value={form.name} required
                                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input-field" />
                        </div>
                        <div>
                            <label className="label-text">Max Position Size</label>
                            <input type="number" value={form.max_position_size}
                                onChange={e => setForm(f => ({ ...f, max_position_size: parseInt(e.target.value) }))} className="input-field" />
                        </div>
                        <div>
                            <label className="label-text">Stop Loss %</label>
                            <input type="number" step="0.1" value={form.stop_loss_percent}
                                onChange={e => setForm(f => ({ ...f, stop_loss_percent: parseFloat(e.target.value) }))} className="input-field" />
                        </div>
                        <div>
                            <label className="label-text">Take Profit %</label>
                            <input type="number" step="0.1" value={form.take_profit_percent}
                                onChange={e => setForm(f => ({ ...f, take_profit_percent: parseFloat(e.target.value) }))} className="input-field" />
                        </div>
                    </div>

                    {/* Strategy-specific parameters */}
                    <div>
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                            {STRATEGY_TYPES.find(t => t.value === strategy.strategy_type)?.label} Parameters
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <ParamFields
                                type={strategy.strategy_type}
                                params={form.parameters}
                                onChange={p => setForm(f => ({ ...f, parameters: p }))}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="label-text">Description</label>
                        <textarea value={form.description} rows="2"
                            onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-field resize-none" />
                    </div>

                    <div className="flex gap-3 pt-1">
                        <button type="submit" disabled={saving} className="btn-primary text-sm inline-flex items-center gap-2">
                            {saving ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AlgoTradingPage() {
    const [strategies, setStrategies] = useState([]);
    const [logs, setLogs] = useState([]);
    const [showCreate, setShowCreate] = useState(false);
    const [selectedStrategy, setSelectedStrategy] = useState(null);
    const [editStrategy, setEditStrategy] = useState(null);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState({
        name: '', strategy_type: 'SMA_CROSSOVER', symbol: 'RELIANCE',
        description: '', max_position_size: 100, stop_loss_percent: 2, take_profit_percent: 5,
        parameters: getDefaultParams('SMA_CROSSOVER'),
    });

    useEffect(() => { loadStrategies(); }, []);

    const loadStrategies = async () => {
        try {
            const res = await api.get('/algo/strategies');
            setStrategies(res.data.strategies || []);
        } catch { /* ignore */ }
        setLoading(false);
    };

    const handleTypeChange = useCallback((type) => {
        setForm(f => ({ ...f, strategy_type: type, parameters: getDefaultParams(type) }));
    }, []);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await api.post('/algo/strategies', {
                name: form.name,
                strategy_type: form.strategy_type,
                symbol: form.symbol,
                description: form.description,
                max_position_size: form.max_position_size,
                stop_loss_percent: form.stop_loss_percent,
                take_profit_percent: form.take_profit_percent,
                parameters: form.parameters,
            });
            toast.success('Strategy created!');
            setShowCreate(false);
            setForm({
                name: '', strategy_type: 'SMA_CROSSOVER', symbol: 'RELIANCE',
                description: '', max_position_size: 100, stop_loss_percent: 2, take_profit_percent: 5,
                parameters: getDefaultParams('SMA_CROSSOVER'),
            });
            loadStrategies();
        } catch (err) {
            toast.error(err.response?.data?.detail || 'Failed to create strategy');
        }
    };

    const handleToggle = async (id) => {
        try {
            const res = await api.put(`/algo/strategies/${id}/toggle`);
            toast.success(res.data.message);
            loadStrategies();
        } catch (err) {
            toast.error(err.response?.data?.detail || 'Failed to toggle');
        }
    };

    const handleDelete = async (id) => {
        try {
            await api.delete(`/algo/strategies/${id}`);
            toast.success('Strategy deleted');
            loadStrategies();
        } catch (err) {
            toast.error(err.response?.data?.detail || 'Failed to delete');
        }
    };

    const handleUpdate = async (id, data) => {
        try {
            await api.put(`/algo/strategies/${id}`, data);
            toast.success('Strategy updated');
            setEditStrategy(null);
            loadStrategies();
        } catch (err) {
            toast.error(err.response?.data?.detail || 'Failed to update');
        }
    };

    const loadLogs = async (id) => {
        setSelectedStrategy(id);
        try {
            const res = await api.get(`/algo/strategies/${id}/logs`);
            setLogs(res.data.logs || []);
        } catch { /* ignore */ }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-[60vh]">
                <div className="w-10 h-10 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    const typeMeta = STRATEGY_TYPES.find(t => t.value === form.strategy_type) || {};

    return (
        <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-display font-semibold text-heading">Algo Trading</h1>
                    <p className="text-gray-500 text-sm mt-0.5">Create and manage automated trading strategies</p>
                </div>
                <button onClick={() => setShowCreate(!showCreate)} className="btn-primary text-sm inline-flex items-center gap-2">
                    {showCreate ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    {showCreate ? 'Cancel' : 'New Strategy'}
                </button>
            </div>

            {/* ── Create Form ──────────────────────────────────────────── */}
            {showCreate && (
                <div className="rounded-xl border border-primary-500/15 bg-surface-900/60 p-6 animate-slide-up">
                    <h3 className="section-title text-sm mb-4">Create New Strategy</h3>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="label-text">Strategy Name</label>
                                <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g., NIFTY SMA Scalper" required className="input-field" />
                            </div>
                            <div>
                                <label className="label-text">Symbol</label>
                                <input type="text" value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))} placeholder="e.g., RELIANCE" required className="input-field" />
                            </div>
                            <div>
                                <label className="label-text">Strategy Type</label>
                                <select value={form.strategy_type} onChange={e => handleTypeChange(e.target.value)} className="input-field cursor-pointer">
                                    {STRATEGY_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="label-text">Max Position Size</label>
                                <input type="number" value={form.max_position_size} onChange={e => setForm(f => ({ ...f, max_position_size: parseInt(e.target.value) }))} className="input-field" />
                            </div>
                            <div>
                                <label className="label-text">Stop Loss %</label>
                                <input type="number" step="0.1" value={form.stop_loss_percent} onChange={e => setForm(f => ({ ...f, stop_loss_percent: parseFloat(e.target.value) }))} className="input-field" />
                            </div>
                            <div>
                                <label className="label-text">Take Profit %</label>
                                <input type="number" step="0.1" value={form.take_profit_percent} onChange={e => setForm(f => ({ ...f, take_profit_percent: parseFloat(e.target.value) }))} className="input-field" />
                            </div>
                        </div>

                        {/* Strategy-specific parameters */}
                        <div className="bg-surface-900/40 rounded-xl p-4 border border-edge/5">
                            <div className="flex items-center justify-between mb-3">
                                <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wider">
                                    {typeMeta.label} Parameters
                                </p>
                            </div>
                            {typeMeta.desc && (
                                <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">{typeMeta.desc}</p>
                            )}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <ParamFields
                                    type={form.strategy_type}
                                    params={form.parameters}
                                    onChange={p => setForm(f => ({ ...f, parameters: p }))}
                                />
                            </div>
                        </div>

                        <div>
                            <label className="label-text">Description</label>
                            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows="2" placeholder="Describe your strategy logic..." className="input-field resize-none" />
                        </div>
                        <div className="flex gap-3">
                            <button type="submit" className="btn-primary text-sm inline-flex items-center gap-2">
                                <Zap className="w-4 h-4" /> Create Strategy
                            </button>
                            <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary text-sm">Cancel</button>
                        </div>
                    </form>
                </div>
            )}

            {/* ── Strategy Cards ───────────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {strategies.map(s => {
                    const tMeta = STRATEGY_TYPES.find(t => t.value === s.strategy_type) || { label: s.strategy_type };
                    const params = s.parameters || {};
                    const paramFields = STRATEGY_PARAMS[s.strategy_type] || [];

                    return (
                        <div key={s.id} className="rounded-xl border border-edge/5 bg-surface-900/60 hover:border-edge/15 transition-all p-5 flex flex-col">
                            <div className="flex items-start justify-between mb-2">
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-semibold text-heading text-sm truncate">{s.name}</h3>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-xs font-price text-gray-500 bg-surface-700/50 px-1.5 py-0.5 rounded">{cleanSymbol(s.symbol)}</span>
                                        <span className="text-xs text-gray-500">{tMeta.label}</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                    <button onClick={() => setEditStrategy(s)} title="Edit"
                                        className="p-1.5 rounded-lg text-gray-600 hover:text-primary-600 hover:bg-primary-500/10 transition-all">
                                        <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={() => handleToggle(s.id)} title={s.is_active ? 'Pause' : 'Start'}
                                        className={cn('p-1.5 rounded-lg transition-all',
                                            s.is_active ? 'bg-profit/15 text-profit hover:bg-profit/25' : 'bg-surface-700/50 text-gray-500 hover:text-heading'
                                        )}>
                                        {s.is_active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                                    </button>
                                    {!s.is_active && (
                                        <button onClick={() => handleDelete(s.id)} title="Delete"
                                            className="p-1.5 rounded-lg text-gray-600 hover:text-red-500 hover:bg-red-500/10 transition-all">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {s.description && <p className="text-xs text-gray-500 mb-2 line-clamp-2">{s.description}</p>}

                            {/* Show key parameters */}
                            {paramFields.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-3">
                                    {paramFields.map(f => (
                                        <span key={f.key} className="text-[10px] font-price bg-surface-900/60 text-gray-400 px-1.5 py-0.5 rounded border border-edge/5 tabular-nums">
                                            {f.label}: {params[f.key] ?? f.default}
                                        </span>
                                    ))}
                                    <span className="text-[10px] font-price bg-surface-900/60 text-gray-400 px-1.5 py-0.5 rounded border border-edge/5 tabular-nums">
                                        Qty: {params.quantity ?? 1}
                                    </span>
                                </div>
                            )}

                            {/* Status indicator */}
                            <div className="flex items-center gap-1.5 mb-3">
                                <span className={cn('w-1.5 h-1.5 rounded-full', s.is_active ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600')} />
                                <span className={cn('text-[10px] font-semibold uppercase tracking-wider', s.is_active ? 'text-emerald-600' : 'text-gray-600')}>
                                    {s.is_active ? 'Running' : 'Paused'}
                                </span>
                                <span className="text-[10px] text-gray-600 ml-auto">SL: {s.stop_loss_percent}% · TP: {s.take_profit_percent}%</span>
                            </div>

                            <div className="grid grid-cols-3 gap-2 mt-auto">
                                <div className="text-center p-2 bg-surface-900/50 rounded-lg">
                                    <div className="metric-label text-[10px]">Trades</div>
                                    <div className="font-price font-semibold text-heading text-sm tabular-nums">{s.total_trades}</div>
                                </div>
                                <div className="text-center p-2 bg-surface-900/50 rounded-lg">
                                    <div className="metric-label text-[10px]">P&amp;L</div>
                                    <div className={cn('font-price font-semibold text-sm tabular-nums', pnlColorClass(s.total_pnl))}>
                                        {s.total_pnl >= 0 ? '+' : ''}₹{Number(s.total_pnl).toFixed(0)}
                                    </div>
                                </div>
                                <div className="text-center p-2 bg-surface-900/50 rounded-lg">
                                    <div className="metric-label text-[10px]">Win</div>
                                    <div className="font-price font-semibold text-heading text-sm tabular-nums">{s.win_rate}%</div>
                                </div>
                            </div>

                            <button onClick={() => loadLogs(s.id)}
                                className="mt-3 text-xs text-primary-600 hover:text-primary-500 text-left flex items-center gap-1 transition-colors">
                                <Clock className="w-3 h-3" /> View Logs
                            </button>
                        </div>
                    );
                })}

                {strategies.length === 0 && !showCreate && (
                    <div className="md:col-span-2 lg:col-span-3 space-y-6">
                        {/* Empty state hero */}
                        <div className="rounded-xl border border-edge/5 bg-surface-900/60 p-12 text-center">
                            <Zap className="w-12 h-12 mx-auto mb-3 text-gray-600 opacity-50" />
                            <p className="text-lg font-display font-semibold text-gray-400">No strategies yet</p>
                            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
                                Create your first algo trading strategy. Define entry/exit conditions
                                using technical indicators. Strategies run automatically during market hours.
                            </p>
                        </div>

                        {/* Strategy template gallery */}
                        <div>
                            <h3 className="section-title text-xs mb-3">Strategy Templates</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {STRATEGY_TYPES.map(st => (
                                    <button
                                        key={st.value}
                                        onClick={() => { handleTypeChange(st.value); setForm(f => ({ ...f, strategy_type: st.value, parameters: getDefaultParams(st.value) })); setShowCreate(true); }}
                                        className="rounded-xl border border-edge/5 bg-surface-900/40 hover:border-primary-500/25 hover:bg-surface-900/80 transition-all p-4 text-left group"
                                    >
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <span className="w-7 h-7 rounded-lg bg-primary-500/10 flex items-center justify-center text-primary-600">
                                                <Zap className="w-3.5 h-3.5" />
                                            </span>
                                            <span className="text-sm font-semibold text-heading group-hover:text-primary-600 transition-colors">{st.label}</span>
                                        </div>
                                        <p className="text-xs text-gray-500 leading-relaxed">{st.desc}</p>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Strategy Logs ─────────────────────────────────────────── */}
            {selectedStrategy && (
                <div className="rounded-xl border border-edge/5 bg-surface-900/60 p-5 animate-slide-up">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="section-title text-xs">Strategy Logs</h3>
                        <button onClick={() => { setSelectedStrategy(null); setLogs([]); }}
                            className="text-gray-500 hover:text-heading text-sm transition-colors inline-flex items-center gap-1">
                            <X className="w-3.5 h-3.5" /> Close
                        </button>
                    </div>
                    {logs.length > 0 ? (
                        <div className="space-y-1 max-h-[300px] overflow-y-auto">
                            {logs.map(l => (
                                <div key={l.id} className="flex items-start gap-3 py-2 text-sm border-b border-edge/[0.03]">
                                    <span className={cn('text-xs font-price px-1.5 py-0.5 rounded flex-shrink-0 tabular-nums',
                                        l.level === 'ERROR' ? 'bg-bear/10 text-bear' :
                                            l.level === 'TRADE' ? 'bg-primary-500/10 text-primary-600' :
                                                l.level === 'WARNING' ? 'bg-primary-500/10 text-primary-600' :
                                                    'bg-surface-700 text-gray-400'
                                    )}>{l.level}</span>
                                    <span className="text-gray-600 flex-1">{l.message}</span>
                                    <span className="text-gray-600 text-xs ml-auto flex-shrink-0 font-mono">
                                        {l.created_at ? new Date(l.created_at).toLocaleString() : ''}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-8 text-gray-600">
                            <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
                            <p className="text-sm">No logs available</p>
                        </div>
                    )}
                </div>
            )}

            {/* ── Edit Modal ───────────────────────────────────────────── */}
            {editStrategy && (
                <EditModal
                    strategy={editStrategy}
                    onClose={() => setEditStrategy(null)}
                    onSave={handleUpdate}
                />
            )}
        </div>
    );
}
