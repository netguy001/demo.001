import { create } from 'zustand';
import api, { isRateLimited } from '../services/api';
import toast from 'react-hot-toast';
import { isMcxSymbol } from '../utils/constants';

const STORAGE_KEY = 'alphasync_watchlists';
const LEGACY_DEFAULT_WATCHLIST_NAMES = new Set([
    'my watchlist',
    'bank nifty',
    'nifty pharma',
    'nifty auto',
    'nifty fmcg',
    'nifty metal',
    'nifty next 50',
    'india vix',
]);

const normalizeWatchlistName = (name = '') => String(name || '').trim().toLowerCase();

const isLegacyDefaultWatchlist = (watchlist) => LEGACY_DEFAULT_WATCHLIST_NAMES.has(normalizeWatchlistName(watchlist?.name));

const sanitizeWatchlists = (watchlists = []) => (watchlists || []).filter((wl) => !isLegacyDefaultWatchlist(wl));

/**
 * Helper: Save watchlists to localStorage for persistence across refreshes
 */
const persistToStorage = (watchlists, activeId) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ watchlists, activeId }));
    } catch (err) {
        console.error('[Watchlist] Failed to persist to localStorage:', err);
    }
};

/**
 * Helper: Load watchlists from localStorage
 */
const loadFromStorage = () => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);

        if (stored) {
            const parsed = JSON.parse(stored);
            return parsed;
        }
    } catch (err) {
        console.error('[Watchlist] Failed to load from localStorage:', err);
    }
    return null;
};

const toNumberOrNull = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

const ensureNsSuffix = (symbol = '') => {
    const base = String(symbol || '').trim();
    if (!base) return '';
    if (base.startsWith('^') || base.endsWith('.NS') || base.endsWith('.BO') || isMcxSymbol(base)) return base.toUpperCase();
    return `${base.toUpperCase()}.NS`;
};

const stripExchangeSuffix = (symbol = '') => String(symbol || '').replace(/\.(NS|BO)$/i, '').toUpperCase();

const isLocalWatchlistId = (id = '') => String(id || '').startsWith('local_') || String(id || '').startsWith('idx_');

const normalizeWatchlistSymbolKey = (symbol = '') => stripExchangeSuffix(symbol).replace(/^\^/, '');

const canonicalizeWatchlistSymbol = (symbol = '', exchange = 'NSE') => {
    const raw = String(symbol || '').trim();
    if (!raw) return '';
    const upper = raw.toUpperCase();
    if (String(exchange || 'NSE').toUpperCase() === 'MCX' || upper.startsWith('^') || upper.endsWith('.NS') || upper.endsWith('.BO')) {
        return upper;
    }
    return ensureNsSuffix(upper);
};

const normalizeWatchlistItems = (items = []) =>
    (items || []).map((item) => {
        const normalizedSymbol = canonicalizeWatchlistSymbol(item?.symbol, item?.exchange || 'NSE');
        return {
            ...item,
            symbol: normalizedSymbol || String(item?.symbol || '').toUpperCase(),
        };
    });

const normalizeWatchlists = (watchlists = []) =>
    sanitizeWatchlists(watchlists || []).map((watchlist) => ({
        ...watchlist,
        items: normalizeWatchlistItems(watchlist?.items || []),
    }));

