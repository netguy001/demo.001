import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import WatchlistItem from './WatchlistItem';
import Skeleton from '../ui/Skeleton';
import { cn } from '../../utils/cn';
import {
    Search, Plus, X,
    Pencil, Check, Trash2, MoreVertical, Star, ChevronRight, TrendingUp,
} from 'lucide-react';
import { useWatchlistStore } from '../../stores/useWatchlistStore';
import { useMarketIndicesStore } from '../../stores/useMarketIndicesStore';
import api from '../../services/api';
import { cleanSymbol } from '../../utils/formatters';
import { getConstituents } from '../../utils/indexConstituents';

// ── Known indices shown in the dedicated Indices section ──────────────────────
const WATCHLIST_INDICES = [
    { label: 'NIFTY 50', nameMatch: 'NIFTY 50', key: 'NIFTY50' },
    { label: 'BANK NIFTY', nameMatch: 'NIFTY BANK', key: 'NSEBANK' },
    { label: 'SENSEX', nameMatch: 'SENSEX', key: 'BSESN' },
    { label: 'NIFTY IT', nameMatch: 'NIFTY IT', key: 'NIFTYIT' },
    { label: 'NIFTY AUTO', nameMatch: 'NIFTY AUTO', key: 'NIFTYAUTO' },
    { label: 'NIFTY PHARMA', nameMatch: 'NIFTY PHARMA', key: 'NIFTYPHARMA' },
    { label: 'NIFTY FMCG', nameMatch: 'NIFTY FMCG', key: 'NIFTYFMCG' },
    { label: 'MIDCAP 100', nameMatch: 'MIDCAP 100', key: 'NIFTYMIDCAP100' },
    { label: 'NEXT 50', nameMatch: 'NIFTY NEXT', key: 'NIFTYNXT50' },
];

/**
 * If a search result matches a known index (symbol starts with ^ or name matches),
 * return the matching WATCHLIST_INDICES entry; otherwise null.
 */
function findIndexEntry(symbol, name) {
    if (!symbol && !name) return null;
    const sym = (symbol || '').toUpperCase();
    const nm = (name || '').toUpperCase();

    // Symbol starts with ^ → definitely an index
    if (sym.startsWith('^')) {
        // Try to match by nameMatch
        const byName = WATCHLIST_INDICES.find(e => nm.includes(e.nameMatch.toUpperCase()));
        if (byName) return byName;
        // Fallback: return a synthetic entry so we still open a watchlist if possible
        return null;
    }

    // Try matching by name
    return WATCHLIST_INDICES.find(e => nm.includes(e.nameMatch.toUpperCase())) ?? null;
}

/**
 * Collapsible Indices section shown at the top of the watchlist.
 * Each index row expands to show its constituent stocks with live prices.
 */
