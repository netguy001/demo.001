import { useState, useCallback, useMemo, useEffect } from 'react';
import api from '../services/api';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { validateOrderForm } from '../utils/validators';
import { ORDER_SIDE, ORDER_TYPE, TRADING_MODE, TRADING_MODE_PRODUCT, isMcxSymbol } from '../utils/constants';
import toast from 'react-hot-toast';

/**
 * Normalize symbol for comparison.
 * NSE stocks get .NS suffix; MCX commodities are left as-is (uppercase).
 */
function _norm(s) {
    if (!s || typeof s !== 'string') return '';
    if (s.startsWith('^') || s.endsWith('.NS') || s.endsWith('.BO')) return s;
    if (isMcxSymbol(s)) return s.toUpperCase();
    return `${s}.NS`;
}

/**
 * Encapsulates order form state and submission logic,
 * wiring into the existing /orders API endpoint.
 *
 * Trading modes (like real brokers — Zerodha, Groww, Angel One, Upstox):
 *   DELIVERY (CNC) → Sell only what you own. No short selling. No leverage.
 *   INTRADAY (MIS) → Short sell allowed. Auto square-off by 3:15 PM. 5× margin.
 *
 * @param {string} symbol - Pre-selected symbol
 * @returns {{
 *   form: object,
 *   setForm: Function,
 *   setSide: (side: 'BUY'|'SELL') => void,
 *   setTradingMode: (mode: 'DELIVERY'|'INTRADAY') => void,
 *   totalCost: number,
 *   isSubmitting: boolean,
 *   submitOrder: () => Promise<void>,
 *   resetForm: () => void,
 *   holdingQty: number,
 *   canSell: boolean,
 *   maxSellQty: number,
 *   isDelivery: boolean,
 *   isIntraday: boolean,
 *   marginRequired: number,
 *   marketOpen: boolean,
 * }}
 */
