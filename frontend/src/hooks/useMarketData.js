import { useState, useEffect, useCallback, useRef } from 'react';
import api, { isRateLimited } from '../services/api';
import { useMarketStore } from '../store/useMarketStore';

// Module-level candle cache shared across hook instances.
// Key: `${symbol}:${period}:${interval}` → { candles: [], ts: number }
// Survives symbol switches so switching back to a recent symbol is instant.
const _candleCache = new Map();
const CANDLE_CACHE_TTL = 60_000; // 60 s — matches backend SmartCache TTL
const PREFETCH_PERIODS = [
    { period: '1d', interval: '1m' },
    { period: '1d', interval: '5m' },
    { period: '5d', interval: '15m' },
    { period: '1mo', interval: '1h' },
    { period: '1y', interval: '1d' },
];

function getLatestCachedCandlesForSymbol(symbol) {
    let latest = null;
    for (const [key, value] of _candleCache.entries()) {
        if (!key.startsWith(`${symbol}:`)) continue;
        if (!latest || (value?.ts ?? 0) > (latest?.ts ?? 0)) {
            latest = value;
        }
    }
    return latest?.candles || null;
}

/**
 * Fetch and manage market data for a given symbol.
 * Polls for quote updates at a configurable interval.
 *
 * @param {string} symbol - e.g. 'RELIANCE.NS'
 * @param {{ pollInterval?: number }} [options]
 * @returns {{
 *   quote: object|null,
 *   candles: Array,
 *   isLoading: boolean,
 *   hasError: boolean,
 *   refetch: () => void,
 * }}
 */
