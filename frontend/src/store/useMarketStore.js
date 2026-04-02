import { create } from 'zustand';

/**
 * Market data store — source of truth for all live quotes and watchlist.
 *
 * Quote shape (from /market/quote/:symbol API):
 * { price, change, change_percent, volume, high, low, open, prev_close, ... }
 */
export const useMarketStore = create((set, get) => ({
    /** @type {Record<string, object>} symbol → latest quote data */
    symbols: {},

    /** @type {string[]} Ordered watchlist symbol list */
    watchlist: [],

    /** @type {string|null} Currently selected symbol in the terminal */
    selectedSymbol: null,

    /** @type {'connecting'|'connected'|'disconnected'|'error'} */
    wsStatus: 'disconnected',

    /** @type {number} Epoch ms of last successful quote ingestion */
    lastQuoteAt: 0,

    // ─── Actions ─────────────────────────────────────────────────────────────

    /**
     * Update or merge a quote for a symbol.
     * Called by WebSocket handler and polling fallback.
     * Skips update if price hasn't actually changed (prevents unnecessary re-renders).
     * @param {string} symbol
     * @param {object} data
     */
    updateQuote: (symbol, data) =>
        set((state) => {
            const existing = state.symbols[symbol];
            // Skip update if price hasn't changed — avoids cascading re-renders
            if (existing && existing.price === data.price && existing.change === data.change) {
                return state;
            }
            return {
                symbols: {
                    ...state.symbols,
                    [symbol]: { ...(existing ?? {}), ...data },
                },
                lastQuoteAt: Date.now(),
            };
        }),

    /**
     * Set the active symbol in the terminal.
     * @param {string} symbol
     */
    setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),

    /**
     * Replace the entire ordered watchlist.
     * @param {string[]} symbols
     */
    setWatchlist: (symbols) => set({ watchlist: symbols }),

    /**
     * Add a symbol to the watchlist (no-op if already present).
     * @param {string} symbol
     */
    addToWatchlist: (symbol) =>
        set((state) => ({
            watchlist: state.watchlist.includes(symbol)
                ? state.watchlist
                : [...state.watchlist, symbol],
        })),

    /**
     * Remove a symbol from the watchlist.
     * @param {string} symbol
     */
    removeFromWatchlist: (symbol) =>
        set((state) => ({
            watchlist: state.watchlist.filter((s) => s !== symbol),
        })),

    /**
     * Set WebSocket connection status (called by useWebSocket hook).
     * @param {'connecting'|'connected'|'disconnected'|'error'} status
     */
    setWsStatus: (status) => set({ wsStatus: status }),

    /**
     * Batch update multiple quotes at once (from HTTP polling).
     * Only triggers a re-render if at least one price actually changed.
     * @param {Record<string, object>} quotesMap
     */
    batchUpdateQuotes: (quotesMap) =>
        set((state) => {
            if (!quotesMap || Object.keys(quotesMap).length === 0) return state;
            // Check if any quote actually changed before spreading
            let hasChanges = false;
            for (const [sym, data] of Object.entries(quotesMap)) {
                const existing = state.symbols[sym];
                if (!existing || existing.price !== data.price || existing.change !== data.change) {
                    hasChanges = true;
                    break;
                }
            }
            if (!hasChanges) return state;
            return {
                symbols: { ...state.symbols, ...quotesMap },
                lastQuoteAt: Date.now(),
            };
        }),
}));
