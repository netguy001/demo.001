import { create } from 'zustand';
import api from '../services/api';
import axios from 'axios';

/**
 * Market‑indices store — centralises NIFTY/SENSEX/BANKNIFTY polling
 * + full ticker data (indices + popular stocks) for the scrolling bar.
 */
export const useMarketIndicesStore = create((set, get) => ({
    /** @type {Array<object>} Index data (legacy — indices only) */
    indices: [],

    /** @type {Array<object>} Full ticker items (indices + stocks) */
    tickerItems: [],

    /** @type {boolean} */
    isLoading: false,

    /** @type {number|null} Polling interval ID */
    _intervalId: null,

    /** @type {number} Consecutive auth ticker failures */
    _tickerFailures: 0,

    /** @type {number} Epoch ms until which auth ticker is cooled down */
    _preferPublicUntil: 0,

    // ─── Actions ──────────────────────────────────────────────────────────────

    /** Fetch market indices once (legacy). */
    fetchIndices: async () => {
        set({ isLoading: true });
        try {
            const res = await api.get('/market/indices');
            set({ indices: res.data.indices || [] });
        } catch { /* ignore */ } finally {
            set({ isLoading: false });
        }
    },

    /** Fetch full ticker data (indices + stocks) — requires auth. */
    fetchTicker: async () => {
        const now = Date.now();
        const { _preferPublicUntil } = get();

        // If backend ticker is failing repeatedly, temporarily use public endpoint.
        if (now < _preferPublicUntil) {
            await get().fetchPublicTicker();
            return;
        }

        try {
            const res = await api.get('/market/ticker');
            const items = res.data.items || [];
            const indices = items.filter((i) => i.kind === 'index');
            // Only update if data actually changed to prevent marquee flicker
            // Ignore empty responses — preserve stale data so ticker doesn't disappear
            if (items.length === 0) {
                set({ _tickerFailures: 0, _preferPublicUntil: 0 });
            } else {
                set((s) => {
                    if (s.tickerItems.length === items.length &&
                        items.every((item, i) =>
                            s.tickerItems[i]?.symbol === item.symbol &&
                            s.tickerItems[i]?.price === item.price &&
                            s.tickerItems[i]?.change_percent === item.change_percent
                        )) {
                        // Only reset failure counters, don't touch tickerItems
                        return { _tickerFailures: 0, _preferPublicUntil: 0 };
                    }
                    return { tickerItems: items, indices, _tickerFailures: 0, _preferPublicUntil: 0 };
                });
            }
        } catch (err) {
            const status = err?.response?.status;
            const failures = get()._tickerFailures + 1;

            // For server/network failures, degrade gracefully to public ticker
            // and apply cooldown before retrying protected ticker endpoint.
            if (!status || status >= 500) {
                await get().fetchPublicTicker();
                const cooldownMs = Math.min(5 * 60_000, failures * 30_000);
                set({
                    _tickerFailures: failures,
                    _preferPublicUntil: Date.now() + cooldownMs,
                });
                return;
            }

            set({ _tickerFailures: failures });
        }
    },

    /** Fetch public ticker from yfinance — no auth required. */
    fetchPublicTicker: async () => {
        try {
            const res = await axios.get('/api/market/ticker/public');
            const items = res.data.items || [];
            if (items.length === 0) return; // preserve stale data
            const indices = items.filter((i) => i.kind === 'index');
            // Only update if data actually changed
            set((s) => {
                if (s.tickerItems.length === items.length &&
                    items.every((item, i) =>
                        s.tickerItems[i]?.symbol === item.symbol &&
                        s.tickerItems[i]?.price === item.price &&
                        s.tickerItems[i]?.change_percent === item.change_percent
                    )) {
                    return s; // No change
                }
                return { tickerItems: items, indices };
            });
        } catch { /* ignore — fallback data will show */ }
    },

    /** Start periodic polling (default 60s). */
    startPolling: (intervalMs = 60_000) => {
        const { _intervalId, fetchTicker, fetchIndices } = get();
        if (_intervalId) return; // already polling
        set({ isLoading: true });
        // Fetch ticker and indices in parallel — indices serve as fallback if ticker is empty
        Promise.all([
            fetchTicker(),
            fetchIndices(),
        ]).finally(() => set({ isLoading: false }));
        const id = setInterval(fetchTicker, intervalMs);
        set({ _intervalId: id });
    },

    /** Start public polling for landing pages (default 30s). */
    startPublicPolling: (intervalMs = 30_000) => {
        const { _intervalId, fetchPublicTicker } = get();
        if (_intervalId) return;
        set({ isLoading: true });
        fetchPublicTicker().finally(() => set({ isLoading: false }));
        const id = setInterval(fetchPublicTicker, intervalMs);
        set({ _intervalId: id });
    },

    /** Stop polling. */
    stopPolling: () => {
        const { _intervalId } = get();
        if (_intervalId) {
            clearInterval(_intervalId);
            set({ _intervalId: null });
        }
    },
}));
