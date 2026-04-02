import { memo } from 'react';
import { cn } from '../utils/cn';
import { formatPrice, cleanSymbol } from '../utils/formatters';
import { ORDER_STATUS_CLASS } from '../utils/constants';
import { PanelContainer } from '.';

/**
 * OrderHistoryPanel — shows recent orders.
 * Extracted from TradingTerminalPage BottomTabs → "orders" tab.
 */
function OrderHistoryPanel({ orders = [], className, showHeader = true }) {
    return (
        <PanelContainer title={showHeader ? 'Orders' : ''} noPadding className={className}
            actions={<span className="text-[10px] text-gray-600 font-price tabular-nums">{orders.length}</span>}
        >
            {orders.length > 0 ? (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[600px]">
                        <thead>
                            <tr>
                                <th className="text-left px-3 pb-2 pt-2 metric-label">Symbol</th>
                                <th className="text-left px-3 pb-2 pt-2 metric-label">Side</th>
                                <th className="text-left px-3 pb-2 pt-2 metric-label">Type</th>
                                <th className="text-right px-3 pb-2 pt-2 metric-label">Qty</th>
                                <th className="text-right px-3 pb-2 pt-2 metric-label">Price</th>
                                <th className="text-right px-3 pb-2 pt-2 metric-label">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {orders.map((o, i) => (
                                <tr key={o.id || i} className="border-t border-edge/[0.03] hover:bg-overlay/[0.02] transition-colors">
                                    <td className="px-3 py-1.5 font-semibold text-heading">{cleanSymbol(o.symbol)}</td>
                                    <td className={cn('px-3 py-1.5 font-semibold', o.side === 'BUY' ? 'text-bull' : 'text-bear')}>{o.side}</td>
                                    <td className="px-3 py-1.5 text-gray-400">{o.order_type}</td>
                                    <td className="px-3 py-1.5 text-right font-price text-gray-600 tabular-nums">{o.quantity}</td>
                                    <td className="px-3 py-1.5 text-right font-price text-heading tabular-nums">
                                        {formatPrice(o.filled_price ?? o.price ?? null)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right">
                                        <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium',
                                            ORDER_STATUS_CLASS[o.status] || ORDER_STATUS_CLASS.PENDING
                                        )}>
                                            {o.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="text-center py-6 text-gray-600 text-xs">No orders yet.</div>
            )}
        </PanelContainer>
    );
}

export default memo(OrderHistoryPanel);
