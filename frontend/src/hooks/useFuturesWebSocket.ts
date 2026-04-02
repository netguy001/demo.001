/**
 * useFuturesWebSocket — Real-time futures quote WebSocket hook
 * Manages subscription, reconnection, stale detection, and quote updates
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { FuturesQuote, WebSocketState, SubscribeFuturesMessage, FuturesQuoteEvent } from '../types/futures.types';

// @ts-ignore
const WS_BASE_URL = (import.meta.env?.VITE_WS_URL as string | undefined) || 'ws://localhost:8000/ws';
const WS_INITIAL_BACKOFF = 1000; // 1s
const WS_MAX_BACKOFF = 30000; // 30s
const STALE_THRESHOLD = 5000; // 5s without data = stale
const HEARTBEAT_INTERVAL = 30000; // Check staleness every 30s

export interface UseFuturesWebSocketProps {
  onQuoteUpdate?: (quote: FuturesQuote) => void;
  onStatusChange?: (status: WebSocketState) => void;
  onAvailabilityChange?: (available: boolean) => void;
}

export function useFuturesWebSocket(props: UseFuturesWebSocketProps = {}) {
  const { onQuoteUpdate, onStatusChange, onAvailabilityChange } = props;

  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<WebSocketState>({
    status: 'disconnected',
    lastMessageAt: null,
    reconnectAttempt: 0,
    contract: null,
    error: null,
  });

  const callbacksRef = useRef({ onQuoteUpdate, onStatusChange, onAvailabilityChange });
  callbacksRef.current = { onQuoteUpdate, onStatusChange, onAvailabilityChange };

  const backoffRef = useRef(WS_INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const staleCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState<WebSocketState>(statusRef.current);

  const updateStatus = useCallback((newStatus: Partial<WebSocketState>) => {
    statusRef.current = { ...statusRef.current, ...newStatus };
    setStatus({ ...statusRef.current });
    callbacksRef.current.onStatusChange?.(statusRef.current);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.CONNECTING || wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    if (!mountedRef.current) return;

    try {
      wsRef.current = new WebSocket(WS_BASE_URL);

      wsRef.current.onopen = () => {
        if (!mountedRef.current) return;
        backoffRef.current = WS_INITIAL_BACKOFF;
        updateStatus({
          status: 'connected',
          reconnectAttempt: 0,
          error: null,
        });
      };

      wsRef.current.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;

        try {
          const msg = JSON.parse(event.data) as FuturesQuoteEvent;

          if (msg.type === 'futures_quote') {
            updateStatus({
              lastMessageAt: Date.now(),
            });
            callbacksRef.current.onQuoteUpdate?.(msg.data);
          }
        } catch (e) {
          // Ignore parse errors
        }
      };

      wsRef.current.onerror = (event: Event) => {
        if (!mountedRef.current) return;
        updateStatus({
          status: 'stale',
          error: 'WebSocket error',
        });
      };

      wsRef.current.onclose = () => {
        if (!mountedRef.current) return;
        updateStatus({
          status: 'disconnected',
        });
        // Schedule reconnect
        attemptReconnect();
      };
    } catch (e) {
      updateStatus({
        status: 'disconnected',
        error: String(e),
      });
      attemptReconnect();
    }
  }, [updateStatus]);

  const attemptReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    reconnectTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      statusRef.current.reconnectAttempt += 1;
      updateStatus({
        status: 'reconnecting',
        reconnectAttempt: statusRef.current.reconnectAttempt,
      });
      backoffRef.current = Math.min(backoffRef.current * 2, WS_MAX_BACKOFF);
      connect();
    }, backoffRef.current);
  }, [connect, updateStatus]);

  const subscribe = useCallback((contract: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      // Queue subscription for when connected
      // For now, just return — will resubscribe on reconnect
      return;
    }

    const msg: SubscribeFuturesMessage = {
      type: 'subscribe_futures',
      contract,
    };

    try {
      wsRef.current.send(JSON.stringify(msg));
      updateStatus({ contract });
    } catch (e) {
      // Will retry on reconnect
    }
  }, [updateStatus]);

  const unsubscribe = useCallback((contract: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const msg = {
      type: 'unsubscribe_futures',
      contract,
    };

    try {
      wsRef.current.send(JSON.stringify(msg));
      if (statusRef.current.contract === contract) {
        updateStatus({ contract: null });
      }
    } catch (e) {
      // Ignore
    }
  }, [updateStatus]);

  // Staleness check
  useEffect(() => {
    const checkStale = () => {
      if (!mountedRef.current) return;

      const lastMsg = statusRef.current.lastMessageAt;
      const now = Date.now();
      const isStale = lastMsg && now - lastMsg > STALE_THRESHOLD;

      if (statusRef.current.status === 'connected' && isStale) {
        updateStatus({ status: 'stale' });
        callbacksRef.current.onAvailabilityChange?.(false);
      } else if (statusRef.current.status === 'stale' && (!isStale || lastMsg === null)) {
        updateStatus({ status: 'connected' });
        callbacksRef.current.onAvailabilityChange?.(true);
      }
    };

    staleCheckTimerRef.current = setInterval(checkStale, HEARTBEAT_INTERVAL);
    return () => {
      if (staleCheckTimerRef.current) clearInterval(staleCheckTimerRef.current);
    };
  }, [updateStatus]);

  // Initial connect
  useEffect(() => {
    connect();
    return () => {
      mountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.close(1000);
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (staleCheckTimerRef.current) clearInterval(staleCheckTimerRef.current);
    };
  }, [connect]);

  return {
    status,
    subscribe,
    unsubscribe,
    isConnected: status.status === 'connected',
    isStale: status.status === 'stale',
    isReconnecting: status.status === 'reconnecting',
  };
}