function IndicesSection({ onSelectSymbol, onOpenIndexWatchlist }) {
    const navigate = useNavigate();
    const indices = useMarketIndicesStore((s) => s.indices);
    const tickerItems = useMarketIndicesStore((s) => s.tickerItems);

    const [sectionOpen, setSectionOpen] = useState(true);
    const [expandedKey, setExpandedKey] = useState(null);
    const [constituentPrices, setConstituentPrices] = useState({}); // { key → { SYMBOL: quote } }
    const [loadingKey, setLoadingKey] = useState(null);

    // Look up index-level price from ticker/indices store by name
    const getIndexData = (entry) => {
        const nm = entry.nameMatch.toUpperCase();
        const fromTicker = tickerItems.find(t =>
            t.kind === 'index' && t.name?.toUpperCase().includes(nm)
        );
        if (fromTicker) return fromTicker;
        return indices.find(i => i.name?.toUpperCase().includes(nm)) ?? null;
    };

    const handleToggle = async (entry) => {
        if (expandedKey === entry.key) { setExpandedKey(null); return; }
        setExpandedKey(entry.key);
        if (constituentPrices[entry.key]) return; // already loaded

        const stocks = getConstituents(entry.key);
        if (!stocks || stocks.length === 0) return;

        setLoadingKey(entry.key);
        try {
            const symbols = stocks.map(s => `${s}.NS`).join(',');
            const res = await api.get(`/market/batch?symbols=${encodeURIComponent(symbols)}`);
            const quotes = res.data?.quotes ?? {};
            const normalized = {};
            Object.entries(quotes).forEach(([k, v]) => {
                const upper = k.toUpperCase();
                normalized[upper] = v;
                normalized[upper.replace(/\.(NS|BO)$/i, '')] = v;
            });
            setConstituentPrices(prev => ({ ...prev, [entry.key]: normalized }));
        } catch { /* ignore — show dashes */ }
        setLoadingKey(null);
    };

    const openDedicatedWatchlist = (entry) => {
        const stocks = getConstituents(entry.key) || [];
        if (stocks.length === 0) return;
        onOpenIndexWatchlist?.(entry.key, entry.label, stocks);
    };

    return (
        <div className="border-b border-edge/5 flex-shrink-0">
            {/* Section header */}
            <button
                onClick={() => setSectionOpen(v => !v)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 hover:text-gray-400 hover:bg-surface-800/30 transition-colors"
            >
                <span>Indices</span>
                <ChevronRight className={cn('w-3 h-3 transition-transform duration-150', sectionOpen && 'rotate-90')} />
            </button>

            {sectionOpen && (
                <div>
                    {WATCHLIST_INDICES.map(entry => {
                        const data = getIndexData(entry);
                        const isExpanded = expandedKey === entry.key;
                        const isLoading = loadingKey === entry.key;
                        const stocks = getConstituents(entry.key) ?? [];
                        const prices = constituentPrices[entry.key] ?? {};
                        const chgPct = data?.change_percent ?? null;
                        const chgPos = (chgPct ?? 0) >= 0;

                        return (
                            <div key={entry.key}>
                                {/* Index row */}
                                <div
                                    onClick={() => handleToggle(entry)}
                                    className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-surface-800/40 transition-colors border-b border-edge/[0.03]"
                                >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                        <ChevronRight className={cn('w-2.5 h-2.5 flex-shrink-0 text-gray-500 transition-transform duration-150', isExpanded && 'rotate-90')} />
                                        <span className="text-[12px] font-semibold text-heading truncate">{entry.label}</span>
                                    </div>
                                    <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openDedicatedWatchlist(entry);
                                            }}
                                            className="px-2 py-0.5 text-[9px] font-semibold rounded-md border border-primary-500/30 text-primary-600 hover:bg-primary-500/10 transition-colors"
                                            title={`Open ${entry.label} as separate watchlist`}
                                        >
                                            Open WL
                                        </button>
                                        <div className="flex flex-col items-end">
                                            <span className="text-[12px] font-price tabular-nums text-heading">
                                                {data?.price != null
                                                    ? Number(data.price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                                    : '—'}
                                            </span>
                                            <span className={cn('text-[10px] font-price tabular-nums', chgPos ? 'text-bull' : 'text-bear')}>
                                                {chgPct != null
                                                    ? `${chgPos ? '+' : ''}${Number(chgPct).toFixed(2)}%`
                                                    : '—'}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {/* Constituent stocks sub-list */}
                                {isExpanded && (
                                    <div className="bg-slate-50 dark:bg-slate-900/70 border-l-2 border-l-primary-400/30">
                                        {isLoading ? (
                                            <div className="py-3 text-center text-[11px] text-gray-500">Loading...</div>
                                        ) : (
                                            <div className="max-h-56 overflow-y-auto divide-y divide-slate-200/30 dark:divide-slate-700/20">
                                                {stocks.map(base => {
                                                    const sym = `${base}.NS`;
                                                    const p = prices[sym] ?? prices[base] ?? {};
                                                    const pChg = p.change_percent ?? null;
                                                    const pPos = (pChg ?? 0) >= 0;
                                                    return (
                                                        <div
                                                            key={base}
                                                            onClick={() => {
                                                                onSelectSymbol?.(sym);
                                                                navigate(`/terminal?symbol=${encodeURIComponent(sym)}`);
                                                            }}
                                                            className="flex items-center justify-between px-4 py-1.5 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors"
                                                        >
                                                            <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 truncate max-w-[100px]">{base}</span>
                                                            <div className="flex flex-col items-end ml-2">
                                                                <span className="text-[11px] font-price font-semibold text-heading tabular-nums">
                                                                    {p.price != null ? Number(p.price).toFixed(2) : '—'}
                                                                </span>
                                                                <span className={cn('text-[9px] tabular-nums', pPos ? 'text-bull' : 'text-bear')}>
                                                                    {pChg != null ? `${pPos ? '+' : ''}${Number(pChg).toFixed(2)}%` : '—'}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const getPriceForSymbol = (prices, symbol) => {
    const raw = String(symbol || '').trim();
    if (!raw) return {};

    const upper = raw.toUpperCase();
    const withNs = upper.endsWith('.NS') || upper.endsWith('.BO') || upper.startsWith('^') ? upper : `${upper}.NS`;
    const withoutNs = upper.replace(/\.(NS|BO)$/i, '');

    return prices[upper] ?? prices[withNs] ?? prices[withoutNs] ?? {};
};

// ── Tab dots menu (portal — never clipped, never eaten by parent onClick) ──────
function TabMenu({ wl, anchorRect, onRename, onDelete, onClose, canDelete }) {
    const menuRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        const handler = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
        };
        const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
        return () => {
            clearTimeout(id);
            document.removeEventListener('mousedown', handler);
        };
    }, [onClose]);

    const top = anchorRect.bottom + 4;
    const left = anchorRect.left;

    return createPortal(
        <div
            ref={menuRef}
            style={{ position: 'fixed', top, left, zIndex: 9999, width: 148 }}
            className="bg-surface-900 border border-edge/10 rounded-lg shadow-2xl overflow-hidden animate-slide-in"
            onMouseDown={(e) => e.stopPropagation()}
        >
            <button
                onClick={() => { onRename(); onClose(); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-heading hover:bg-surface-800 transition-colors text-left"
            >
                <Pencil className="w-3.5 h-3.5 flex-shrink-0" />
                Rename
            </button>
            {canDelete && (
                <>
                    <div className="border-t border-edge/10 mx-2" />
                    <button
                        onClick={() => { onDelete(); onClose(); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-red-500 hover:bg-red-500/10 transition-colors text-left"
                    >
                        <Trash2 className="w-3.5 h-3.5 flex-shrink-0" />
                        Delete watchlist
                    </button>
                </>
            )}
        </div>,
        document.getElementById('portal-root') || document.body
    );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function Watchlist({
    selectedSymbol,
    onSelectSymbol,
    onBuy,
    onSell,
    onClose,
}) {
    const {
        watchlists,
        activeId,
        prices,
        isLoading,
        setActiveWatchlist,
        createWatchlist,
        renameWatchlist,
        deleteWatchlist,
        addItem,
        removeItem,
        reorderItems,
        fetchPrices,
        openIndexWatchlist,
    } = useWatchlistStore();

    const activeWatchlist = watchlists.find(w => w.id === activeId);
    const items = activeWatchlist?.items ?? [];

    // ── UI state ──────────────────────────────────────────────────────────────
    const [search, setSearch] = useState('');
    const [addSearch, setAddSearch] = useState('');
    const [addResults, setAddResults] = useState([]);
    const [popularSuggestions, setPopularSuggestions] = useState([]);
    const [addSearchFocused, setAddSearchFocused] = useState(false);
    const addSearchRef = useRef(null);

    // Rename state
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);

    // New watchlist creation
    const [isCreating, setIsCreating] = useState(false);
    const [newWlName, setNewWlName] = useState('');
    const newWlInputRef = useRef(null);

    // Tab dots menu
    const [menuState, setMenuState] = useState(null); // { wlId, rect }

    // Drag-and-drop state
    const [dragIndex, setDragIndex] = useState(null);
    const [dragOverIndex, setDragOverIndex] = useState(null);

    const scrollEl = useRef(null);

    // ── Focus helpers ─────────────────────────────────────────────────────────
    useEffect(() => {
        if (renamingId) renameInputRef.current?.select();
    }, [renamingId]);

    useEffect(() => {
        if (isCreating) newWlInputRef.current?.focus();
    }, [isCreating]);

    // ── Filter items ──────────────────────────────────────────────────────────
    const filtered = items.filter((item) =>
        search.length === 0 ||
        item.symbol.toLowerCase().includes(search.toLowerCase()) ||
        item.company_name?.toLowerCase().includes(search.toLowerCase())
    );

    // ── Symbol search for add panel ───────────────────────────────────────────
    useEffect(() => {
        if (addSearch.length < 1) { setAddResults([]); return; }
        const t = setTimeout(async () => {
            try {
                const res = await api.get(`/market/search?q=${encodeURIComponent(addSearch)}`);
                setAddResults(res.data.results || []);
            } catch { /* ignore */ }
        }, 300);
        return () => clearTimeout(t);
    }, [addSearch]);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const res = await api.get('/market/popular');
                if (!active) return;
                setPopularSuggestions((res.data?.stocks || []).slice(0, 10));
            } catch {
                if (active) setPopularSuggestions([]);
            }
        })();
        return () => { active = false; };
    }, []);

    // ── Fetch prices when item count changes (new symbol added/removed) ────────
    const itemCountRef = useRef(items.length);
    useEffect(() => {
        if (items.length > 0 && items.length !== itemCountRef.current) {
            itemCountRef.current = items.length;
            fetchPrices();
        }
    }, [items.length, fetchPrices]);

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleAdd = useCallback((symbol, exchange) => {
        addItem(symbol, exchange);
        setAddSearch('');
        setAddResults([]);
    }, [addItem]);

    const handleStartRename = useCallback((wl) => {
        setRenamingId(wl.id);
        setRenameValue(wl.name);
    }, []);

    const handleRenameSubmit = useCallback(() => {
        if (renamingId && renameValue.trim()) {
            renameWatchlist(renamingId, renameValue.trim());
        }
        setRenamingId(null);
    }, [renamingId, renameValue, renameWatchlist]);

    const handleRenameKeyDown = useCallback((e) => {
        if (e.key === 'Enter') handleRenameSubmit();
        if (e.key === 'Escape') setRenamingId(null);
    }, [handleRenameSubmit]);

    const handleCreateSubmit = useCallback(async () => {
        const name = newWlName.trim() || 'New Watchlist';
        await createWatchlist(name);
        setIsCreating(false);
        setNewWlName('');
    }, [newWlName, createWatchlist]);

    const handleCreateKeyDown = useCallback((e) => {
        if (e.key === 'Enter') handleCreateSubmit();
        if (e.key === 'Escape') { setIsCreating(false); setNewWlName(''); }
    }, [handleCreateSubmit]);

    // Open dots menu — capture button rect for portal positioning
    const handleDotsClick = useCallback((e, wlId) => {
        e.stopPropagation();
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setMenuState(prev =>
            prev?.wlId === wlId ? null : { wlId, rect }
        );
    }, []);

    const activeMenu = menuState
        ? watchlists.find(w => w.id === menuState.wlId)
        : null;

    return (
        <div className="flex flex-col h-full border-r border-edge/5 bg-surface-900/60">

            {/* ── TAB BAR ───────────────────────────────────────────────── */}
            <div
                className="flex items-center border-b border-edge/5 bg-surface-900/40 overflow-x-auto flex-shrink-0"
                style={{ scrollbarWidth: 'none', minHeight: 36 }}
            >
                {watchlists.map((wl) => {
                    const isActive = wl.id === activeId;
                    const isRenaming = renamingId === wl.id;

                    return (
                        <div
                            key={wl.id}
                            className={cn(
                                'relative flex items-center flex-shrink-0 group/tab border-r border-edge/5',
                                isActive
                                    ? 'bg-surface-800/80 border-b-2 border-b-primary-500'
                                    : 'hover:bg-surface-800/40 cursor-pointer',
                            )}
                            style={{ maxWidth: 130 }}
                            onClick={() => {
                                if (!isRenaming) setActiveWatchlist(wl.id);
                            }}
                        >
                            {isRenaming ? (
                                <input
                                    ref={renameInputRef}
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={handleRenameKeyDown}
                                    onBlur={handleRenameSubmit}
                                    maxLength={24}
                                    className="w-24 px-2 py-1.5 text-[11px] font-semibold bg-transparent text-primary-600 focus:outline-none"
                                    onClick={(e) => e.stopPropagation()}
                                />
                            ) : (
                                <span
                                    className={cn(
                                        'px-3 py-2 text-[11px] font-semibold truncate select-none leading-none',
                                        isActive ? 'text-heading' : 'text-gray-500',
                                    )}
                                    onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        handleStartRename(wl);
                                    }}
                                    title={wl.name}
                                >
                                    {wl.name}
                                </span>
                            )}

                            {/* Dots button — always rendered for active, shown on hover */}
                            {isActive && !isRenaming && (
                                <button
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => handleDotsClick(e, wl.id)}
                                    className={cn(
                                        'pr-1.5 pl-0.5 py-2 text-gray-600 hover:text-gray-700 flex-shrink-0',
                                        'opacity-0 group-hover/tab:opacity-100 transition-opacity',
                                        menuState?.wlId === wl.id && 'opacity-100 text-gray-600',
                                    )}
                                    title="Watchlist options"
                                >
                                    <MoreVertical className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    );
                })}

                {/* + New watchlist */}
                {isCreating ? (
                    <div className="flex items-center flex-shrink-0 px-1.5 gap-1 border-r border-edge/5">
                        <input
                            ref={newWlInputRef}
                            value={newWlName}
                            onChange={(e) => setNewWlName(e.target.value)}
                            onKeyDown={handleCreateKeyDown}
                            onBlur={handleCreateSubmit}
                            placeholder="Name…"
                            maxLength={24}
                            className="w-20 px-1.5 py-1 text-[11px] bg-surface-800/80 border border-primary-500/40 rounded text-heading placeholder-gray-600 focus:outline-none"
                        />
                        <button
                            onMouseDown={(e) => { e.preventDefault(); handleCreateSubmit(); }}
                            className="text-primary-600 hover:text-primary-500 p-0.5"
                        >
                            <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onMouseDown={(e) => { e.preventDefault(); setIsCreating(false); setNewWlName(''); }}
                            className="text-gray-600 hover:text-gray-400 p-0.5"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => setIsCreating(true)}
                        className="flex-shrink-0 px-2.5 py-2 text-gray-600 hover:text-primary-600 hover:bg-primary-500/5 transition-colors"
                        title="New watchlist"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                )}

                {/* Collapse */}
                {onClose && (
                    <button
                        onClick={onClose}
                        className="ml-auto flex-shrink-0 px-2 py-2 text-gray-600 hover:text-red-500 transition-colors"
                        title="Hide watchlist"
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 19l-7-7 7-7M18 5l-6 7 6 7" />
                        </svg>
                    </button>
                )}
            </div>

            {/* ── Portal: Tab dots menu ──────────────────────────────────── */}
            {menuState && activeMenu && (
                <TabMenu
                    wl={activeMenu}
                    anchorRect={menuState.rect}
                    canDelete={watchlists.length > 1}
                    onRename={() => handleStartRename(activeMenu)}
                    onDelete={() => deleteWatchlist(activeMenu.id)}
                    onClose={() => setMenuState(null)}
                />
            )}

            {/* ── FILTER ROW ─────────────────────────────────────────────── */}
            <div className="px-3 py-2 border-b border-edge/5 flex items-center gap-2 flex-shrink-0">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600 pointer-events-none" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filter…"
                        className="w-full pl-7 pr-6 py-1.5 text-xs bg-surface-800/40 border border-edge/5 rounded-lg text-gray-600 placeholder-gray-600 focus:outline-none focus:border-primary-500/20"
                    />
                    {search && (
                        <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400">
                            <X className="w-3 h-3" />
                        </button>
                    )}
                </div>
            </div>

            {/* ── ADD SYMBOL SEARCH (inline) ───────────────────────────── */}
            <div className="px-3 py-2 border-b border-edge/5 flex-shrink-0">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
                    <input
                        ref={addSearchRef}
                        value={addSearch}
                        onChange={(e) => setAddSearch(e.target.value)}
                        onFocus={() => setAddSearchFocused(true)}
                        onBlur={() => setTimeout(() => setAddSearchFocused(false), 150)}
                        placeholder="Add symbol… (e.g. RELIANCE)"
                        className="w-full pl-7 pr-7 py-1.5 text-xs bg-surface-900/60 border border-edge/10 rounded-lg text-heading placeholder-gray-500 focus:outline-none focus:border-primary-500/30 transition-colors"
                    />
                    {addSearch && (
                        <button
                            onMouseDown={(e) => { e.preventDefault(); setAddSearch(''); setAddResults([]); addSearchRef.current?.focus(); }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    )}
                </div>

                {addSearch.length > 0 && (
                    <div className="mt-2 max-h-48 overflow-y-auto bg-surface-800/40 border border-edge/10 rounded-lg">
                        {addResults.map((s) => {
                            const indexEntry = findIndexEntry(s.symbol, s.name);
                            const alreadyAdded = !indexEntry && items.some(i => i.symbol === s.symbol);
                            const indexStocks = indexEntry ? (getConstituents(indexEntry.key) ?? []) : [];

                            if (indexEntry && indexStocks.length > 0) {
                                // Index result → offer to open as separate watchlist
                                return (
                                    <div
                                        key={s.symbol}
                                        className="w-full flex items-center justify-between px-3 py-2 border-b border-edge/[0.03] last:border-0"
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs font-semibold text-heading">{cleanSymbol(s.symbol)}</span>
                                                <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium leading-4 tracking-wide bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                                    INDEX
                                                </span>
                                            </div>
                                            <div className="text-[11px] text-gray-500 truncate max-w-[160px]">{s.name} · {indexStocks.length} stocks</div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                openIndexWatchlist(indexEntry.key, indexEntry.label, indexStocks);
                                                setAddSearch('');
                                                setAddResults([]);
                                            }}
                                            className="flex-shrink-0 ml-2 px-2 py-1 text-[10px] font-semibold rounded-md border border-primary-500/30 text-primary-600 hover:bg-primary-500/10 transition-colors whitespace-nowrap"
                                        >
                                            Open WL
                                        </button>
                                    </div>
                                );
                            }

                            return (
                                <button
                                    key={s.symbol}
                                    onClick={() => !alreadyAdded && handleAdd(s.symbol, s.exchange || 'NSE')}
                                    disabled={alreadyAdded}
                                    className={cn(
                                        'w-full flex items-center justify-between px-3 py-2 text-left border-b border-edge/[0.03] last:border-0 transition-colors',
                                        alreadyAdded ? 'opacity-60 cursor-not-allowed' : 'hover:bg-overlay/5 cursor-pointer'
                                    )}
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-xs font-semibold text-heading">{cleanSymbol(s.symbol)}</span>
                                            <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium leading-4 tracking-wide bg-gray-200 text-gray-600">
                                                {s.exchange || 'NSE'}
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-gray-500 truncate max-w-[160px]">{s.name}</div>
                                    </div>
                                    {alreadyAdded
                                        ? <Star className="w-4 h-4 text-sky-400 flex-shrink-0" fill="currentColor" />
                                        : <Star className="w-4 h-4 text-gray-500 flex-shrink-0" />}
                                </button>
                            );
                        })}
                        {addResults.length === 0 && (
                            <div className="px-3 py-4 text-xs text-gray-600 text-center">No results</div>
                        )}
                    </div>
                )}

                {addSearch.length === 0 && (addSearchFocused || popularSuggestions.length > 0) && (
                    <div className="mt-2 bg-surface-800/30 border border-edge/10 rounded-lg p-2">
                        <div className="flex items-center gap-1 px-1 pb-1.5">
                            <TrendingUp className="w-3 h-3 text-gray-500" />
                            <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Popular</span>
                        </div>
                        {popularSuggestions.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {popularSuggestions.map((s) => {
                                    const alreadyAdded = items.some((i) => i.symbol === s.symbol);
                                    return (
                                        <button
                                            key={s.symbol}
                                            type="button"
                                            onClick={() => !alreadyAdded && handleAdd(s.symbol, s.exchange || 'NSE')}
                                            disabled={alreadyAdded}
                                            className={cn(
                                                'px-2 py-1 rounded-md text-[11px] border transition-colors',
                                                alreadyAdded
                                                    ? 'border-sky-500/30 text-sky-500 bg-sky-500/10 cursor-not-allowed'
                                                    : 'border-edge/20 text-heading hover:border-primary-500/30 hover:bg-primary-500/10 cursor-pointer'
                                            )}
                                            title={s.name || s.symbol}
                                        >
                                            {cleanSymbol(s.symbol)}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-[11px] text-gray-600 px-1 py-1">Type to search for symbols</div>
                        )}
                    </div>
                )}
            </div>

            {/* ── STOCK LIST (drag-and-drop sortable) ─────────────────── */}
            <div ref={scrollEl} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                {/* Indices section — always shown at top */}
                <IndicesSection
                    onSelectSymbol={onSelectSymbol}
                    onOpenIndexWatchlist={openIndexWatchlist}
                />

                {isLoading ? (
                    <div>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} variant="watchlist-row" />)}</div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-gray-600 text-xs">
                        <p>{search ? 'No matches' : 'Watchlist is empty'}</p>
                        {!search && (
                            <button onClick={() => document.querySelector('input[placeholder="Search symbol…"]')?.focus()} className="mt-2 text-primary-600 hover:underline">
                                Add symbols
                            </button>
                        )}
                    </div>
                ) : (
                    <div>
                        {filtered.map((item, index) => {
                            const price = getPriceForSymbol(prices, item.symbol);
                            const isDragging = dragIndex === index;
                            const isDragOver = dragOverIndex === index && dragIndex !== index;
                            const canDrag = !search;

                            return (
                                <div
                                    key={item.id}
                                    draggable={canDrag}
                                    onDragStart={(e) => {
                                        setDragIndex(index);
                                        e.dataTransfer.effectAllowed = 'move';
                                        e.dataTransfer.setData('text/plain', index.toString());
                                    }}
                                    onDragEnd={() => {
                                        setDragIndex(null);
                                        setDragOverIndex(null);
                                    }}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        e.dataTransfer.dropEffect = 'move';
                                        if (dragOverIndex !== index) setDragOverIndex(index);
                                    }}
                                    onDragEnter={(e) => {
                                        e.preventDefault();
                                        setDragOverIndex(index);
                                    }}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        if (dragIndex !== null && dragIndex !== index) {
                                            reorderItems(dragIndex, index);
                                        }
                                        setDragIndex(null);
                                        setDragOverIndex(null);
                                    }}
                                    className={cn(
                                        isDragging && 'opacity-30',
                                        isDragOver && 'border-t-2 border-t-primary-500',
                                    )}
                                >
                                    <WatchlistItem
                                        item={item}
                                        price={price}
                                        isSelected={item.symbol === selectedSymbol}
                                        onSelect={() => onSelectSymbol?.(item.symbol)}
                                        onRemove={removeItem}
                                        onBuy={onBuy}
                                        onSell={onSell}
                                    />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── FOOTER ───────────────────────────────────────────────── */}
            <div className="px-3 py-1.5 border-t border-edge/5 text-[11px] text-gray-600 flex-shrink-0">
                {filtered.length} / {items.length} symbols
            </div>
        </div>
    );
}
