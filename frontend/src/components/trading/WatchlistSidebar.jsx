import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Menu, Plus, Star, Trash2, MoreVertical, X } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * WatchlistSidebar — side drawer with watchlist options (hamburger menu)
 * Shows: list of all watchlists, create new, rename, delete
 */
export default function WatchlistSidebar({
    watchlists = [],
    activeId = null,
    onSelectWatchlist,
    onCreateNew,
    isOpen,
    onClose,
}) {
    const sidebarRef = useRef(null);
    const [renaming, setRenaming] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);

    // Close on escape
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') onClose?.();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e) => {
            if (sidebarRef.current && !sidebarRef.current.contains(e.target)) {
                onClose?.();
            }
        };
        document.addEventListener('click', handleClick);
        return () => document.removeEventListener('click', handleClick);
    }, [isOpen, onClose]);

    // Auto-focus rename input
    useEffect(() => {
        if (renaming) {
            setTimeout(() => renameInputRef.current?.select(), 0);
        }
    }, [renaming]);

    if (!isOpen) return null;

    return createPortal(
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-[900] bg-black/20 backdrop-blur-sm animate-fade-in"
                onClick={onClose}
            />

            {/* Sidebar */}
            <div
                ref={sidebarRef}
                className="fixed left-0 top-0 bottom-0 z-[950] w-80 bg-surface-900 border-r border-edge/5 shadow-2xl flex flex-col animate-slide-in-left overflow-hidden"
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-edge/5 flex items-center justify-between flex-shrink-0">
                    <h2 className="text-base font-semibold text-heading">Watchlists</h2>
                    <button
                        onClick={onClose}
                        className="p-1.5 text-gray-500 hover:text-gray-400 hover:bg-surface-800 rounded-lg transition-colors"
                        aria-label="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Create New Button */}
                <div className="px-4 py-3 border-b border-edge/5 flex-shrink-0">
                    <button
                        onClick={() => {
                            onCreateNew?.();
                            onClose?.();
                        }}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600/20 hover:bg-primary-600/30 text-primary-600 rounded-lg font-semibold text-sm transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                        New Watchlist
                    </button>
                </div>

                {/* Watchlist Items */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                    {watchlists.length === 0 ? (
                        <div className="px-6 py-8 text-center text-gray-500 text-sm">
                            <p>No watchlists yet</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-edge/5">
                            {watchlists.map((wl) => {
                                const isActive = wl.id === activeId;
                                const isRenaming = renaming === wl.id;

                                return (
                                    <div
                                        key={wl.id}
                                        className={cn(
                                            'px-4 py-3 flex items-center justify-between gap-3 group/item hover:bg-surface-800/40 transition-colors',
                                            isActive && 'bg-primary-500/10 border-l-2 border-l-primary-500'
                                        )}
                                    >
                                        <div
                                            className="flex-1 min-w-0 cursor-pointer"
                                            onClick={() => {
                                                onSelectWatchlist?.(wl.id);
                                                onClose?.();
                                            }}
                                        >
                                            {isRenaming ? (
                                                <input
                                                    ref={renameInputRef}
                                                    value={renameValue}
                                                    onChange={(e) => setRenameValue(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            // Call rename function here if provided
                                                            setRenaming(null);
                                                        }
                                                        if (e.key === 'Escape') setRenaming(null);
                                                    }}
                                                    onBlur={() => setRenaming(null)}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="w-full px-2 py-1 bg-surface-800 border border-primary-500/20 rounded text-sm text-heading focus:outline-none focus:border-primary-500/50"
                                                />
                                            ) : (
                                                <div>
                                                    <p className="text-sm font-medium text-heading truncate">
                                                        {wl.name}
                                                    </p>
                                                    <p className="text-xs text-gray-500 mt-0.5">
                                                        {wl.items?.length ?? 0} symbols
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        {/* Action buttons - show on hover or when active */}
                                        {(isActive || isRenaming) && !isRenaming && (
                                            <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setRenaming(wl.id);
                                                        setRenameValue(wl.name);
                                                    }}
                                                    className="p-1.5 text-gray-500 hover:text-primary-600 hover:bg-surface-800 rounded transition-colors"
                                                    title="Rename"
                                                >
                                                    <MoreVertical className="w-4 h-4" />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer Stats */}
                <div className="px-4 py-3 border-t border-edge/5 flex-shrink-0 text-xs text-gray-500 flex justify-between">
                    <span>{watchlists.length} watchlist{watchlists.length !== 1 ? 's' : ''}</span>
                    <span>{watchlists.reduce((sum, wl) => sum + (wl.items?.length ?? 0), 0)} total symbols</span>
                </div>
            </div>
        </>,
        document.getElementById('portal-root') || document.body
    );
}
