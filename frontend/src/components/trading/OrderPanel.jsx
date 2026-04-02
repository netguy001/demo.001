import { useState, useEffect, useRef } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useOrders } from '../../hooks/useOrders';
import { cn } from '../../utils/cn';
import { formatCurrency, formatPrice, cleanSymbol } from '../../utils/formatters';
import { ORDER_SIDE, ORDER_TYPE, TRADING_MODE, TRADING_MODE_INFO } from '../../utils/constants';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

const ORDER_TYPES = [ORDER_TYPE.MARKET, ORDER_TYPE.LIMIT, 'SL', 'SL-M'];

/**
 * Order panel — buy/sell form with confirmation modal.
 *
 * Trading mode selection (like Zerodha / Groww / Angel One / Upstox):
 *   DELIVERY (CNC) → Sell only what you own. No short selling. Full payment.
 *   INTRADAY (MIS) → Short sell allowed. Auto square-off by 3:15 PM. 5× leverage.
 *
 * Keyboard shortcuts:
 *   B → switch to Buy tab
 *   S → switch to Sell tab
 *   Enter (while panel focused) → open confirm dialog
 *
 * @param {{
 *   symbol: string,
 *   currentPrice?: number,
 *   isTerminalFocused?: boolean,
 *   initialSide?: string,
 * }} props
 */
