/**
 * FuturesPage — Professional Futures Trading Dashboard
 * Analytics + Simulated trading (local DB only, never sends orders to broker)
 */

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Search, Activity, TrendingUp, TrendingDown, Calendar, AlertCircle, Zap, Plus, Minus, BarChart3 } from 'lucide-react';
import { cn } from '../utils/cn.js';
import { formatPrice, formatCurrency, formatQuantity, formatPercent } from '../utils/formatters.js';
import api from '../services/api.js';
import { useFuturesWebSocket } from '../hooks/useFuturesWebSocket.ts';
import type {
  FuturesContract,
  FuturesQuote,
  SpotQuote,
  FuturesCandle,
  FuturesOrder,
  FuturesPosition,
  SentimentType,
  MarketSentiment,
} from '../types/futures.types';

// ━━━ HEADER / HERO SECTION ━━━
function HeroSection({
  contract,
  quote,
  spotPrice,
  symbol,
}: {
  contract: FuturesContract | null;
  quote: FuturesQuote | null;
  spotPrice: SpotQuote | null;
  symbol: string | null;
}) {
  const isPositive = quote && quote.change !== undefined && quote.change >= 0;
  const ltp = quote?.ltp ?? null;
  const change = quote?.change ?? 0;
  const changePct = quote?.change_pct ?? 0;

  // Calculate basis and cost of carry
  const basis = ltp && spotPrice?.ltp ? ltp - spotPrice.ltp : 0;
  const basisPct = spotPrice?.ltp && basis !== 0 ? (basis / spotPrice.ltp) * 100 : 0;
  const costOfCarry =
    basis !== 0 && spotPrice?.ltp && contract?.days_to_expiry
      ? (basis / spotPrice.ltp) * (365 / contract.days_to_expiry) * 100
      : 0;

  // Notional value
  const notionalValue = ltp && contract?.lot_size ? ltp * contract.lot_size : 0;

  return (
    <div className="space-y-4 pb-4 border-b border-[rgba(255,255,255,0.07)]">
      {/* Symbol & Type */}
      {contract && (
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold text-heading">{symbol || 'Futures'}</h1>
          <span className="px-2 py-1 rounded bg-[rgba(16,185,129,0.1)] text-[10px] font-semibold text-[#10b981] uppercase">NSE</span>
          <span className="px-2 py-1 rounded bg-[rgba(100,116,139,0.1)] text-[10px] font-semibold text-gray-400 uppercase">
            {contract.instrument_type === 'FUTIDX' ? 'Index' : 'Stock'}
          </span>
        </div>
      )}

      {/* LTP with live pulse dot and change */}
      <div className="flex items-baseline gap-4">
        <div className="flex items-center gap-2">
          <div className={cn('w-2 h-2 rounded-full animate-pulse', quote ? 'bg-[#10b981]' : 'bg-gray-600')} />
          <div className={cn('text-4xl font-display font-semibold tabular-nums', isPositive ? 'text-[#10b981]' : 'text-[#ef4444]')}>
            {ltp !== null ? formatPrice(ltp) : '—'}
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <div className={cn('text-sm font-semibold tabular-nums', isPositive ? 'text-[#10b981]' : 'text-[#ef4444]')}>
            {isPositive ? '+' : ''}{formatCurrency(change)}
          </div>
          <div className={cn('text-xs tabular-nums', isPositive ? 'text-[#10b981]' : 'text-[#ef4444]')}>
            {isPositive ? '+' : ''}{formatPercent(changePct)}
          </div>
        </div>
      </div>

      {/* Last updated + market status */}
      <div className="text-xs text-gray-500">
        {quote?.market_open ? (
          <span>Updated now · Market Open</span>
        ) : (
          <span>Closed · Last seen recently</span>
        )}
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)]">
          <div className="text-gray-500 uppercase tracking-wider">Volume</div>
          <div className="text-sm font-semibold text-heading tabular-nums">{quote?.volume ? formatQuantity(quote.volume) : '—'}</div>
        </div>
        <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)]">
          <div className="text-gray-500 uppercase tracking-wider">OI</div>
          <div className="text-sm font-semibold text-heading tabular-nums">{quote?.oi ? formatQuantity(quote.oi) : '—'}</div>
        </div>
        <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)]">
          <div className="text-gray-500 uppercase tracking-wider">Bid</div>
            <div className="text-sm font-semibold text-heading tabular-nums">{quote && quote.bid !== null ? formatPrice(quote.bid ?? 0) : '—'}</div>
          </div>
          <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)]">
            <div className="text-gray-500 uppercase tracking-wider">Ask</div>
            <div className="text-sm font-semibold text-heading tabular-nums">{quote && quote.ask !== null ? formatPrice(quote.ask ?? 0) : '—'}</div>
        </div>
      </div>

      {/* Notional & Basis */}
      {contract && (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)]">
            <div className="text-gray-500 uppercase tracking-wider">Notional</div>
            <div className="text-sm font-semibold text-heading tabular-nums">₹{formatQuantity(Math.floor(notionalValue))}</div>
          </div>
          <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)]">
            <div className="text-gray-500 uppercase tracking-wider">Basis</div>
            <div className={cn('text-sm font-semibold tabular-nums', basis >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]')}>
              {basis >= 0 ? '+' : ''}₹{formatPrice(Math.abs(basis))} ({basisPct.toFixed(2)}%)
            </div>
          </div>
        </div>
      )}

      {/* Days to expiry */}
      {contract && (
        <div className="px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.05)] text-[11px]">
          <div className="text-gray-500 uppercase tracking-wider">Days to Expiry</div>
          <div className={cn('text-sm font-semibold tabular-nums', contract.days_to_expiry <= 2 ? 'text-[#ef4444]' : contract.days_to_expiry <= 5 ? 'text-[#f59e0b]' : 'text-heading')}>
            {contract.days_to_expiry} days
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━ SPARKLINE ━━━
function Sparkline({ data }: { data: FuturesCandle[] }) {
  if (!data || data.length < 2) {
    return (
      <div className="h-12 flex items-center justify-center text-xs text-gray-600">
        Insufficient data for chart
      </div>
    );
  }

  const closes = data.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const start = closes[0];
  const end = closes[closes.length - 1];
  const isPositive = end >= start;

  // Normalize to 0-100 height
  const points = closes.map((c) => ((c - min) / range) * 100);

  // SVG path
  const stepX = 100 / (points.length - 1);
  const pathD = points
    .map((y, i) => `${i === 0 ? 'M' : 'L'} ${i * stepX} ${100 - y}`)
    .join(' ');

  return (
    <svg viewBox="0 0 100 100" className="w-full h-12" preserveAspectRatio="none">
      <polyline
        points={`0,100 ${points.map((y, i) => `${i * stepX},${100 - y}`).join(' ')} 100,100`}
        fill={isPositive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}
        stroke="none"
      />
      <polyline
        points={points.map((y, i) => `${i * stepX},${100 - y}`).join(' ')}
        fill="none"
        stroke={isPositive ? '#10b981' : '#ef4444'}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ━━━ CONTRACTS TABLE ━━━
function ContractsTable({
  contracts,
  selectedContract,
  onSelectContract,
  quotes,
}: {
  contracts: FuturesContract[];
  selectedContract: FuturesContract | null;
  onSelectContract: (c: FuturesContract) => void;
  quotes: Record<string, FuturesQuote>;
}) {
  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.07)] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)]">
              <th className="px-3 py-2 text-left text-gray-500 font-semibold uppercase tracking-wider">Expiry</th>
              <th className="px-3 py-2 text-right text-gray-500 font-semibold uppercase tracking-wider">LTP</th>
              <th className="px-3 py-2 text-right text-gray-500 font-semibold uppercase tracking-wider">Chg%</th>
              <th className="px-3 py-2 text-right text-gray-500 font-semibold uppercase tracking-wider">Vol</th>
              <th className="px-3 py-2 text-right text-gray-500 font-semibold uppercase tracking-wider">OI</th>
              <th className="px-3 py-2 text-right text-gray-500 font-semibold uppercase tracking-wider">Bid</th>
              <th className="px-3 py-2 text-right text-gray-500 font-semibold uppercase tracking-wider">Ask</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((contract, idx) => {
              const quote = quotes[contract.contract_symbol];
              const isSelected = selectedContract?.contract_symbol === contract.contract_symbol;
              const changePct = quote?.change_pct ?? 0;
              const isPositive = changePct >= 0;

              return (
                <tr
                  key={idx}
                  onClick={() => onSelectContract(contract)}
                  className={cn(
                    'border-b border-[rgba(255,255,255,0.03)] cursor-pointer transition-colors',
                    isSelected
                      ? 'bg-[rgba(16,185,129,0.08)] border-l-2 border-l-[#10b981]'
                      : 'hover:bg-[rgba(255,255,255,0.02)]'
                  )}
                >
                  <td className="px-3 py-2 text-gray-400">
                    <div className="font-semibold text-heading">{contract.expiry_label}</div>
                    <div className="text-[10px] text-gray-600">{contract.expiry_date}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-heading tabular-nums">
                    {quote?.ltp !== null ? formatPrice(quote.ltp ?? 0) : '—'}
                  </td>
                  <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', isPositive ? 'text-[#10b981]' : 'text-[#ef4444]')}>
                    {quote && quote.change_pct !== undefined ? (isPositive ? '+' : '') + formatPercent(quote.change_pct) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400 tabular-nums">
                    {quote?.volume ? formatQuantity(quote.volume) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400 tabular-nums">
                    {quote?.oi ? formatQuantity(quote.oi) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400 tabular-nums">
                    {quote?.bid !== null ? formatPrice(quote.bid ?? 0) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400 tabular-nums">
                    {quote?.ask !== null ? formatPrice(quote.ask ?? 0) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ━━━ LEFT PANEL: SEARCH + CONTRACTS ━━━
function LeftPanel({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  contracts,
  selectedContract,
  onSelectContract,
  loading,
}: {
  symbols: string[];
  selectedSymbol: string | null;
  onSelectSymbol: (s: string) => void;
  contracts: FuturesContract[];
  selectedContract: FuturesContract | null;
  onSelectContract: (c: FuturesContract) => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [showResults, setShowResults] = useState(false);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setSearch(val);

    if (val.length === 0) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    // Simple local search on common symbols
    const filtered = [
      'RELIANCE',
      'TCS',
      'HDFCBANK',
      'INFY',
      'ICICIBANK',
      'SBIN',
      'LT',
      'ITC',
      'AXISBANK',
      'HINDUNILVR',
      'NIFTY',
      'BANKNIFTY',
    ].filter((s) => s.includes(val));

    setSearchResults(filtered);
    setShowResults(true);
  };

  const handleSelectFromSearch = (sym: string) => {
    setSearch('');
    setShowResults(false);
    onSelectSymbol(sym);
  };

  return (
    <div className="w-64 bg-[#0f0f1e] border-r border-[rgba(255,255,255,0.07)] flex flex-col">
      {/* Search */}
      <div className="p-4 border-b border-[rgba(255,255,255,0.07)]">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-600" />
          <input
            type="text"
            placeholder="Search symbol..."
            value={search}
            onChange={handleSearchChange}
            onFocus={() => search.length > 0 && setShowResults(true)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#1a1f3a] border border-[rgba(255,255,255,0.07)] text-heading text-sm outline-none focus:border-[#10b981]/50 transition"
          />

          {/* Search Results Dropdown */}
          {showResults && searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 rounded-lg bg-[#1a1f3a] border border-[rgba(255,255,255,0.07)] z-50 shadow-lg">
              {searchResults.map((sym: string) => (
                <button
                  key={sym}
                  onClick={() => handleSelectFromSearch(sym)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-[#243f68] hover:text-heading transition"
                >
                  {sym}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Contracts List */}
      <div className="flex-1 overflow-y-auto">
        {contracts.length === 0 && selectedSymbol ? (
          <div className="p-4 text-center text-gray-600 text-sm">
            No futures contracts for {selectedSymbol}
          </div>
        ) : (
          <div className="divide-y divide-[rgba(255,255,255,0.05)]">
            {contracts.map((contract, idx) => {
              const isSelected = selectedContract?.contract_symbol === contract.contract_symbol;
              return (
                <button
                  key={idx}
                  onClick={() => onSelectContract(contract)}
                  className={cn(
                    'w-full text-left px-4 py-3 transition-colors border-l-2',
                    isSelected
                      ? 'bg-[rgba(16,185,129,0.08)] border-l-[#10b981]'
                      : 'hover:bg-[rgba(255,255,255,0.02)] border-l-transparent'
                  )}
                >
                  <div className="text-xs text-gray-500 uppercase tracking-wider">{contract.expiry_label}</div>
                  <div className="text-sm font-semibold text-heading">{contract.expiry_date}</div>
                  <div className="text-xs text-gray-600 mt-1">Lot: {contract.lot_size}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ━━━ RIGHT PANEL: METADATA + CONTEXT ━━━
function RightPanel({
  contract,
  quote,
  spotPrice,
}: {
  contract: FuturesContract | null;
  quote: FuturesQuote | null;
  spotPrice: SpotQuote | null;
}) {
  const basis = quote?.ltp && spotPrice?.ltp ? quote.ltp - spotPrice.ltp : 0;
  const basisPct = spotPrice?.ltp && basis !== 0 ? (basis / spotPrice.ltp) * 100 : 0;
  const costOfCarry =
    basis !== 0 && spotPrice?.ltp && contract?.days_to_expiry
      ? (basis / spotPrice.ltp) * (365 / contract.days_to_expiry) * 100
      : 0;
  const oiTrend = (quote?.oi_change ?? 0) > 0 ? 'up' : 'down';
  const priceTrend = (quote?.close ?? 0) > (quote?.open ?? 0) ? 'up' : 'down';

  let sentimentType: SentimentType = 'long-unwinding';
  if (oiTrend === 'up' && priceTrend === 'up') sentimentType = 'long-buildup';
  else if (oiTrend === 'up' && priceTrend === 'down') sentimentType = 'short-buildup';
  else if (oiTrend === 'down' && priceTrend === 'up') sentimentType = 'short-covering';

  const sentimentLabels = {
    'long-buildup': { label: 'Long build-up', color: '#10b981' },
    'short-buildup': { label: 'Short build-up', color: '#ef4444' },
    'short-covering': { label: 'Short covering', color: '#f59e0b' },
    'long-unwinding': { label: 'Long unwinding', color: '#ef4444' },
  };

  return (
    <div className="w-72 bg-[#0f0f1e] border-l border-[rgba(255,255,255,0.07)] flex flex-col gap-4 p-4 overflow-y-auto">
      {/* Contract Metadata */}
      {contract && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.07)] p-3 space-y-2 text-xs">
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Contract</div>
            <div className="font-mono text-heading text-[11px]">{contract.contract_symbol}</div>
          </div>
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Expiry</div>
            <div className="text-heading">{contract.expiry_date}</div>
          </div>
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Lot Size</div>
            <div className="text-heading">{contract.lot_size}</div>
          </div>
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Tick Size</div>
            <div className="text-heading font-mono">₹{contract.tick_size.toFixed(2)}</div>
          </div>
        </div>
      )}

      {/* Market Context */}
      {quote && spotPrice && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.07)] p-3 space-y-2 text-xs">
          <div className="font-semibold uppercase tracking-wider text-gray-400">Market Context</div>
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Spot</div>
            <div className="text-heading">{spotPrice.ltp !== null ? formatPrice(spotPrice.ltp) : '—'}</div>
          </div>
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Basis</div>
            <div className={cn('text-heading', basis >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]')}>
              {basis >= 0 ? '+' : ''}₹{formatPrice(Math.abs(basis))} ({basisPct.toFixed(2)}%)
            </div>
          </div>
          <div>
            <div className="text-gray-500 uppercase tracking-wider">Cost of Carry</div>
            <div className="text-heading">{costOfCarry.toFixed(2)}% p.a.</div>
          </div>
        </div>
      )}

      {/* Sentiment */}
      {quote && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.07)] p-3 space-y-2 text-xs">
          <div className="font-semibold uppercase tracking-wider text-gray-400">Market Sentiment</div>
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: sentimentLabels[sentimentType].color }}
            />
            <div className="text-heading font-semibold">{sentimentLabels[sentimentType].label}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs mt-2">
            <div>
              <div className="text-gray-500">OI</div>
              <div className={cn('font-semibold', oiTrend === 'up' ? 'text-[#10b981]' : 'text-[#ef4444]')}>
                {oiTrend === 'up' ? '↑' : '↓'} {quote && quote.oi_change ? Math.abs(quote.oi_change) : '—'}
              </div>
            </div>
            <div>
              <div className="text-gray-500">Price</div>
              <div className={cn('font-semibold', priceTrend === 'up' ? 'text-[#10b981]' : 'text-[#ef4444]')}>
                {priceTrend === 'up' ? '↑' : '↓'} {quote && quote.change !== undefined ? quote.change : '—'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━ MAIN PAGE ━━━
interface FuturesPageProps {}

export default function FuturesPage(props: FuturesPageProps = {}) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedContract, setSelectedContract] = useState<FuturesContract | null>(null);
  const [contracts, setContracts] = useState<FuturesContract[]>([]);
  const [quotes, setQuotes] = useState<Record<string, FuturesQuote>>({});
  const [spotPrice, setSpotPrice] = useState<SpotQuote | null>(null);
  const [history, setHistory] = useState<FuturesCandle[]>([]);
  const [loading, setLoading] = useState(false);

  // Trading state
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderQuantity, setOrderQuantity] = useState(1);
  const [orderPrice, setOrderPrice] = useState<number | null>(null);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [orders, setOrders] = useState<FuturesOrder[]>([]);
  const [positions, setPositions] = useState<FuturesPosition[]>([]);
  const [placingOrder, setPlacingOrder] = useState(false);

  const { subscribe, isConnected } = useFuturesWebSocket({
    onQuoteUpdate: (quote: FuturesQuote) => {
      setQuotes((prev: Record<string, FuturesQuote>) => ({
        ...prev,
        [quote.contract_symbol]: quote,
      }));
    },
  });

  // Fetch contracts for selected symbol
  useEffect(() => {
    if (!selectedSymbol) {
      setContracts([]);
      setSelectedContract(null);
      return;
    }

    const fetchContracts = async () => {
      setLoading(true);
      try {
        const response = await api.get<any>(`/futures/contracts/${selectedSymbol}`);
        setContracts(response.data.contracts);
        if (response.data.contracts.length > 0) {
          setSelectedContract(response.data.contracts[0]);
        }
      } catch (err) {
        console.error('Failed to fetch contracts:', err);
        setContracts([]);
      } finally {
        setLoading(false);
      }
    };

    fetchContracts();
  }, [selectedSymbol]);

  // Fetch quote for selected contract
  useEffect(() => {
    if (!selectedContract) return;

    // Subscribe to WebSocket
    subscribe(selectedContract.contract_symbol);

    // Also fetch initial quote
    const fetchQuote = async () => {
      try {
        const response = await api.get<any>(`/futures/quote/${selectedContract.contract_symbol}`);
        setQuotes((prev: Record<string, FuturesQuote>) => ({
          ...prev,
          [selectedContract.contract_symbol]: response.data,
        }));
      } catch (err) {
        console.error('Failed to fetch quote:', err);
      }
    };

    fetchQuote();

    // Fetch history for sparkline
    const fetchHistory = async () => {
      try {
        const response = await api.get<any>(
          `/futures/history/${selectedContract.contract_symbol}?interval=5m&limit=30`
        );
        setHistory(response.data.candles);
      } catch (err) {
        console.error('Failed to fetch history:', err);
      }
    };

    fetchHistory();
  }, [selectedContract, subscribe]);

  // Fetch spot price for basis calculation
  useEffect(() => {
    if (!selectedSymbol) return;

    const fetchSpot = async () => {
      try {
        const response = await api.get<any>(`/futures/spot/${selectedSymbol}`);
        setSpotPrice(response.data);
      } catch (err) {
        console.error('Failed to fetch spot price:', err);
      }
    };

    fetchSpot();
  }, [selectedSymbol]);

  // Fetch orders
  useEffect(() => {
    const fetchOrders = async () => {
      try {
        const response = await api.get<any>(`/futures/orders`);
        setOrders(response.data.orders || []);
      } catch (err) {
        console.error('Failed to fetch orders:', err);
      }
    };

    const timer = setInterval(fetchOrders, 3000); // Poll every 3 seconds
    fetchOrders();
    return () => clearInterval(timer);
  }, []);

  // Fetch positions
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const response = await api.get<any>(`/futures/positions`);
        setPositions(response.data.positions || []);
      } catch (err) {
        console.error('Failed to fetch positions:', err);
      }
    };

    const timer = setInterval(fetchPositions, 3000);
    fetchPositions();
    return () => clearInterval(timer);
  }, []);

  // Place order
  const handlePlaceOrder = async () => {
    if (!selectedContract || !selectedQuote) return;

    setPlacingOrder(true);
    try {
      const price = orderType === 'LIMIT' ? orderPrice : selectedQuote.ltp;
      const response = await api.post(`/futures/orders/place`, {
        contract_symbol: selectedContract.contract_symbol,
        side: orderSide,
        order_type: orderType,
        quantity: orderQuantity,
        price: price,
        client_price: price,
      });

      if (response.data.success) {
        setShowOrderForm(false);
        setOrderQuantity(1);
        setOrderPrice(null);
      }
    } catch (err) {
      console.error('Failed to place order:', err);
    } finally {
      setPlacingOrder(false);
    }
  };

  const selectedQuote = selectedContract ? quotes[selectedContract.contract_symbol] : null;

  return (
    <div className="flex h-screen bg-[#0f0f1e] text-heading">
      {/* LEFT PANEL */}
      <LeftPanel
        symbols={['RELIANCE', 'TCS', 'NIFTY']}
        selectedSymbol={selectedSymbol}
        onSelectSymbol={setSelectedSymbol}
        contracts={contracts}
        selectedContract={selectedContract}
        onSelectContract={setSelectedContract}
        loading={loading}
      />

      {/* CENTER PANEL */}
      <div className="flex-1 flex flex-col overflow-y-auto p-6 gap-6 bg-gradient-to-b from-[#0f0f1e] to-[#0a0a14]">
        {selectedSymbol && selectedContract ? (
          <>
            <HeroSection contract={selectedContract} quote={selectedQuote} spotPrice={spotPrice} symbol={selectedSymbol} />
            {history.length > 0 && (
              <div className="h-16">
                <Sparkline data={history} />
              </div>
            )}
            {contracts.length > 0 && (
              <ContractsTable contracts={contracts} selectedContract={selectedContract} onSelectContract={setSelectedContract} quotes={quotes} />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center">
            <div>
              <Activity className="w-16 h-16 text-gray-700 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-heading mb-2">Search for a symbol</h2>
              <p className="text-gray-500">to view futures data and analytics</p>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT PANEL */}
      {selectedSymbol && selectedContract && <RightPanel contract={selectedContract} quote={selectedQuote} spotPrice={spotPrice} />}

      {/* ORDER FORM MODAL */}
      {showOrderForm && selectedContract && selectedQuote && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-[#1a1f3a] rounded-lg border border-[rgba(255,255,255,0.07)] w-96 p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold text-heading">Place Order</h3>
              <button onClick={() => setShowOrderForm(false)} className="text-gray-400 hover:text-heading">✕</button>
            </div>

            <div>
              <label className="text-xs text-gray-400 uppercase tracking-wider">Side</label>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => setOrderSide('BUY')}
                  className={cn('flex-1 py-2 px-3 rounded text-sm font-semibold', orderSide === 'BUY' ? 'bg-[#10b981] text-white' : 'bg-[rgba(255,255,255,0.02)] text-gray-400')}
                >
                  BUY
                </button>
                <button
                  onClick={() => setOrderSide('SELL')}
                  className={cn('flex-1 py-2 px-3 rounded text-sm font-semibold', orderSide === 'SELL' ? 'bg-[#ef4444] text-white' : 'bg-[rgba(255,255,255,0.02)] text-gray-400')}
                >
                  SELL
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-400 uppercase tracking-wider">Order Type</label>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => setOrderType('MARKET')}
                  className={cn('flex-1 py-2 px-3 rounded text-sm font-semibold', orderType === 'MARKET' ? 'bg-[#10b981] text-white' : 'bg-[rgba(255,255,255,0.02)] text-gray-400')}
                >
                  MARKET
                </button>
                <button
                  onClick={() => setOrderType('LIMIT')}
                  className={cn('flex-1 py-2 px-3 rounded text-sm font-semibold', orderType === 'LIMIT' ? 'bg-[#10b981] text-white' : 'bg-[rgba(255,255,255,0.02)] text-gray-400')}
                >
                  LIMIT
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-400 uppercase tracking-wider">Quantity (Min: {selectedContract.lot_size})</label>
              <input
                type="number"
                value={orderQuantity}
                onChange={(e) => setOrderQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full mt-2 px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.07)] text-heading text-sm"
              />
            </div>

            {orderType === 'LIMIT' && (
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wider">Price</label>
                <input
                  type="number"
                  value={orderPrice || ''}
                  onChange={(e) => setOrderPrice(parseFloat(e.target.value) || null)}
                  className="w-full mt-2 px-3 py-2 rounded bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.07)] text-heading text-sm"
                  placeholder={`Current: ${formatPrice(selectedQuote.ltp || 0)}`}
                />
              </div>
            )}

            <div className="pt-4 flex gap-2">
              <button
                onClick={() => setShowOrderForm(false)}
                className="flex-1 px-4 py-2 rounded bg-[rgba(255,255,255,0.05)] text-gray-400 hover:bg-[rgba(255,255,255,0.1)] text-sm font-semibold transition"
              >
                Cancel
              </button>
              <button
                onClick={handlePlaceOrder}
                disabled={placingOrder}
                className="flex-1 px-4 py-2 rounded bg-[#10b981] text-white hover:bg-[#0fa373] text-sm font-semibold transition disabled:opacity-50"
              >
                {placingOrder ? 'Placing...' : 'Place Order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POSITIONS + ORDERS PANEL (Bottom) */}
      {selectedContract && (
        <div className="fixed bottom-0 left-0 right-0 bg-[#0f0f1e] border-t border-[rgba(255,255,255,0.07)] max-h-64 overflow-y-auto">
          <div className="flex gap-4 p-4">
            {/* Trading Buttons */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowOrderForm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded bg-[#10b981] text-white hover:bg-[#0fa373] text-sm font-semibold transition"
              >
                <Plus className="w-4 h-4" /> BUY
              </button>
              <button
                onClick={() => {
                  setOrderSide('SELL');
                  setShowOrderForm(true);
                }}
                className="flex items-center gap-2 px-4 py-2 rounded bg-[#ef4444] text-white hover:bg-[#d63031] text-sm font-semibold transition"
              >
                <Minus className="w-4 h-4" /> SELL
              </button>
            </div>

            {/* Positions */}
            {positions.length > 0 && (
              <div className="flex-1 space-y-1">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Positions</div>
                {positions.map((pos) => (
                  <div key={pos.id} className="flex gap-4 text-xs">
                    <span className="text-gray-400">{pos.contract_symbol}</span>
                    <span className={pos.quantity > 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>
                      {pos.quantity > 0 ? 'LONG' : 'SHORT'} {Math.abs(pos.quantity)}
                    </span>
                    <span className="text-gray-500">Entry: {formatPrice(pos.avg_entry_price)}</span>
                    <span className={pos.unrealized_pnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>
                      P&L: {formatCurrency(pos.unrealized_pnl)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Recent Orders */}
            {orders.length > 0 && (
              <div className="flex-1 space-y-1">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Recent Orders</div>
                {orders.slice(0, 3).map((ord) => (
                  <div key={ord.id} className="flex gap-4 text-xs">
                    <span className={ord.side === 'BUY' ? 'text-[#10b981]' : 'text-[#ef4444]'}>{ord.side}</span>
                    <span className="text-gray-400">{ord.quantity} @ {formatPrice(ord.filled_price || ord.price || 0)}</span>
                    <span className={`px-2 py-0.5 rounded ${
                      ord.status === 'FILLED' ? 'bg-[#10b981]/20 text-[#10b981]' :
                      ord.status === 'OPEN' ? 'bg-blue-500/20 text-blue-400' :
                      'bg-gray-700/20 text-gray-400'
                    }`}>
                      {ord.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
