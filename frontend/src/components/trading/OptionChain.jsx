import { memo, useEffect, useMemo, useState } from 'react';
import { cn } from '../../utils/cn';
import { formatPrice } from '../../utils/formatters';

function OptionChain({ chain = [], spotPrice = 0, onSelectOption, onContextAction }) {
    const [menu, setMenu] = useState(null);

    const atmStrike = useMemo(() => {
        if (!chain.length) return 0;
        return chain.reduce((closest, row) => {
            if (!closest) return row.strike;
            return Math.abs(row.strike - spotPrice) < Math.abs(closest - spotPrice) ? row.strike : closest;
        }, 0);
    }, [chain, spotPrice]);

    useEffect(() => {
        if (!menu) return;
        const close = () => setMenu(null);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [menu]);

    const openContextMenu = (event, payload) => {
        event.preventDefault();
        setMenu({
            x: event.clientX,
            y: event.clientY,
            payload,
        });
    };

    const handleLongPress = (event, payload) => {
        let timer;
        const start = (touchEvent) => {
            timer = setTimeout(() => {
                const touch = touchEvent.touches?.[0];
                if (!touch) return;
                setMenu({
                    x: touch.clientX,
                    y: touch.clientY,
                    payload,
                });
            }, 550);
        };

        const clear = () => {
            if (timer) {
                clearTimeout(timer);
            }
        };

        start(event);
        return { clear };
    };

    const runContextAction = (action) => {
        if (!menu?.payload) return;
        const { strike, optionType, data } = menu.payload;
        if ((action === 'BUY' || action === 'SELL') && optionType && onSelectOption) {
            onSelectOption(strike, optionType, { ...data, side: action });
        }
        if (action === 'WATCHLIST' && onContextAction) {
            onContextAction({ action, strike, optionType, data });
        }
        setMenu(null);
    };

    return (
        <div className="relative rounded-xl border border-edge/5 bg-surface-900/60 overflow-hidden">
            <div className="overflow-auto max-h-[430px]">
                <table className="w-full text-xs min-w-[1320px]">
                    <thead>
                        <tr className="border-b border-edge/5">
                            {[ 'OI', 'OI Chg', 'Volume', 'IV', 'Delta', 'LTP (CE)', 'BID', 'ASK', 'STRIKE', 'BID', 'ASK', 'LTP (PE)', 'Delta', 'IV', 'Volume', 'OI Chg', 'OI' ].map((header) => (
                                <th
                                    key={header}
                                    className={cn(
                                        'sticky top-0 z-10 py-3 text-[11px] font-medium tracking-wider uppercase text-gray-500 bg-surface-900/95 backdrop-blur-sm',
                                        header === 'STRIKE' ? 'text-center border-x border-primary-500/20 text-primary-600' : 'text-right',
                                    )}
                                >
                                    {header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {chain.map((row) => {
                            const ceItm = row.strike < spotPrice;
                            const peItm = row.strike > spotPrice;
                            const isAtm = row.strike === atmStrike;

                            const contextPayload = {
                                strike: row.strike,
                                optionType: null,
                                data: row,
                            };

                            return (
                                <tr
                                    key={row.strike}
                                    className={cn(
                                        'border-b border-edge/[0.025] hover:bg-overlay/[0.02] transition-colors',
                                        isAtm && 'bg-primary-600/10',
                                    )}
                                    onContextMenu={(event) => openContextMenu(event, contextPayload)}
                                >
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', ceItm && 'bg-emerald-500/5')}>{row.ce.oi.toLocaleString('en-IN')}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums', row.ce.oiChange >= 0 ? 'text-profit' : 'text-loss', ceItm && 'bg-emerald-500/5')}>{row.ce.oiChange >= 0 ? '+' : ''}{row.ce.oiChange.toLocaleString('en-IN')}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', ceItm && 'bg-emerald-500/5')}>{row.ce.volume.toLocaleString('en-IN')}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', ceItm && 'bg-emerald-500/5')}>{formatPrice(row.ce.iv)}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', ceItm && 'bg-emerald-500/5')}>{formatPrice(row.ce.delta)}</td>
                                    <td
                                        className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-heading font-semibold cursor-pointer hover:text-primary-600', ceItm && 'bg-emerald-500/5')}
                                        onClick={() => onSelectOption?.(row.strike, 'CE', row.ce)}
                                        onContextMenu={(event) => openContextMenu(event, { strike: row.strike, optionType: 'CE', data: row.ce })}
                                        onTouchStart={(event) => {
                                            const handler = handleLongPress(event, { strike: row.strike, optionType: 'CE', data: row.ce });
                                            event.currentTarget.dataset.longPressHandler = 'true';
                                            event.currentTarget.longPressClear = handler.clear;
                                        }}
                                        onTouchEnd={(event) => event.currentTarget.longPressClear?.()}
                                        onTouchMove={(event) => event.currentTarget.longPressClear?.()}
                                    >
                                        {formatPrice(row.ce.ltp)}
                                    </td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', ceItm && 'bg-emerald-500/5')}>{formatPrice(row.ce.bid)}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400 border-r border-edge/10', ceItm && 'bg-emerald-500/5')}>{formatPrice(row.ce.ask)}</td>

                                    <td className="py-2.5 px-2 text-center font-price font-semibold tabular-nums text-heading border-x border-primary-500/20 bg-primary-600/5">
                                        {row.strike}
                                    </td>

                                    <td className={cn('py-2.5 pl-3 text-right font-price tabular-nums text-gray-400 border-l border-edge/10', peItm && 'bg-red-500/5')}>{formatPrice(row.pe.bid)}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', peItm && 'bg-red-500/5')}>{formatPrice(row.pe.ask)}</td>
                                    <td
                                        className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-heading font-semibold cursor-pointer hover:text-primary-600', peItm && 'bg-red-500/5')}
                                        onClick={() => onSelectOption?.(row.strike, 'PE', row.pe)}
                                        onContextMenu={(event) => openContextMenu(event, { strike: row.strike, optionType: 'PE', data: row.pe })}
                                        onTouchStart={(event) => {
                                            const handler = handleLongPress(event, { strike: row.strike, optionType: 'PE', data: row.pe });
                                            event.currentTarget.longPressClear = handler.clear;
                                        }}
                                        onTouchEnd={(event) => event.currentTarget.longPressClear?.()}
                                        onTouchMove={(event) => event.currentTarget.longPressClear?.()}
                                    >
                                        {formatPrice(row.pe.ltp)}
                                    </td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', peItm && 'bg-red-500/5')}>{formatPrice(row.pe.delta)}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', peItm && 'bg-red-500/5')}>{formatPrice(row.pe.iv)}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', peItm && 'bg-red-500/5')}>{row.pe.volume.toLocaleString('en-IN')}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums', row.pe.oiChange >= 0 ? 'text-profit' : 'text-loss', peItm && 'bg-red-500/5')}>{row.pe.oiChange >= 0 ? '+' : ''}{row.pe.oiChange.toLocaleString('en-IN')}</td>
                                    <td className={cn('py-2.5 pr-3 text-right font-price tabular-nums text-gray-400', peItm && 'bg-red-500/5')}>{row.pe.oi.toLocaleString('en-IN')}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {menu && (
                <div
                    className="fixed z-[80] min-w-[150px] rounded-lg border border-edge/10 bg-surface-800 shadow-panel py-1"
                    style={{ left: menu.x, top: menu.y }}
                >
                    <button
                        onClick={() => runContextAction('BUY')}
                        className="w-full text-left px-3 py-1.5 text-xs text-bull hover:bg-overlay/[0.06] transition-colors"
                    >
                        BUY
                    </button>
                    <button
                        onClick={() => runContextAction('SELL')}
                        className="w-full text-left px-3 py-1.5 text-xs text-bear hover:bg-overlay/[0.06] transition-colors"
                    >
                        SELL
                    </button>
                    <button
                        onClick={() => runContextAction('WATCHLIST')}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-heading hover:bg-overlay/[0.06] transition-colors"
                    >
                        Add to Watchlist
                    </button>
                </div>
            )}
        </div>
    );
}

export default memo(OptionChain);