export function useMarketData(symbol, { pollInterval = 10_000 } = {}) {
    const [candles, setCandles] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);

    const MAX_CANDLE_RETRIES = 3;

    const normalizeCandles = useCallback((rows) => {
        const seen = new Map();
        const nowSec = Math.floor(Date.now() / 1000);

        for (const c of rows || []) {
            let time = Number(c?.time ?? c?.timestamp);
            if (!Number.isFinite(time)) continue;

            if (time > 1e18) time = Math.floor(time / 1_000_000_000);
            else if (time > 1e15) time = Math.floor(time / 1_000_000);
            else if (time > 1e12) time = Math.floor(time / 1_000);
            else time = Math.floor(time);

            const open = Number(c?.open);
            const high = Number(c?.high);
            const low = Number(c?.low);
            const close = Number(c?.close);
            const volume = Number(c?.volume ?? 0);

            if (![open, high, low, close].every(Number.isFinite)) continue;
            if (time < 946684800 || time > nowSec + 7 * 24 * 60 * 60) continue;
            if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;

            const candleHigh = Math.max(high, open, low, close);
            const candleLow = Math.min(low, open, high, close);

            seen.set(time, {
                time,
                open: Number(open.toFixed(2)),
                high: Number(candleHigh.toFixed(2)),
                low: Number(candleLow.toFixed(2)),
                close: Number(close.toFixed(2)),
                volume: Number.isFinite(volume) ? Math.max(0, Math.floor(volume)) : 0,
            });
        }

        return [...seen.values()].sort((a, b) => a.time - b.time);
    }, []);

    const updateQuote = useMarketStore((s) => s.updateQuote);
    const quote = useMarketStore((s) => s.symbols[symbol] ?? null);

    // Track current symbol to prevent stale fetch results from overwriting
    const currentSymbolRef = useRef(symbol);
    currentSymbolRef.current = symbol;

    // AbortController ref for cancelling in-flight candle fetches
    const abortRef = useRef(null);

    // Retry timer for transient candle fetch failures (401 race, 429, network blips)
    const candleRetryRef = useRef(null);

    // Track consecutive failures to avoid flashing error on transient network blips
    const failCountRef = useRef(0);
    const fetchQuote = useCallback(async () => {
        if (!symbol || isRateLimited()) return;
        try {
            const res = await api.get(`/market/quote/${encodeURIComponent(symbol)}`);
            // Only update if we got a valid quote with a price
            if (res.data && res.data.price != null && !res.data.error) {
                updateQuote(symbol, res.data, 'poll');
                setHasError(false);
                failCountRef.current = 0;
            }
        } catch {
            // Only show error after 3+ consecutive failures (6+ seconds)
            failCountRef.current += 1;
            if (failCountRef.current >= 3) {
                setHasError(true);
            }
        }
    }, [symbol, updateQuote]);

    const fetchCandles = useCallback(async function fetchCandlesInternal(period = '3mo', interval = '1d', attempt = 0) {
        if (!symbol) return;

        const cacheKey = `${symbol}:${period}:${interval}`;

        // On first attempt, check the module-level cache for an instant render.
        if (attempt === 0) {
            const cached = _candleCache.get(cacheKey);
            const now = Date.now();
            if (cached) {
                const isFresh = now - cached.ts < CANDLE_CACHE_TTL;
                // Always show cached candles immediately to avoid blank chart flash
                if (currentSymbolRef.current === symbol) {
                    setCandles(cached.candles);
                }
                if (isFresh) {
                    // Cache is fresh — no network call needed
                    setIsLoading(false);
                    return;
                }
                // Stale cache: show old data immediately, then refresh silently in background
                setIsLoading(false);
            }
        }

        // If rate-limited, retry after a short delay instead of leaving chart stale forever.
        if (isRateLimited()) {
            if (attempt <= MAX_CANDLE_RETRIES) {
                if (candleRetryRef.current) clearTimeout(candleRetryRef.current);
                candleRetryRef.current = setTimeout(() => {
                    fetchCandlesInternal(period, interval, attempt + 1);
                }, 800 * (attempt + 1));
            } else {
                setIsLoading(false);
            }
            return;
        }

        // Abort any previous in-flight candle fetch
        if (abortRef.current) {
            abortRef.current.abort();
        }
        const controller = new AbortController();
        abortRef.current = controller;

        const fetchSymbol = symbol;
        // Only show spinner if we have no cached data to display for this symbol
        if (attempt === 0 && !_candleCache.has(cacheKey)) {
            setIsLoading(true);
        } else {
            // Cache exists (possibly stale) — keep isLoading=false so chart stays visible
            setIsLoading(false);
        }

        let queuedRetry = false;
        try {
            const res = await api.get(
                `/market/history/${encodeURIComponent(symbol)}?period=${period}&interval=${interval}`,
                { signal: controller.signal }
            );
            // Only set data if this symbol is still the current one
            if (currentSymbolRef.current === fetchSymbol) {
                if (candleRetryRef.current) {
                    clearTimeout(candleRetryRef.current);
                    candleRetryRef.current = null;
                }
                const normalized = normalizeCandles(res.data?.candles || []);
                // Update module-level cache for future symbol switches
                _candleCache.set(cacheKey, { candles: normalized, ts: Date.now() });
                setCandles(normalized);
            }
        } catch (err) {
            // Don't update state if aborted (symbol changed)
            if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return;

            // Retry transient failures so charts recover after auth/token/bootstrap races.
            if (currentSymbolRef.current === fetchSymbol && attempt < MAX_CANDLE_RETRIES) {
                queuedRetry = true;
                if (candleRetryRef.current) clearTimeout(candleRetryRef.current);
                candleRetryRef.current = setTimeout(() => {
                    fetchCandlesInternal(period, interval, attempt + 1);
                }, 600 * (attempt + 1));
                return;
            }

            // After retries are exhausted, clear candles so chart shows empty state
            // instead of stale data from a previously loaded symbol.
            if (currentSymbolRef.current === fetchSymbol) {
                setHasError(true);
                setCandles([]);
            }
        } finally {
            if (currentSymbolRef.current === fetchSymbol && !queuedRetry) {
                setIsLoading(false);
            }
        }
    }, [symbol, normalizeCandles]);

    // Warm common timeframe caches in background so period changes feel instant.
    useEffect(() => {
        if (!symbol) return;

        let cancelled = false;
        const timer = setTimeout(async () => {
            for (const cfg of PREFETCH_PERIODS) {
                if (cancelled || isRateLimited()) break;
                const cacheKey = `${symbol}:${cfg.period}:${cfg.interval}`;
                const existing = _candleCache.get(cacheKey);
                if (existing && Date.now() - existing.ts < CANDLE_CACHE_TTL) {
                    continue;
                }

                try {
                    const res = await api.get(
                        `/market/history/${encodeURIComponent(symbol)}?period=${cfg.period}&interval=${cfg.interval}`
                    );
                    if (cancelled) break;
                    const normalized = normalizeCandles(res.data?.candles || []);
                    _candleCache.set(cacheKey, { candles: normalized, ts: Date.now() });
                } catch {
                    // Keep prefetch failures silent so normal chart flow stays unaffected.
                }
            }
        }, 250);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [symbol, normalizeCandles]);

    // On symbol change — clear stale candles immediately and fetch fresh quote.
    // The chart already shows a skeleton while isLoading=true, so clearing is safe.
    // fetchCandles (called by the parent) will restore from cache instantly if available.
    useEffect(() => {
        if (!symbol) return;
        const cachedForSymbol = getLatestCachedCandlesForSymbol(symbol);
        if (cachedForSymbol && cachedForSymbol.length > 0) {
            setCandles(cachedForSymbol);
            setIsLoading(false);
        } else {
            setCandles([]);
            setIsLoading(true);
        }
        setHasError(false);
        fetchQuote();

        // Abort any in-flight candle fetch for the previous symbol
        return () => {
            if (abortRef.current) {
                abortRef.current.abort();
            }
            if (candleRetryRef.current) {
                clearTimeout(candleRetryRef.current);
                candleRetryRef.current = null;
            }
        };
    }, [symbol, fetchQuote]);

    // Polling
    const intervalRef = useRef(null);
    useEffect(() => {
        if (!symbol || pollInterval <= 0) return;
        intervalRef.current = setInterval(fetchQuote, pollInterval);
        return () => clearInterval(intervalRef.current);
    }, [symbol, pollInterval, fetchQuote]);

    return {
        quote,
        candles,
        isLoading,
        hasError,
        refetch: fetchQuote,
        fetchCandles,
    };
}
