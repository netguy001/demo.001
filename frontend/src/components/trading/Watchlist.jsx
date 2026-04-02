import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import WatchlistItem from './WatchlistItem';
import AddSymbolModal from './AddSymbolModal';
import WatchlistSidebar from './WatchlistSidebar';
import Skeleton from '../ui/Skeleton';
import { cn } from '../../utils/cn';
import {
    Search, Plus, X,
    Pencil, Check, Trash2, MoreVertical, Menu,
} from 'lucide-react';
import { useWatchlistStore } from '../../stores/useWatchlistStore';
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
    const [modalOpen, setModalOpen] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);

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

    // ── Fetch prices when item count changes ──────────────────────────────────
    const itemCountRef = useRef(items.length);
    useEffect(() => {
        if (items.length > 0 && items.length !== itemCountRef.current) {
            itemCountRef.current = items.length;
            fetchPrices();
        }
    }, [items.length, fetchPrices]);

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleAddSymbol = useCallback((symbol, exchange) => {
        addItem(symbol, exchange);
        setModalOpen(false);
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

            {/* ── TAB BAR WITH HAMBURGER MENU ───────────────────────────── */}
            <div
                className="flex items-center border-b border-edge/5 bg-surface-900/40 overflow-x-auto flex-shrink-0"
                style={{ scrollbarWidth: 'none', minHeight: 44 }}
            >
                {/* Hamburger Menu */}
                <button
                    onClick={() => setSidebarOpen(true)}
                    className="flex-shrink-0 px-3 py-2.5 text-gray-600 hover:text-gray-400 hover:bg-surface-800/40 transition-colors"
                    title="Watchlist menu"
                >
                    <Menu className="w-4 h-4" />
                </button>

                {/* Watchlist Tabs */}
                <div className="flex items-center flex-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
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
                                            'px-3 py-2.5 text-[11px] font-semibold truncate select-none leading-none',
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

                                {/* Dots button */}
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
                </div>

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
                        className="flex-shrink-0 px-2.5 py-2.5 text-gray-600 hover:text-primary-600 hover:bg-primary-500/5 transition-colors"
                        title="New watchlist"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                )}

                {/* Collapse */}
                {onClose && (
                    <button
                        onClick={onClose}
                        className="ml-auto flex-shrink-0 px-2 py-2.5 text-gray-600 hover:text-red-500 transition-colors"
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

            {/* ── CONTENT AREA ──────────────────────────────────────────── */}
            <div ref={scrollEl} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
                {isLoading ? (
                    // Loading state
                    <div>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} variant="watchlist-row" />)}</div>
                ) : items.length === 0 ? (
                    // Empty state with centered "Add Symbol" button
                    <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-4">
                        <div className="text-center">
                            <p className="text-sm font-medium mb-2">Watchlist is empty</p>
                            <p className="text-xs opacity-75">Add stocks to get started</p>
                        </div>
                        <button
                            onClick={() => setModalOpen(true)}
                            className="px-6 py-3 bg-primary-600/20 hover:bg-primary-600/30 text-primary-600 rounded-lg font-semibold text-sm transition-colors flex items-center gap-2"
                        >
                            <Plus className="w-4 h-4" />
                            Add Symbol
                        </button>
                    </div>
                ) : (
                    // Stock list with search bar at top
                    <div className="flex flex-col h-full">
                        {/* Search bar when items exist */}
                        <div className="px-3 py-2 border-b border-edge/5 flex-shrink-0">
                            <button
                                onClick={() => setModalOpen(true)}
                                className="w-full px-3 py-2 text-left text-sm text-gray-500 bg-surface-800/40 border border-edge/5 rounded-lg hover:bg-surface-800/60 hover:border-edge/20 transition-colors flex items-center gap-2"
                            >
                                <Search className="w-4 h-4 text-gray-500" />
                                <span>Search or add symbol…</span>
                            </button>
                        </div>

                        {/* Stock list */}
                        <div className="flex-1 min-h-0 overflow-y-auto">
                            {items.map((item, index) => {
                                const price = getPriceForSymbol(prices, item.symbol);
                                const isDragging = dragIndex === index;
                                const isDragOver = dragOverIndex === index && dragIndex !== index;

                                return (
                                    <div
                                        key={item.id}
                                        draggable
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

                        {/* Footer */}
                        <div className="px-3 py-1.5 border-t border-edge/5 text-[11px] text-gray-600 flex-shrink-0">
                            {items.length} symbol{items.length !== 1 ? 's' : ''} in watchlist
                        </div>
                    </div>
                )}
            </div>

            {/* ── ADD SYMBOL MODAL ──────────────────────────────────────── */}
            <AddSymbolModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                onAddSymbol={handleAddSymbol}
                watchlistItems={items}
            />

            {/* ── WATCHLIST SIDEBAR ─────────────────────────────────────── */}
            <WatchlistSidebar
                watchlists={watchlists}
                activeId={activeId}
                onSelectWatchlist={setActiveWatchlist}
                onCreateNew={() => setIsCreating(true)}
                isOpen={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
            />
        </div>
    );
}
