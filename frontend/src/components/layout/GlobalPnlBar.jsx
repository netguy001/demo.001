import { useMemo } from 'react';
import { TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { usePortfolioStore } from '../../store/usePortfolioStore';
import { cn } from '../../utils/cn';
import { formatCurrency, formatPercent, pnlColorClass } from '../../utils/formatters';

export default function GlobalPnlBar() {
    const summary = usePortfolioStore((s) => s.summary);
    const pnl = usePortfolioStore((s) => s.pnl);

    const metrics = useMemo(() => {
        const totalPnl = Number(summary?.total_pnl ?? pnl?.total ?? 0);
        const totalPnlPct = Number(summary?.total_pnl_percent ?? 0);
        // Derive net_equity from available_capital + current_value when the field is absent/zero
        const netEquity = Number(
            summary?.net_equity ||
            (summary?.available_capital != null
                ? Number(summary.available_capital) + Number(summary.current_value ?? 0)
                : 0)
        );
        const unrealized = Number(summary?.unrealized_pnl ?? pnl?.unrealized ?? 0);
        return { totalPnl, totalPnlPct, netEquity, unrealized };
    }, [summary, pnl]);

    const positive = metrics.totalPnl >= 0;

    return (
        <div className="h-9 border-b border-edge/5 bg-surface-900/50 backdrop-blur-sm px-4 lg:px-6 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-500 hidden sm:inline">Global P&L</span>
                <span className={cn('font-semibold font-price tabular-nums', pnlColorClass(metrics.totalPnl))}>
                    {positive ? '+' : ''}{formatCurrency(metrics.totalPnl)}
                </span>
                <span className={cn('font-price tabular-nums', pnlColorClass(metrics.totalPnl))}>
                    ({formatPercent(metrics.totalPnlPct)})
                </span>
                {positive
                    ? <TrendingUp className="w-3.5 h-3.5 text-profit" />
                    : <TrendingDown className="w-3.5 h-3.5 text-loss" />
                }
            </div>

            <div className="flex items-center gap-4 text-[11px]">
                <span className="hidden md:inline text-gray-500">
                    Unrealized: <span className={cn('font-price tabular-nums', pnlColorClass(metrics.unrealized))}>{formatCurrency(metrics.unrealized)}</span>
                </span>
                <span className="text-gray-500 flex items-center gap-1">
                    <Wallet className="w-3 h-3" />
                    Net Equity <span className="font-price tabular-nums text-heading">{formatCurrency(metrics.netEquity)}</span>
                </span>
            </div>
        </div>
    );
}