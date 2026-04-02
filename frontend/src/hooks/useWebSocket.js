import { useEffect, useRef, useCallback } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { useWatchlistStore } from '../stores/useWatchlistStore';
import { useZeroLossStore } from '../stores/useZeroLossStore';
import api, { isRateLimited } from '../services/api';
import { WS_MAX_BACKOFF_MS, WS_HEARTBEAT_MS, normalizeSymbol } from '../utils/constants';

const WS_FALLBACK_POLL_MS = 15_000;

/**
 * WebSocket hook for real-time market data.
 *
 * FIX: Uses refs for all callbacks to prevent the connect function from being
 * recreated on every render, which was causing a WebSocket reconnect storm
 * ("WebSocket is closed before the connection is established").
 */
export function useWebSocket() {
    const wsRef = useRef(null);
    const statusRef = useRef('disconnected');
    const backoffRef = useRef(1000);
    const failedAttemptsRef = useRef(0);
    const reconnectTimer = useRef(null);
    const heartbeatTimer = useRef(null);
    const fallbackPollTimer = useRef(null);
    const messageQueue = useRef([]);
    const mountedRef = useRef(true);
    const portfolioRefreshTimer = useRef(null);

    // Store selectors — these are stable Zustand selectors
    const updateQuote = useMarketStore((s) => s.updateQuote);
    const setWsStatus = useMarketStore((s) => s.setWsStatus);
    const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
    const holdings = usePortfolioStore((s) => s.holdings);
    const applyLiveQuote = usePortfolioStore((s) => s.applyLiveQuote);
    const refreshPortfolio = usePortfolioStore((s) => s.refreshPortfolio);
    const watchlists = useWatchlistStore((s) => s.watchlists);
    const activeWatchlistId = useWatchlistStore((s) => s.activeId);
    const updateWatchlistPrices = useWatchlistStore((s) => s.updatePrices);
    const handleZeroLoss = useZeroLossStore((s) => s.handleWsMessage);

    // ── Use refs for ALL callback dependencies to keep `connect` stable ─────
    const callbacksRef = useRef({});
    callbacksRef.current = {
        updateQuote, setWsStatus, applyLiveQuote,
        refreshPortfolio, handleZeroLoss, updateWatchlistPrices,
    };

    const trackedRef = useRef([]);
    // Update tracked symbols whenever dependencies change
    useEffect(() => {
        const activeWatchlist = watchlists.find((w) => w.id === activeWatchlistId);
        const watchlistSymbols = (activeWatchlist?.items || []).map((item) => item.symbol);
        const holdingSymbols = (holdings || []).map((h) => h.symbol);

        const symbols = [
            ...(selectedSymbol ? [selectedSymbol] : []),
            ...watchlistSymbols,
            ...holdingSymbols,
        ]
            .map(normalizeSymbol)
            .filter(Boolean)
            .filter((value, index, arr) => arr.indexOf(value) === index);

        trackedRef.current = symbols;
    }, [selectedSymbol, watchlists, activeWatchlistId, holdings]);

    const applyIncomingQuote = useCallback((symbol, data = {}) => {
        if (!symbol) return;
        const normalizedSymbol = normalizeSymbol(symbol);
        const resolvedPrice = Number(data.price ?? data.lp ?? data.ltp ?? data.last_price);

        const quoteData = { ...data };
        if (Number.isFinite(resolvedPrice) && resolvedPrice > 0) {
            quoteData.price = resolvedPrice;
        }

        const key = normalizedSymbol || symbol;
        callbacksRef.current.updateQuote(key, quoteData);
        callbacksRef.current.applyLiveQuote(key, quoteData);

        if (normalizedSymbol && normalizedSymbol !== symbol) {
            callbacksRef.current.updateQuote(symbol, quoteData);
        }

        // Keep watchlist UI values in sync with live websocket ticks.
        const watchlistQuoteMap = {};
        const upperKey = String(key).toUpperCase();
        const rawSymbol = String(symbol).toUpperCase();
        const base = upperKey.replace(/\.(NS|BO)$/i, '');

        watchlistQuoteMap[upperKey] = quoteData;
        watchlistQuoteMap[base] = quoteData;
        if (rawSymbol) watchlistQuoteMap[rawSymbol] = quoteData;

        callbacksRef.current.updateWatchlistPrices(watchlistQuoteMap);
    }, []); // Stable — uses callbacksRef

    const send = useCallback((payload) => {
        const msg = JSON.stringify(payload);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(msg);
        } else {
            messageQueue.current.push(msg);
        }
    }, []);

    const pollQuotesFallback = useCallback(async () => {
        if (isRateLimited()) return;
        const symbols = trackedRef.current;
        if (symbols.length === 0) return;

        try {
            const res = await api.get(`/market/batch?symbols=${encodeURIComponent(symbols.join(','))}`);
            const quotes = res.data?.quotes || {};
            Object.entries(quotes).forEach(([symbol, quote]) => {
                applyIncomingQuote(symbol, quote || {});
            });
        } catch {
            // Ignore fallback polling errors
        }
    }, [applyIncomingQuote]);

    const stopFallbackPolling = useCallback(() => {
        if (fallbackPollTimer.current) {
            clearInterval(fallbackPollTimer.current);
            fallbackPollTimer.current = null;
        }
    }, []);

    const ensureFallbackPolling = useCallback(() => {
        if (fallbackPollTimer.current) return;
        pollQuotesFallback(); // Immediate first poll
        fallbackPollTimer.current = setInterval(pollQuotesFallback, WS_FALLBACK_POLL_MS);
    }, [pollQuotesFallback]);

    // ── Connect — stable function, no recreations ──────────────────────────
    const connectRef = useRef(null);
    connectRef.current = () => {
        if (!mountedRef.current) return;
        if (wsRef.current?.readyState === WebSocket.OPEN ||
            wsRef.current?.readyState === WebSocket.CONNECTING) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const token = localStorage.getItem('alphasync_token');
        const clientId = `market_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const url = token
            ? `${protocol}//${host}/ws/${clientId}?token=${encodeURIComponent(token)}`
            : `${protocol}//${host}/ws/${clientId}`;

        statusRef.current = 'connecting';
        callbacksRef.current.setWsStatus('connecting');

        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            if (!mountedRef.current) { ws.close(); return; }
            backoffRef.current = 1000;
            failedAttemptsRef.current = 0;
            statusRef.current = 'connected';
            callbacksRef.current.setWsStatus('connected');

            // Start heartbeat
            if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
            heartbeatTimer.current = setInterval(() => {
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'ping' }));
                }
            }, WS_HEARTBEAT_MS);

            stopFallbackPolling();

            // Flush queued messages
            while (messageQueue.current.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(messageQueue.current.shift());
            }

            // Subscribe to tracked symbols
            const symbols = trackedRef.current;
            if (symbols.length > 0) {
                ws.send(JSON.stringify({ type: 'subscribe', symbols: [...new Set(symbols)] }));
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'quote' && data.symbol) {
                    const { type, channel, ...quoteData } = data;
                    applyIncomingQuote(data.symbol, quoteData);
                }
                if (data.type === 'price_update' && data.data?.symbol) {
                    const { type: _t, channel: _c, ...legacyData } = data.data;
                    applyIncomingQuote(data.data.symbol, legacyData);
                }
                if (data.channel === 'zeroloss') {
                    callbacksRef.current.handleZeroLoss(data);
                }
                if (data.channel === 'orders' || data.channel === 'portfolio' || data.type === 'portfolio_update') {
                    if (portfolioRefreshTimer.current) clearTimeout(portfolioRefreshTimer.current);
                    portfolioRefreshTimer.current = setTimeout(() => callbacksRef.current.refreshPortfolio(), 500);
                }
            } catch { /* malformed JSON */ }
        };

        ws.onerror = () => {
            statusRef.current = 'error';
            callbacksRef.current.setWsStatus('error');
        };

        ws.onclose = () => {
            if (!mountedRef.current) return;
            statusRef.current = 'disconnected';
            callbacksRef.current.setWsStatus('disconnected');
            if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
            ensureFallbackPolling();

            failedAttemptsRef.current += 1;

            // Exponential backoff reconnect
            const delay = Math.min(backoffRef.current, WS_MAX_BACKOFF_MS);
            backoffRef.current = Math.min(backoffRef.current * 2, WS_MAX_BACKOFF_MS);
            reconnectTimer.current = setTimeout(() => connectRef.current?.(), delay);
        };
    };

    // ── Mount: connect once, clean up on unmount ────────────────────────────
    useEffect(() => {
        mountedRef.current = true;
        connectRef.current?.();
        return () => {
            mountedRef.current = false;
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
            if (portfolioRefreshTimer.current) clearTimeout(portfolioRefreshTimer.current);
            stopFallbackPolling();
            wsRef.current?.close();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally stable

    // ── Re-subscribe when tracked symbols change ────────────────────────────
    useEffect(() => {
        const symbols = trackedRef.current;
        if (symbols.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            send({ type: 'subscribe', symbols: [...new Set(symbols)] });
        }
    }, [selectedSymbol, watchlists, activeWatchlistId, holdings, send]);

    const subscribe = useCallback((symbols) => send({ type: 'subscribe', symbols }), [send]);
    const unsubscribe = useCallback((symbols) => send({ type: 'unsubscribe', symbols }), [send]);

    const status = useMarketStore((s) => s.wsStatus);
    return { status, subscribe, unsubscribe };
}
