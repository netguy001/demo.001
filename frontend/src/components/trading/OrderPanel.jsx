import { useState, useEffect, useRef } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useOrders } from '../../hooks/useOrders';
import { cn } from '../../utils/cn';
import { formatCurrency, formatPrice, cleanSymbol } from '../../utils/formatters';
import { ORDER_SIDE, ORDER_TYPE, TRADING_MODE, TRADING_MODE_INFO } from '../../utils/constants';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

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
        holdingQty, canSell,
        isDelivery, isIntraday, marginRequired,
        marketOpen,
    } = useOrders(symbol, currentPrice);

    const mountedRef = useRef(false);
    useEffect(() => {
        setTradingMode(TRADING_MODE.INTRADAY);
        if (initialSide) {
            setSide(initialSide);
        }
        mountedRef.current = true;
    }, [initialSide, initialSideKey, setSide, setTradingMode]);

    useKeyboardShortcuts({
        'b': () => setSide(ORDER_SIDE.BUY),
        's': () => setSide(ORDER_SIDE.SELL),
    }, isTerminalFocused);

    const isBuy = form.side === ORDER_SIDE.BUY;
    const showCompactPriceField = form.order_type === ORDER_TYPE.LIMIT || form.order_type === 'SL';
    const selectedTradingProduct = ['MIS', 'CNC', 'NRML'].includes(form.product_type)
        ? form.product_type
        : (isDelivery ? 'CNC' : 'MIS');

    const sellBlocked = !isBuy && isDelivery && !canSell;
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

    const handleTradingTypeChange = (nextProductType) => {
        setForm((f) => {
            const nextTradingMode = nextProductType === 'CNC' ? TRADING_MODE.DELIVERY : TRADING_MODE.INTRADAY;
            const nextQty = (!isBuy && nextTradingMode === TRADING_MODE.DELIVERY && holdingQty > 0)
                ? Math.min(parseInt(f.quantity, 10) || 1, holdingQty)
                : f.quantity;

            return {
                ...f,
                product_type: nextProductType,
                trading_mode: nextTradingMode,
                quantity: nextQty,
            };
        });
    };

    const handleOrderTypeChange = (nextOrderType) => {
        setForm((f) => ({
            ...f,
            order_type: nextOrderType,
            triggerPrice: nextOrderType === 'SL-M' && !f.triggerPrice
                ? (currentPrice > 0 ? String(currentPrice) : '')
                : f.triggerPrice,
        }));
    };

    return (
        <div className={cn('flex flex-col w-full max-w-[300px] bg-surface-900', isFloating ? 'h-auto' : 'h-full', !isFloating && 'border-l border-edge/10')}>
            <div className="px-3 py-2.5 border-b border-edge/5">
                <div className="flex gap-1.5">
                    <button
                        onClick={() => setSide(ORDER_SIDE.BUY)}
                        className={cn(
                            'flex-1 py-1.5 text-sm font-bold rounded-lg border transition-all duration-200',
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
                            'flex-1 py-1.5 text-sm font-bold rounded-lg border transition-all duration-200',
                            !isBuy
                                ? 'bg-bear text-white border-red-500/40 shadow-lg shadow-red-500/20'
                                : 'bg-surface-800/60 border-edge/10 text-gray-500 hover:text-gray-700 hover:bg-surface-800'
                        )}
                    >
                        SELL
                    </button>
                </div>
            </div>

            <div className={cn('px-3 py-2.5 space-y-3', !isFloating && 'flex-1 overflow-y-auto')}>
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="metric-label block mb-1">Symbol</label>
                        <div className="h-11 bg-surface-800/60 border border-edge/10 rounded-lg px-2.5 text-sm font-semibold text-heading flex items-center justify-between">
                            <span>{cleanSymbol(symbol)}</span>
                            <span className="text-xs text-gray-500 font-price tabular-nums">
                                {currentPrice > 0 ? `₹${formatPrice(currentPrice)}` : ''}
                            </span>
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="metric-label">Quantity</label>
                            {!isBuy && isDelivery && holdingQty > 0 && (
                                <button
                                    onClick={() => setForm((f) => ({ ...f, quantity: holdingQty }))}
                                    className="text-[10px] text-primary-500 hover:text-primary-400 transition-colors"
                                >
                                    Max: {holdingQty}
                                </button>
                            )}
                        </div>
                        <div className="h-11 flex items-center border border-edge/10 rounded-lg overflow-hidden bg-surface-800/60">
                            <button
                                type="button"
                                onClick={() => setForm((f) => ({ ...f, quantity: Math.max(1, (parseInt(f.quantity, 10) || 1) - 1) }))}
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
                                    setForm((f) => ({ ...f, quantity: Math.max(1, parseInt(f.quantity, 10) || 1) }));
                                }}
                                className="min-w-0 flex-1 text-center bg-transparent text-heading text-sm font-price py-2 focus:outline-none tabular-nums"
                            />
                            <button
                                type="button"
                                onClick={() => setForm((f) => ({ ...f, quantity: (parseInt(f.quantity, 10) || 0) + 1 }))}
                                className="px-3 py-2 text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all text-lg font-bold flex-shrink-0"
                            >
                                +
                            </button>
                        </div>
                        {qtyExceedsHoldings && (
                            <p className="text-[10px] text-red-400 mt-1 px-1">
                                You only hold {holdingQty} shares. Reduce quantity to {holdingQty} or less.
                            </p>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="metric-label block mb-1">Trading type</label>
                        <select
                            value={selectedTradingProduct}
                            onChange={(e) => handleTradingTypeChange(e.target.value)}
                            className="h-11 w-full bg-surface-800/60 border border-edge/10 rounded-lg px-2.5 text-sm text-heading focus:outline-none focus:border-primary-500/30"
                        >
                            <option value="MIS">Intraday (MIS)</option>
                            <option value="CNC">Delivery (CNC)</option>
                            <option value="NRML">Normal (NRML)</option>
                        </select>
                    </div>
                    <div>
                        <label className="metric-label block mb-1">Order type</label>
                        <select
                            value={form.order_type}
                            onChange={(e) => handleOrderTypeChange(e.target.value)}
                            className="h-11 w-full bg-surface-800/60 border border-edge/10 rounded-lg px-2.5 text-sm text-heading focus:outline-none focus:border-primary-500/30"
                        >
                            <option value="MARKET">Market</option>
                            <option value="LIMIT">Limit</option>
                            <option value="SL">SL</option>
                            <option value="SL-M">SL-M</option>
                        </select>
                    </div>
                </div>

                {showCompactPriceField && (
                    <div>
                        <label className="metric-label block mb-1">Price (₹)</label>
                        <input
                            type="number"
                            step="0.05"
                            value={form.order_type === 'SL' ? form.triggerPrice : form.price}
                            onChange={(e) => setForm((f) => ({
                                ...f,
                                ...(form.order_type === 'SL'
                                    ? { triggerPrice: e.target.value }
                                    : { price: e.target.value }),
                            }))}
                            placeholder={formatPrice(currentPrice)}
                            className="w-full bg-surface-800/60 border border-edge/10 rounded-lg px-3 py-2 text-sm font-price text-heading placeholder-gray-600 focus:outline-none focus:border-primary-500/30 tabular-nums"
                        />
                    </div>
                )}

                <div className="border-t border-edge/5 pt-2">
                    <div className="rounded-xl bg-surface-800/40 border border-edge/5 p-2">
                    <div className="h-6 flex items-center justify-between text-xs">
                        <span className="text-gray-500">Est. Value</span>
                        <span className="font-price text-heading font-semibold tabular-nums text-right">{formatCurrency(totalCost)}</span>
                    </div>
                    <div className="h-6 flex items-center justify-between text-xs">
                        <span className="text-gray-500">Qty × Price</span>
                        <span className="font-price text-heading tabular-nums text-right">
                            {form.quantity || 0} × {form.order_type === ORDER_TYPE.LIMIT && form.price ? `₹${form.price}` : `₹${formatPrice(currentPrice)}`}
                        </span>
                    </div>
                    <div className="h-6 flex items-center justify-between text-xs">
                        <span className="text-gray-500">Product</span>
                        <span className="font-semibold text-amber-400 text-right">
                            {form.product_type} ({modeInfo.label})
                        </span>
                    </div>
                    {isIntraday && totalCost > 0 && (
                        <div className="h-6 flex items-center justify-between text-xs">
                            <span className="text-gray-500">Margin Required (5×)</span>
                            <span className="font-price text-amber-400 font-medium tabular-nums text-right">
                                {formatCurrency(marginRequired)}
                            </span>
                        </div>
                    )}
                </div>
                </div>
            </div>

            <div className={cn('px-3 pt-2 pb-2.5 border-t border-edge/5 bg-surface-900', !isFloating && 'sticky bottom-0')}>
                {!isBuy && isDelivery && !canSell && (
                    <div className="mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                        <span className="font-semibold">No holdings found.</span> In Delivery (CNC) mode, you can only sell shares you already own.
                        Switch to <button onClick={() => setTradingMode(TRADING_MODE.INTRADAY)} className="underline font-semibold text-amber-400 hover:text-amber-300">Intraday</button> for short selling.
                    </div>
                )}

                {!isBuy && isDelivery && canSell && (
                    <div className="mb-2 px-3 py-1.5 rounded-lg bg-surface-800/60 border border-edge/10 text-xs text-gray-400">
                        Available to sell: <span className="font-semibold text-heading">{holdingQty}</span> shares (Delivery)
                    </div>
                )}

                <Button
                    variant={isBuy ? 'buy' : 'sell'}
                    size="lg"
                    className={cn(
                        'w-full py-2.5 text-base',
                        (sellBlocked || qtyExceedsHoldings || !marketOpen) && '!opacity-40 !cursor-not-allowed !shadow-none !bg-gray-600 hover:!bg-gray-600'
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

            <Modal
                isOpen={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                title="Confirm Order"
                size="sm"
            >
                <div className="px-6 py-4 space-y-4">
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

                    {sellBlocked && (
                        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                            No holdings for {cleanSymbol(symbol)}. Switch to Intraday for short selling.
                        </div>
                    )}
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