const toIndexWatchlistId = (indexKey = '') => {
    const safe = String(indexKey || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return `idx_${safe || 'custom'}`;
};

const normalizeQuote = (quote = {}) => {
    const now = Date.now();
    const prevClose = toNumberOrNull(
        quote.prev_close ?? quote.prevClose ?? quote.close ?? quote.pc
    );
    const price = toNumberOrNull(
        quote.price ?? quote.lp ?? quote.ltp ?? quote.last_price ?? quote.lastPrice
    );

    let change = toNumberOrNull(quote.change ?? quote.net_change ?? quote.netChange);
    let changePercent = toNumberOrNull(
        quote.change_percent ?? quote.changePercent ?? quote.pct_change ?? quote.pChange ?? quote.percent_change
    );

    if (change == null && price != null && prevClose != null) {
        change = price - prevClose;
    }

    if (changePercent == null && change != null && prevClose && prevClose !== 0) {
        changePercent = (change / prevClose) * 100;
    }

    return {
        ...quote,
        price: price ?? undefined,
        change: change ?? null,
        change_percent: changePercent ?? null,
        prev_close: prevClose ?? quote.prev_close ?? quote.close ?? 0,
        _updatedAt: toNumberOrNull(quote._updatedAt) ?? now,
    };
};

/**
 * Multi-watchlist store — supports unlimited watchlists per user.
 *
 * State shape:
 *   watchlists  — all watchlists [{id, name, items[]}]
 *   activeId    — currently viewed watchlist id
 *   prices      — symbol → quote (shared across all lists)
 *
 * Persistence: Uses localStorage to save watchlists across page refreshes.
 * Syncs with server on load and updates localStorage when successful.
 *
 * ⚠️  CRITICAL FIX: Removed JS getter syntax (get items(){}) from Zustand store.
 *     Zustand cannot track plain JS getters reactively — any component using them
 *     will NEVER re-render when underlying state changes (stale closure bug).
 *     Components must use proper Zustand selectors instead:
 *       const items = useWatchlistStore(s =>
 *         s.watchlists.find(w => w.id === s.activeId)?.items ?? []
 *       )
 */
export const useWatchlistStore = create((set, get) => ({
    /** @type {Array<{id:string, name:string, items:Array}>} */
    watchlists: [],

    /** @type {string|null} */
    activeId: null,

    /** @type {Record<string, object>} */
    prices: {},

    /** @type {boolean} */
    isLoading: false,

    // ── Load all watchlists on mount ──────────────────────────────────────────
    loadWatchlist: async () => {
        set({ isLoading: true });

        // 1. Try to load from localStorage first (fast cache)
        const cached = loadFromStorage();
        if (cached && cached.watchlists.length > 0) {
            const sanitizedCached = normalizeWatchlists(cached.watchlists);
            const nextActiveId = sanitizedCached.some((w) => w.id === cached.activeId)
                ? cached.activeId
                : sanitizedCached[0]?.id ?? null;
            set({ watchlists: sanitizedCached, activeId: nextActiveId });
        }

        try {
            // 2. Try to sync with server
            const res = await api.get('/watchlist');
            const wls = normalizeWatchlists(res.data.watchlists || []);
            if (wls.length > 0) {
                const nextActiveId = cached?.activeId && wls.some((w) => w.id === cached.activeId)
                    ? cached.activeId
                    : wls[0].id;
                set({ watchlists: wls, activeId: nextActiveId });
                // Update localStorage with server data
                persistToStorage(wls, nextActiveId);
            } else {
                // Create default watchlist on server
                const created = await api.post('/watchlist', { name: 'Watchlist 1' });
                const newWl = { ...created.data, items: [] };
                set({ watchlists: [newWl], activeId: newWl.id });
                persistToStorage([newWl], newWl.id);
            }
        } catch (err) {
            console.error('[Watchlist] Server sync failed, using local fallback:', err);
            // On API error, use localStorage if available, otherwise create local fallback
            if (!cached || cached.watchlists.length === 0) {
                const defaultId = `local_${Date.now()}`;
                const defaultWl = { id: defaultId, name: 'Watchlist 1', items: [] };
                set({ watchlists: [defaultWl], activeId: defaultId });
                persistToStorage([defaultWl], defaultId);
            }
        } finally {
            set({ isLoading: false });
        }
    },

    // ── Switch active watchlist ───────────────────────────────────────────────
    setActiveWatchlist: (id) => {
        set({ activeId: id });
        // Persist updated activeId
        const { watchlists, activeId } = get();
        persistToStorage(watchlists, activeId);
        get().fetchPrices();
    },

    // ── Create a new named watchlist ──────────────────────────────────────────
    createWatchlist: async (name = 'New Watchlist') => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        try {
            const res = await api.post('/watchlist', { name: trimmed });
            const newWl = { ...res.data, items: [] };
            set((s) => ({
                watchlists: [...s.watchlists, newWl],
                activeId: newWl.id,
            }));
            // Persist after state update
            const { watchlists, activeId } = get();
            persistToStorage(watchlists, activeId);
            toast.success(`"${trimmed}" created`);
            return newWl;
        } catch (err) {
            toast.error(err.response?.data?.detail || 'Failed to create watchlist');
            return null;
        }
    },

    // ── Open/create a dedicated local watchlist for an index basket ─────────
    openIndexWatchlist: (indexKey, indexLabel, constituentSymbols = []) => {
        const id = toIndexWatchlistId(indexKey || indexLabel);
        const safeLabel = String(indexLabel || 'Index').trim() || 'Index';

        const normalizedItems = Array.from(
            new Set(
                (constituentSymbols || [])
                    .map((sym) => ensureNsSuffix(sym))
                    .filter(Boolean)
            )
        ).map((symbol, idx) => ({
            id: `${id}_${idx}`,
            symbol,
            exchange: 'NSE',
        }));

        if (normalizedItems.length === 0) return;

        set((s) => {
            const existingIdx = s.watchlists.findIndex((w) => w.id === id);
            const watchlist = {
                id,
                name: `${safeLabel}`,
                items: normalizedItems,
                isLocalIndex: true,
            };

            if (existingIdx >= 0) {
                const next = [...s.watchlists];
                next[existingIdx] = watchlist;
                return { watchlists: next, activeId: id };
            }
            return { watchlists: [...s.watchlists, watchlist], activeId: id };
        });

        const { watchlists, activeId } = get();
        persistToStorage(watchlists, activeId);
        get().fetchPrices();
        toast.success(`${safeLabel} watchlist opened`);
    },

    // ── Rename a watchlist (optimistic) ──────────────────────────────────────
    renameWatchlist: async (id, newName) => {
        const trimmed = newName?.trim();
        if (!id || !trimmed) return;
        set((s) => ({
            watchlists: s.watchlists.map(w =>
                w.id === id ? { ...w, name: trimmed } : w
            ),
        }));
        if (isLocalWatchlistId(id)) {
            const { watchlists, activeId } = get();
            persistToStorage(watchlists, activeId);
            return;
        }
        try {
            await api.patch(`/watchlist/${id}`, { name: trimmed });
            // Persist after successful rename
            const { watchlists, activeId } = get();
            persistToStorage(watchlists, activeId);
        } catch {
            get().loadWatchlist();
            toast.error('Failed to rename');
        }
    },

    // ── Delete a watchlist (optimistic, keeps at least 1) ────────────────────
    deleteWatchlist: async (id) => {
        const { watchlists, activeId } = get();
        if (watchlists.length <= 1) {
            toast.error('You need at least one watchlist');
            return;
        }
        const remaining = watchlists.filter(w => w.id !== id);
        const newActive = activeId === id ? remaining[0].id : activeId;
        set({ watchlists: remaining, activeId: newActive });
        if (isLocalWatchlistId(id)) {
            persistToStorage(remaining, newActive);
            toast.success('Watchlist deleted');
            return;
        }
        try {
            await api.delete(`/watchlist/${id}`);
            // Persist after successful delete
            persistToStorage(remaining, newActive);
            toast.success('Watchlist deleted');
        } catch {
            set({ watchlists, activeId });
            toast.error('Failed to delete watchlist');
        }
    },

    // ── Add symbol to active watchlist (optimistic) ───────────────────────────
    // Optimistic update runs BEFORE the API call so the star turns gold instantly.
    addItem: async (symbol, exchange = 'NSE') => {
        let { activeId, watchlists } = get();
        if (!activeId || watchlists.length === 0) {
            await get().loadWatchlist();
            ({ activeId, watchlists } = get());
        }
        if (!activeId || watchlists.length === 0) {
            console.error('[Watchlist] Still no activeId after loadWatchlist');
            toast.error('Cannot add to watchlist — initialization failed');
            return;
        }
        const active = watchlists.find(w => w.id === activeId);
        if (!active) {
            toast.error('Watchlist not found');
            return;
        }
        const normalizedSymbol = canonicalizeWatchlistSymbol(symbol, exchange);
        const symbolKey = normalizeWatchlistSymbolKey(normalizedSymbol);
        if (active.items.some(i => normalizeWatchlistSymbolKey(i.symbol) === symbolKey)) {
            toast.info(`${normalizedSymbol.replace('.NS', '')} is already in watchlist`);
            return;
        }

        const tempId = `temp_${Date.now()}`;

        // ✅ Optimistic insert — UI reacts immediately, star goes gold before API
        set((s) => ({
            watchlists: s.watchlists.map(w =>
                w.id === activeId
                    ? { ...w, items: [...w.items, { id: tempId, symbol: normalizedSymbol, exchange }] }
                    : w
            ),
        }));

        // Persist optimistic state immediately
        let { watchlists: updatedWatchlists, activeId: updatedActiveId } = get();
        persistToStorage(updatedWatchlists, updatedActiveId);

        toast.success(`${normalizedSymbol.replace('.NS', '')} added to watchlist`);

        try {
            // If it's a local watchlist (id starts with 'local_'), skip server sync
            if (!isLocalWatchlistId(activeId)) {
                const res = await api.post(`/watchlist/${activeId}/items`, { symbol: normalizedSymbol, exchange });
                // Swap temp record with real server record if we get a real ID back
                if (res.data?.id) {
                    set((s) => ({
                        watchlists: s.watchlists.map(w =>
                            w.id === activeId
                                ? { ...w, items: w.items.map(i => i.id === tempId ? res.data : i) }
                                : w
                        ),
                    }));
                    // Persist after server sync
                    ({ watchlists: updatedWatchlists, activeId: updatedActiveId } = get());
                    persistToStorage(updatedWatchlists, updatedActiveId);
                }
            } else {
            }
            // Fetch prices immediately so price shows without waiting for next poll
            get().fetchPrices();
        } catch (err) {
            console.error('[Watchlist] Error during addItem:', err);
            // Rollback on failure
            set((s) => ({
                watchlists: s.watchlists.map(w =>
                    w.id === activeId
                        ? { ...w, items: w.items.filter(i => i.id !== tempId) }
                        : w
                ),
            }));
            // Persist rollback
            ({ watchlists: updatedWatchlists, activeId: updatedActiveId } = get());
            persistToStorage(updatedWatchlists, updatedActiveId);

            const detail = err.response?.data?.detail;
            const status = err.response?.status;
            toast.error(
                detail
                    ? `Failed to sync with server (${status ?? 'ERR'}): ${detail}`
                    : `Failed to sync with server (${status ?? 'ERR'})`
            );
        }
    },

    // ── Remove symbol from active watchlist (optimistic) ─────────────────────
    removeItem: async (itemId) => {
        const { activeId, watchlists } = get();
        if (!activeId) return;
        const snapshot = watchlists;
        set((s) => ({
            watchlists: s.watchlists.map(w =>
                w.id === activeId
                    ? { ...w, items: w.items.filter(i => i.id !== itemId) }
                    : w
            ),
        }));
        // Persist optimistic state
        let { watchlists: updatedWatchlists, activeId: updatedActiveId } = get();
        persistToStorage(updatedWatchlists, updatedActiveId);

        try {
            // If it's a local watchlist, skip server sync
            if (!isLocalWatchlistId(activeId)) {
                await api.delete(`/watchlist/${activeId}/items/${itemId}`);
            }
            toast.success('Removed from watchlist');
        } catch (err) {
            set({ watchlists: snapshot });
            // Restore persisted state on error
            persistToStorage(snapshot, activeId);
            toast.error('Failed to remove symbol');
        }
    },

    // ── Reorder items in active watchlist (client-side) ─────────────────────────
    reorderItems: (fromIndex, toIndex) => {
        const { activeId, watchlists } = get();
        if (!activeId) return;
        const active = watchlists.find(w => w.id === activeId);
        if (!active) return;

        const newItems = [...active.items];
        const [moved] = newItems.splice(fromIndex, 1);
        newItems.splice(toIndex, 0, moved);

        set((s) => ({
            watchlists: s.watchlists.map(w =>
                w.id === activeId ? { ...w, items: newItems } : w
            ),
        }));
        // Persist reordered items
        const { watchlists: updatedWatchlists, activeId: updatedActiveId } = get();
        persistToStorage(updatedWatchlists, updatedActiveId);
    },

    // ── Fetch prices for active watchlist ─────────────────────────────────────
    fetchPrices: async () => {
        // Skip if we're in a 429 cooldown period
        if (isRateLimited()) return;

        const { activeId, watchlists } = get();
        const active = watchlists.find(w => w.id === activeId);
        if (!active || active.items.length === 0) {
            return;
        }

        // Build comma-separated symbol list, ensuring canonical suffix exists
        const symbolList = active.items
            .map(w => ensureNsSuffix(w.symbol))
            .filter(Boolean);

        const symbols = symbolList.join(',');

        if (!symbols) {
            return;
        }


        const normalizedQuotes = {};
        const upsertQuote = (rawKey, rawValue) => {
            const quote = normalizeQuote(rawValue || {});
            const upperKey = String(rawKey || '').toUpperCase();
            const keyWithNs = ensureNsSuffix(upperKey);
            const keyWithoutNs = stripExchangeSuffix(upperKey);

            if (upperKey) normalizedQuotes[upperKey] = quote;
            if (keyWithNs) normalizedQuotes[keyWithNs] = quote;
            if (keyWithoutNs) normalizedQuotes[keyWithoutNs] = quote;

            const quoteSymbol = String(quote.symbol || '').toUpperCase();
            if (quoteSymbol) {
                const quoteWithNs = ensureNsSuffix(quoteSymbol);
                const quoteWithoutNs = stripExchangeSuffix(quoteSymbol);
                normalizedQuotes[quoteSymbol] = quote;
                if (quoteWithNs) normalizedQuotes[quoteWithNs] = quote;
                if (quoteWithoutNs) normalizedQuotes[quoteWithoutNs] = quote;
            }
        };

        let batchFailed = false;
        try {
            const res = await api.get(`/market/batch?symbols=${encodeURIComponent(symbols)}`);
            const quotes = res.data.quotes || {};
            Object.entries(quotes).forEach(([key, value]) => upsertQuote(key, value));
        } catch (err) {
            batchFailed = true;
            // Don't log cancelled requests (rate limit backoff)
            if (err?.message !== 'Rate limited — backing off') {
                console.warn('[Watchlist] Batch fetch failed:', err.message);
            }
        }

        // Only do per-symbol fallback if batch SUCCEEDED but some symbols were missing
        // (NOT when batch failed entirely — that would just create more 429 errors)
        if (!batchFailed && !isRateLimited()) {
            const missingSymbols = symbolList.filter((sym) => {
                const withNs = ensureNsSuffix(sym);
                const withoutNs = stripExchangeSuffix(sym);
                return !(normalizedQuotes[withNs] || normalizedQuotes[withoutNs]);
            });

            if (missingSymbols.length > 0 && missingSymbols.length <= 3) {
                // Only fallback for a few missing symbols, not the entire list
                const quoteResults = await Promise.allSettled(
                    missingSymbols.map((sym) =>
                        api.get(`/market/quote/${encodeURIComponent(sym)}`)
                            .then((res) => ({ symbol: sym, quote: res.data }))
                    )
                );

                quoteResults.forEach((result) => {
                    if (result.status === 'fulfilled' && result.value?.quote) {
                        const { symbol, quote } = result.value;
                        upsertQuote(symbol, quote);
                    }
                });
            }
        }

        // Ensure every requested symbol has aliases so UI lookup always succeeds
        symbolList.forEach((sym) => {
            const withNs = ensureNsSuffix(sym);
            const withoutNs = stripExchangeSuffix(sym);
            const existing = normalizedQuotes[withNs] || normalizedQuotes[withoutNs] || normalizedQuotes[String(sym).toUpperCase()];
            if (existing) {
                normalizedQuotes[withNs] = existing;
                normalizedQuotes[withoutNs] = existing;
            }
        });

        // Merge only changed prices to avoid unnecessary re-renders
        set((s) => {
            const prev = s.prices;
            let hasChanges = false;
            for (const [key, quote] of Object.entries(normalizedQuotes)) {
                const old = prev[key];
                if (!old || old.price !== quote.price || old.change !== quote.change) {
                    hasChanges = true;
                    break;
                }
            }
            // Also check for new keys
            if (!hasChanges && Object.keys(normalizedQuotes).length !== Object.keys(prev).length) {
                hasChanges = true;
            }
            if (!hasChanges) return s; // No change — skip re-render
            return { prices: { ...prev, ...normalizedQuotes } };
        });
    },

    updatePrices: (quotesMap) =>
        set((s) => {
            if (!quotesMap || Object.keys(quotesMap).length === 0) return s;
            const normalizedMap = {};
            const now = Date.now();
            for (const [key, quote] of Object.entries(quotesMap)) {
                normalizedMap[key] = {
                    ...(quote || {}),
                    _updatedAt: toNumberOrNull(quote?._updatedAt) ?? now,
                };
            }
            let hasChanges = false;
            for (const [key, quote] of Object.entries(normalizedMap)) {
                const old = s.prices[key];
                if (!old || old.price !== quote.price || old.change !== quote.change) {
                    hasChanges = true;
                    break;
                }
            }
            if (!hasChanges) return s;
            return { prices: { ...s.prices, ...normalizedMap } };
        }),
}));