export function useOrders(symbol, currentPrice = 0) {
    const refreshPortfolio = usePortfolioStore((s) => s.refreshPortfolio);
    const holdings = usePortfolioStore((s) => s.holdings);

    const [form, setForm] = useState({
        side: ORDER_SIDE.BUY,
        order_type: ORDER_TYPE.MARKET,
        trading_mode: TRADING_MODE.INTRADAY,
        product_type: TRADING_MODE_PRODUCT[TRADING_MODE.INTRADAY], // MIS
        quantity: 1,
        price: '',
        triggerPrice: '',
    });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [marketOpen, setMarketOpen] = useState(true);
    const [marketStateLabel, setMarketStateLabel] = useState('');

    // Check market session on mount and every 60s
    useEffect(() => {
        let mounted = true;
        const check = async () => {
            try {
                const res = await api.get('/market/session');
                if (!mounted) return;
                const s = res.data;
                setMarketOpen(!!s.can_place_orders);
                if (!s.can_place_orders) {
                    setMarketStateLabel(
                        s.state === 'weekend' ? 'Weekend'
                        : s.state === 'holiday' ? 'Holiday'
                        : s.state === 'after_market' ? 'After Market Hours'
                        : 'Market Closed'
                    );
                }
            } catch { /* ignore */ }
        };
        check();
        const id = setInterval(check, 60_000);
        return () => { mounted = false; clearInterval(id); };
    }, []);

    // Check how many shares the user holds for the selected symbol.
    // Only positive (long) positions count as sellable holdings.
    // Negative qty = short position (not sellable in delivery mode).
    const holdingQty = useMemo(() => {
        const sym = _norm(symbol);
        const h = (holdings || []).find((h) => _norm(h.symbol) === sym);
        const qty = h ? Number(h.quantity ?? 0) : 0;
        return Math.max(0, qty); // Short positions (negative) → 0 holdings
    }, [holdings, symbol]);

    // Derived state
    const isDelivery = form.trading_mode === TRADING_MODE.DELIVERY;
    const isIntraday = form.trading_mode === TRADING_MODE.INTRADAY;
    const isBuy = form.side === ORDER_SIDE.BUY;

    // ── Sell rules (mirrors real broker behavior) ──────────────────────
    // DELIVERY (CNC): Can ONLY sell shares you already own. Max qty = holdingQty.
    // INTRADAY (MIS): Short selling allowed. Needs margin (capital / 5).
    const canSell = isDelivery ? holdingQty > 0 : true;
    const maxSellQty = isDelivery ? holdingQty : Infinity;

    // Margin required for intraday short sell (5× leverage like real brokers)
    const effectivePrice = (form.order_type === 'LIMIT' || form.order_type === 'SL-M') && form.price
        ? parseFloat(form.price)
        : currentPrice;
    const totalCost = (effectivePrice || 0) * (parseInt(form.quantity, 10) || 0);
    const marginRequired = isIntraday ? totalCost / 5 : totalCost;

    const setSide = useCallback((side) => {
        setForm((f) => ({ ...f, side }));
    }, []);

    /**
     * Switch trading mode — auto-sets the matching product type (like real brokers).
     * DELIVERY → CNC, INTRADAY → MIS
     */
    const setTradingMode = useCallback((mode) => {
        setForm((f) => {
            const product_type = TRADING_MODE_PRODUCT[mode] || 'CNC';
            const newForm = { ...f, trading_mode: mode, product_type };

            // If switching to DELIVERY + SELL, cap quantity to holdings
            if (mode === TRADING_MODE.DELIVERY && f.side === ORDER_SIDE.SELL) {
                const sym = _norm(symbol);
                const h = (usePortfolioStore.getState().holdings || []).find((h) => _norm(h.symbol) === sym);
                const held = h ? Number(h.quantity ?? 0) : 0;
                if (held > 0 && (parseInt(f.quantity, 10) || 0) > held) {
                    newForm.quantity = held;
                }
            }
            return newForm;
        });
    }, [symbol]);

    const resetForm = useCallback(() => {
        setForm({
            side: ORDER_SIDE.BUY,
            order_type: ORDER_TYPE.MARKET,
            trading_mode: TRADING_MODE.INTRADAY,
            product_type: TRADING_MODE_PRODUCT[TRADING_MODE.INTRADAY],
            quantity: 1,
            price: '',
            triggerPrice: '',
        });
    }, []);

    const submitOrder = useCallback(async () => {
        const { valid, error } = validateOrderForm(form);
        if (!valid) { toast.error(error); return; }

        const qty = parseInt(form.quantity, 10);

        // ── Delivery sell validation (real broker rules) ───────────────
        // CNC: must hold shares, cannot sell more than you own
        if (form.side === ORDER_SIDE.SELL && form.trading_mode === TRADING_MODE.DELIVERY) {
            const sym = _norm(symbol);
            const h = (usePortfolioStore.getState().holdings || []).find((h) => _norm(h.symbol) === sym);
            const held = h ? Number(h.quantity ?? 0) : 0;
            if (held <= 0) {
                toast.error(
                    `You don't hold any ${symbol?.replace('.NS', '')} shares. ` +
                    `In Delivery mode, you can only sell stocks you own. ` +
                    `Switch to Intraday for short selling.`
                );
                return;
            }
            if (qty > held) {
                toast.error(
                    `You only hold ${held} shares of ${symbol?.replace('.NS', '')}. ` +
                    `Cannot sell ${qty} in Delivery mode.`
                );
                return;
            }
        }

        // ── Intraday short sell validation ─────────────────────────────
        // MIS: no holdings needed, but needs sufficient margin (capital / 5)
        if (form.side === ORDER_SIDE.SELL && form.trading_mode === TRADING_MODE.INTRADAY) {
            // Backend will verify margin, but show user-friendly warning
            const sym = _norm(symbol);
            const h = (usePortfolioStore.getState().holdings || []).find((h) => _norm(h.symbol) === sym);
            const held = h ? Number(h.quantity ?? 0) : 0;
            if (held <= 0) {
                // This is a short sell — just let user know (not an error)
                // Backend enforces margin check
            }
        }

        setIsSubmitting(true);
        try {
            // Check market session before placing order
            try {
                const sessionRes = await api.get('/market/session');
                const session = sessionRes.data;
                if (!session.can_place_orders) {
                    const stateLabel = session.state === 'weekend' ? 'Weekend'
                        : session.state === 'holiday' ? 'Holiday'
                        : session.state === 'closed' ? 'Market Closed'
                        : session.state === 'after_market' ? 'After Market Hours'
                        : 'Market Closed';
                    toast.error(`Cannot place orders — ${stateLabel}. Trading is available Mon–Fri 9:15 AM – 3:30 PM IST.`);
                    setMarketOpen(false);
                    return;
                }
                setMarketOpen(true);
            } catch {
                // If session endpoint fails, let the backend handle rejection
            }

            const payload = {
                symbol,
                side: form.side,
                order_type: form.order_type,
                product_type: form.product_type,
                quantity: qty,
                price: (form.order_type === 'LIMIT' || form.order_type === 'SL-M') && form.price
                    ? parseFloat(form.price)
                    : null,
                trigger_price: (form.order_type === 'SL' || form.order_type === 'SL-M') && form.triggerPrice
                    ? parseFloat(form.triggerPrice)
                    : null,
                client_price: currentPrice > 0 ? currentPrice : null,
            };
            await api.post('/orders', payload);

            // Show appropriate success message
            const cleanSymbol = symbol?.replace('.NS', '') || symbol;
            if (form.side === ORDER_SIDE.SELL && form.trading_mode === TRADING_MODE.INTRADAY && holdingQty <= 0) {
                toast.success(`Short sell order placed for ${cleanSymbol} (Intraday). Square off by 3:15 PM.`);
            } else {
                toast.success(`${form.side} order placed for ${cleanSymbol} (${form.trading_mode === TRADING_MODE.DELIVERY ? 'Delivery' : 'Intraday'})`);
            }
            await refreshPortfolio();
        } catch (err) {
            toast.error(err.response?.data?.detail || 'Order failed. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    }, [form, symbol, currentPrice, refreshPortfolio, holdingQty]);

    return {
        form,
        setForm,
        setSide,
        setTradingMode,
        totalCost,
        isSubmitting,
        submitOrder,
        resetForm,
        holdingQty,
        canSell,
        maxSellQty,
        isDelivery,
        isIntraday,
        marginRequired,
        marketOpen,
        marketStateLabel,
    };
}
