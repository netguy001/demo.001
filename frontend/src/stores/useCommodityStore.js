import { create } from 'zustand';
import api from '../services/api';

const MAX_TICK_HISTORY = 30;

/**
 * Commodity store — manages MCX/NCDEX commodity data.
 *
 * Initial load comes from REST API.  Live updates come from the existing
 * WebSocket pipeline (MarketDataWorker → EventBus → WS manager → useWebSocket hook).
 * The CommoditiesPage calls `applyTick(symbol, quote)` whenever it receives
 * a WebSocket quote whose symbol is a known commodity.
 */
const useCommodityStore = create((set, get) => ({
    /** symbol → full quote (latest) */
    quotes: {},

    /** symbol → last N prices for sparkline */
    tickHistory: {},

    /** symbol → previous price for flash animation */
    prevPrices: {},

    /** Static commodity metadata from backend */
    commodityMeta: {},

    isLoading: false,
    lastFetchAt: null,
    source: null, // 'live' | 'simulated'

    /**
     * Initial load — fetches from REST /market/commodities.
     * Called once on page mount. After that, WebSocket ticks take over.
     */
    fetchCommodities: async () => {
        set({ isLoading: true });
        try {
            const { data } = await api.get('/market/commodities');
            const items = data.commodities || [];
            const quotes = {};
            const meta = {};
            const history = { ...get().tickHistory };

            for (const c of items) {
                const sym = c.symbol;
                quotes[sym] = c;
                meta[sym] = {
                    name: c.name,
                    exchange: c.exchange,
                    category: c.category,
                    unit: c.unit,
                    lot: c.lot || 1,
                };
                // Seed tick history if empty
                if (!history[sym]) {
                    history[sym] = c.price > 0 ? [c.price] : [];
                }
            }

            const src = items[0]?.source || null;
            set({
                quotes,
                commodityMeta: meta,
                tickHistory: history,
                isLoading: false,
                lastFetchAt: Date.now(),
                source: src,
            });
        } catch (err) {
            console.error('Failed to fetch commodities:', err);
            set({ isLoading: false });
        }
    },

    /**
     * Apply a live tick from WebSocket.
     * Called by CommoditiesPage when it detects a WS quote for a commodity symbol.
     */
    applyTick: (symbol, quote) => {
        if (!symbol || !quote) return;
        const price = Number(quote.price ?? quote.lp ?? quote.ltp ?? 0);
        if (!price || price <= 0) return;

        set((state) => {
            const prev = state.quotes[symbol] || {};
            const meta = state.commodityMeta[symbol] || {};

            // Merge: keep metadata, overwrite with live data
            const merged = {
                ...prev,
                ...quote,
                ...meta,
                symbol,
                price,
                kind: 'commodity',
                source: 'live',
            };

            // Track previous price for flash
            const prevPrices = { ...state.prevPrices };
            if (prev.price && prev.price !== price) {
                prevPrices[symbol] = prev.price;
            }

            // Append to tick history (ring buffer)
            const history = { ...state.tickHistory };
            const arr = [...(history[symbol] || []), price];
            if (arr.length > MAX_TICK_HISTORY) arr.shift();
            history[symbol] = arr;

            return {
                quotes: { ...state.quotes, [symbol]: merged },
                tickHistory: history,
                prevPrices,
                source: 'live',
                lastFetchAt: Date.now(),
            };
        });
    },

    /** Get flash direction for a symbol: 'up', 'down', or null */
    getFlash: (symbol) => {
        const state = get();
        const prev = state.prevPrices[symbol];
        const curr = state.quotes[symbol]?.price;
        if (prev == null || curr == null) return null;
        if (curr > prev) return 'up';
        if (curr < prev) return 'down';
        return null;
    },
}));

export { useCommodityStore };