export default function OrderPanel({ symbol, currentPrice = 0, isTerminalFocused = false, initialSide, initialSideKey, isFloating = false }) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const {
        form, setForm, setSide, setTradingMode,
        totalCost, isSubmitting, submitOrder,
        holdingQty, canSell, maxSellQty,
        isDelivery, isIntraday, marginRequired,
        marketOpen, marketStateLabel,
    } = useOrders(symbol, currentPrice);

    // Sync initialSide prop (e.g. from positions SELL/EXIT button).
    // useEffect handles both fresh mount (mobile drawer) and updates (desktop).
    const mountedRef = useRef(false);
    useEffect(() => {
        setTradingMode(TRADING_MODE.INTRADAY);
        if (initialSide) {
            setSide(initialSide);
        }
        mountedRef.current = true;
    }, [initialSide, initialSideKey, setSide, setTradingMode]);

    // Keyboard shortcuts (active when terminal is focused and user isn't in an input)
    useKeyboardShortcuts({
        'b': () => setSide(ORDER_SIDE.BUY),
        's': () => setSide(ORDER_SIDE.SELL),
    }, isTerminalFocused);

    const isBuy = form.side === ORDER_SIDE.BUY;
    const isLimit = form.order_type === ORDER_TYPE.LIMIT;
    const isSL = form.order_type === 'SL' || form.order_type === 'SL-M';

    // Block sell only for DELIVERY mode without holdings (real broker behavior)
    const sellBlocked = !isBuy && isDelivery && !canSell;

    // Quantity exceeds holdings for delivery sell
    const qtyExceedsHoldings = !isBuy && isDelivery && canSell
        && (parseInt(form.quantity, 10) || 0) > holdingQty;

    const handleConfirm = async () => {
        if (sellBlocked || qtyExceedsHoldings) {
            setConfirmOpen(false);
            return;
        }
        setConfirmOpen(false);
        await submitOrder();
    };

    const modeInfo = TRADING_MODE_INFO[form.trading_mode];

    return (
        <div className={cn('flex flex-col h-full bg-surface-900', !isFloating && 'border-l border-edge/10')}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-edge/5">
                <h3 className="section-title text-xs mb-3">Order Panel</h3>

                {/* Buy / Sell toggle — separate quick buttons */}
                <div className="flex gap-2">
                    <button
                        onClick={() => setSide(ORDER_SIDE.BUY)}
                        className={cn(
                            'flex-1 py-2 text-sm font-bold rounded-lg border transition-all duration-200',
                            isBuy
                                ? 'bg-bull text-white border-emerald-500/40 shadow-lg shadow-emerald-500/20'
                                : 'bg-surface-800/60 border-edge/10 text-gray-500 hover:text-gray-700 hover:bg-surface-800'
                        )}
                    >
                        BUY
                    </button>
                    <button
                        onClick={() => setSide(ORDER_SIDE.SELL)}
                        className={cn(
                            'flex-1 py-2 text-sm font-bold rounded-lg border transition-all duration-200',
                            !isBuy
                                ? 'bg-bear text-white border-red-500/40 shadow-lg shadow-red-500/20'
                                : 'bg-surface-800/60 border-edge/10 text-gray-500 hover:text-gray-700 hover:bg-surface-800'
                        )}
                    >
                        SELL
                    </button>
                </div>
            </div>

            {/* Form */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {/* Symbol */}
                <div>
                    <label className="metric-label block mb-1">Symbol</label>
                    <div className="bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-semibold text-heading flex items-center justify-between">
                        <span>{cleanSymbol(symbol)}</span>
                        <span className="text-xs text-gray-500 font-price tabular-nums">
                            {currentPrice > 0 ? `₹${formatPrice(currentPrice)}` : ''}
                        </span>
                    </div>
                </div>

                {/* ── Trading Mode (Delivery / Intraday) ─────────────────────
                     This is the primary choice — like Zerodha, Groww, Angel One.
                     Determines product type (CNC/MIS) and sell behavior. */}
                <div>
                    <label className="metric-label block mb-1">Trading Type</label>
                    <div className="flex gap-2">
                        {[TRADING_MODE.INTRADAY, TRADING_MODE.DELIVERY].map((mode) => {
                            const info = TRADING_MODE_INFO[mode];
                            const isActive = form.trading_mode === mode;
                            return (
                                <button
                                    key={mode}
                                    onClick={() => setTradingMode(mode)}
                                    className={cn(
                                        'flex-1 py-2 px-2 rounded-lg border transition-all duration-200 text-center',
                                        isActive
                                            ? mode === TRADING_MODE.INTRADAY
                                                ? 'bg-amber-600/20 text-amber-400 border-amber-500/30 shadow-sm'
                                                : 'bg-blue-600/20 text-blue-400 border-blue-500/30 shadow-sm'
                                            : 'bg-surface-800/60 border-edge/10 text-gray-500 hover:text-gray-400 hover:bg-surface-700/40'
                                    )}
                                >
                                    <div className="text-xs font-bold">{info.label}</div>
                                    <div className="text-[10px] opacity-70 mt-0.5">{info.sublabel}</div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Order type — segmented pill */}
                <div>
                    <label className="metric-label block mb-1">Order Type</label>
                    <div className="grid grid-cols-2 gap-2">
                        {ORDER_TYPES.map((t) => (
                            <button
                                key={t}
                                onClick={() => setForm((f) => ({ ...f, order_type: t }))}
                                className={cn(
                                    'py-2 text-xs font-semibold rounded-md border transition-all duration-150',
                                    form.order_type === t
                                        ? 'bg-primary-600/25 text-primary-600 border-primary-500/30 shadow-sm'
                                        : 'bg-surface-800/60 border-edge/10 text-gray-500 hover:text-gray-700 hover:bg-surface-700/40'
                                )}
                            >
                                {t}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Quantity with stepper */}
                <div>
                    <div className="flex items-center justify-between mb-1">
                        <label className="metric-label">Quantity</label>
                        {/* Show max sellable qty for delivery sell */}
                        {!isBuy && isDelivery && holdingQty > 0 && (
                            <button
                                onClick={() => setForm((f) => ({ ...f, quantity: holdingQty }))}
                                className="text-[10px] text-primary-500 hover:text-primary-400 transition-colors"
                            >
                                Max: {holdingQty}
                            </button>
                        )}
                    </div>
                    <div className="flex items-center border border-edge/10 rounded-lg overflow-hidden bg-surface-800/60">
                        <button
                            type="button"
                            onClick={() => setForm((f) => ({ ...f, quantity: Math.max(1, (parseInt(f.quantity) || 1) - 1) }))}
                            className="px-3 py-2 text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all text-lg font-bold"
                        >
                            −
                        </button>
                        <input
                            type="number"
                            min={1}
                            max={!isBuy && isDelivery && holdingQty > 0 ? holdingQty : undefined}
                            value={form.quantity}
                            onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === '') {
                                    setForm((f) => ({ ...f, quantity: '' }));
                                    return;
                                }
                                const val = parseInt(raw, 10);
                                if (!isNaN(val) && val >= 0) {
                                    setForm((f) => ({ ...f, quantity: val }));
                                }
                            }}
                            onBlur={() => {
                                setForm((f) => ({ ...f, quantity: Math.max(1, parseInt(f.quantity) || 1) }));
                            }}
                            className="min-w-0 flex-1 text-center bg-transparent text-heading text-sm font-price py-2 focus:outline-none tabular-nums"
                        />
                        <button
                            type="button"
                            onClick={() => setForm((f) => ({ ...f, quantity: (parseInt(f.quantity) || 0) + 1 }))}
                            className="px-3 py-2 text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all text-lg font-bold flex-shrink-0"
                        >
                            +
                        </button>
                    </div>
                    {/* Warning if qty exceeds holdings in delivery mode */}
                    {qtyExceedsHoldings && (
                        <p className="text-[10px] text-red-400 mt-1 px-1">
                            You only hold {holdingQty} shares. Reduce quantity to {holdingQty} or less.
                        </p>
                    )}
                </div>

                {/* Price (for LIMIT orders) */}
                {isLimit && (
                    <div>
                        <label className="metric-label block mb-1">Limit Price (₹)</label>
                        <input
                            type="number"
                            step="0.05"
                            value={form.price}
                            onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                            placeholder={formatPrice(currentPrice)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-price text-heading placeholder-gray-600 focus:outline-none focus:border-primary-500/30 tabular-nums"
                        />
                    </div>
                )}

                {/* Trigger price (for SL/SL-M) */}
                {isSL && (
                    <div>
                        <label className="metric-label block mb-1">Trigger Price (₹)</label>
                        <input
                            type="number"
                            step="0.05"
                            value={form.triggerPrice}
                            onChange={(e) => setForm((f) => ({ ...f, triggerPrice: e.target.value }))}
                            placeholder={formatPrice(currentPrice)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-price text-heading placeholder-gray-600 focus:outline-none focus:border-primary-500/30 tabular-nums"
                        />
                    </div>
                )}

                {/* Limit price (for SL-M only — order fills at this price after trigger) */}
                {form.order_type === 'SL-M' && (
                    <div>
                        <label className="metric-label block mb-1">Limit Price (₹)</label>
                        <input
                            type="number"
                            step="0.05"
                            value={form.price}
                            onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                            placeholder={formatPrice(currentPrice)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-price text-heading placeholder-gray-600 focus:outline-none focus:border-primary-500/30 tabular-nums"
                        />
                    </div>
                )}

                {/* Order summary */}
                <div className="rounded-xl bg-surface-800/40 border border-edge/5 p-3 space-y-2">
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Est. Value</span>
                        <span className="font-price text-heading font-semibold tabular-nums">{formatCurrency(totalCost)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Qty × Price</span>
                        <span className="font-price text-gray-400 tabular-nums">
                            {form.quantity || 0} × {isLimit && form.price ? `₹${form.price}` : `₹${formatPrice(currentPrice)}`}
                        </span>
                    </div>
                    {/* Product type indicator */}
                    <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Product</span>
                        <span className={cn(
                            "font-semibold text-xs px-1.5 py-0.5 rounded",
                            isDelivery
                                ? "bg-blue-500/10 text-blue-400"
                                : "bg-amber-500/10 text-amber-400"
                        )}>
                            {form.product_type} ({modeInfo.label})
                        </span>
                    </div>
                    {/* Margin estimate for intraday */}
                    {isIntraday && totalCost > 0 && (
                        <div className="flex justify-between text-xs border-t border-edge/5 pt-2 mt-1">
                            <span className="text-gray-500">Margin Required (5×)</span>
                            <span className="font-price text-amber-400 font-medium tabular-nums">
                                {formatCurrency(marginRequired)}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Submit button — sticky at bottom */}
            <div className="sticky bottom-0 px-4 py-3 border-t border-edge/5 bg-surface-900">
                {/* ── Market Closed banner ─────────────────────────────── */}
                {!marketOpen && (
                    <div className="mb-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 flex items-center gap-2">
                        <span className="text-base">⏸</span>
                        <div>
                            <span className="font-semibold">{marketStateLabel || 'Market Closed'}</span>
                            <span className="text-amber-500/80"> — Orders available Mon–Fri, 9:15 AM – 3:30 PM IST</span>
                        </div>
                    </div>
                )}

                {/* ── Sell context messages ──────────────────────────────── */}

                {/* DELIVERY SELL — no holdings: blocked */}
                {!isBuy && isDelivery && !canSell && (
                    <div className="mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                        <span className="font-semibold">No holdings found.</span> In Delivery (CNC) mode, you can only sell shares you already own.
                        Switch to <button onClick={() => setTradingMode(TRADING_MODE.INTRADAY)} className="underline font-semibold text-amber-400 hover:text-amber-300">Intraday</button> for short selling.
                    </div>
                )}

                {/* DELIVERY SELL — has holdings: show available qty */}
                {!isBuy && isDelivery && canSell && (
                    <div className="mb-2 px-3 py-1.5 rounded-lg bg-surface-800/60 border border-edge/10 text-xs text-gray-400">
                        Available to sell: <span className="font-semibold text-heading">{holdingQty}</span> shares (Delivery)
                    </div>
                )}


                <Button
                    variant={isBuy ? 'buy' : 'sell'}
                    size="lg"
                    className={cn(
                        "w-full py-3.5 text-base",
                        (sellBlocked || qtyExceedsHoldings || !marketOpen) && "!opacity-40 !cursor-not-allowed !shadow-none !bg-gray-600 hover:!bg-gray-600"
                    )}
                    onClick={() => {
                        if (sellBlocked || qtyExceedsHoldings || !marketOpen) return;
                        setConfirmOpen(true);
                    }}
                    isLoading={isSubmitting}
                    disabled={isSubmitting || sellBlocked || qtyExceedsHoldings || !marketOpen}
                >
                    {!marketOpen
                        ? 'Market Closed'
                        : isBuy
                            ? 'Place Buy Order'
                            : (!isBuy && isIntraday && holdingQty <= 0)
                                ? 'Place Short Sell'
                                : 'Place Sell Order'
                    }
                </Button>
                <p className="text-[11px] text-gray-600 text-center mt-2">
                    Press <kbd className="bg-surface-700 px-1 rounded text-[10px]">B</kbd> / <kbd className="bg-surface-700 px-1 rounded text-[10px]">S</kbd> to switch sides
                </p>
            </div>

            {/* Confirmation Modal */}
            <Modal
                isOpen={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                title="Confirm Order"
                size="sm"
            >
                <div className="px-6 py-4 space-y-4">
                    {/* Summary */}
                    <div className="rounded-xl border border-edge/10 bg-surface-900/50 divide-y divide-edge/5 text-sm">
                        {[
                            ['Side', <span className={cn('font-bold', isBuy ? 'text-bull' : 'text-bear')}>{form.side}</span>],
                            ['Symbol', <span className="font-price text-heading">{cleanSymbol(symbol)}</span>],
                            ['Trading Type', <span className={cn(
                                'font-semibold text-xs px-1.5 py-0.5 rounded',
                                isDelivery ? 'bg-blue-500/10 text-blue-400' : 'bg-amber-500/10 text-amber-400'
                            )}>{modeInfo.label} ({form.product_type})</span>],
                            ['Order Type', form.order_type],
                            ['Quantity', <span className="font-price tabular-nums">{form.quantity}</span>],
                            ['Est. Value', <span className="font-price font-semibold text-heading tabular-nums">{formatCurrency(totalCost)}</span>],
                            ...(isIntraday ? [['Margin Required', <span className="font-price text-amber-400 tabular-nums">{formatCurrency(marginRequired)}</span>]] : []),
                        ].map(([label, value]) => (
                            <div key={label} className="flex justify-between px-4 py-2.5">
                                <span className="text-gray-500">{label}</span>
                                <span className="text-gray-600">{value}</span>
                            </div>
                        ))}
                    </div>

                    {/* Block confirm for delivery sell without holdings */}
                    {sellBlocked && (
                        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                            No holdings for {cleanSymbol(symbol)}. Switch to Intraday for short selling.
                        </div>
                    )}
                    {/* Qty exceeds holdings warning */}
                    {qtyExceedsHoldings && (
                        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                            Quantity ({form.quantity}) exceeds your holdings ({holdingQty}). Reduce quantity.
                        </div>
                    )}
                    <div className="flex gap-3">
                        <Button variant="secondary" className="flex-1" onClick={() => setConfirmOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant={isBuy ? 'buy' : 'sell'}
                            className="flex-1"
                            onClick={handleConfirm}
                            isLoading={isSubmitting}
                            disabled={sellBlocked || qtyExceedsHoldings}
                        >
                            Confirm {form.side}
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
