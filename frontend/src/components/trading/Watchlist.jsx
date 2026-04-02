import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import WatchlistItem from './WatchlistItem';
import Skeleton from '../ui/Skeleton';
import { cn } from '../../utils/cn';
import {
    Search, Plus, X,
    Pencil, Check, Trash2, MoreVertical, Star,
} from 'lucide-react';
import { useWatchlistStore } from '../../stores/useWatchlistStore';
import api from '../../services/api';
import { cleanSymbol } from '../../utils/formatters';

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
    } = useWatchlistStore();

    const activeWatchlist = watchlists.find(w => w.id === activeId);
    const items = activeWatchlist?.items ?? [];

    // ── UI state ──────────────────────────────────────────────────────────────
    const [search, setSearch] = useState('');
    const [addSearch, setAddSearch] = useState('');
    const [addResults, setAddResults] = useState([]);
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
                            const alreadyAdded = items.some((i) => cleanSymbol(i.symbol) === cleanSymbol(s.symbol) || i.symbol === s.symbol);

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

                {addSearch.length === 0 && addSearchFocused && (
                    <div className="mt-2 bg-surface-800/30 border border-edge/10 rounded-lg p-2">
                        <div className="text-[11px] text-gray-600 px-1 py-1">Type to search for symbols</div>
                    </div>
                )}
            </div>

            {/* ── STOCK LIST (drag-and-drop sortable) ─────────────────── */}
            <div ref={scrollEl} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
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
