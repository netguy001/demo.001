import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Navbar from './Navbar';
import MarketTickerBar from './MarketTickerBar';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useLivePortfolio } from '../../hooks/useLivePortfolio';
import { useTheme } from '../../context/ThemeContext';
import { cn } from '../../utils/cn';
import { LS_SIDEBAR } from '../../utils/constants';

// Root font-size for rem-based scaling (Tailwind uses rem for text-sm, text-xs, etc.)
const FONT_SIZE_PX = { small: '14px', medium: '16px', large: '18px' };

/**
 * Root authenticated shell: sidebar + navbar + market ticker + page content.
 *
 * Layout grid (desktop):
 *   [Fixed Sidebar 240/72px] [Main: Navbar 56px / TickerBar 28px / Page]
 *
 * Terminal route: main area is overflow-hidden (no page scroll)
 * Other routes: main area is overflow-y-auto
 * Mobile: sidebar becomes a full-width overlay drawer; main content stays at 0 margin.
 */
export default function AppShell() {
    const location = useLocation();
    const { theme, prefs } = useTheme();

    // Detect terminal route for overflow control
    const isTerminal = location.pathname.startsWith('/terminal');

    // ── Apply font size on <html> so all rem-based sizes scale ──────────────
    useEffect(() => {
        const size = FONT_SIZE_PX[prefs?.fontSize] || '16px';
        document.documentElement.style.fontSize = size;
        return () => { document.documentElement.style.fontSize = ''; };
    }, [prefs?.fontSize]);

    // ── Mount WebSocket — always connected when authenticated ──────────────
    useWebSocket();

    // ── Global portfolio polling — keeps P&L updated even when WS is down ───
    useLivePortfolio();

    // ── Sidebar state — persisted to localStorage ─────────────────────────────
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        const stored = localStorage.getItem(LS_SIDEBAR);
        if (stored !== null) return stored === 'true';
        return true; // default collapsed
    });

    const toggle = () => {
        setSidebarCollapsed((prev) => {
            const next = !prev;
            localStorage.setItem(LS_SIDEBAR, String(next));
            return next;
        });
    };

    // Auto-close sidebar on mobile when navigating
    useEffect(() => {
        if (window.innerWidth < 1024) {
            setSidebarCollapsed(true);
            localStorage.setItem(LS_SIDEBAR, 'true');
        }
    }, [location.pathname]);

    return (
        <div className={cn(
            'h-screen bg-[var(--bg-base)] flex overflow-hidden',
            theme,
            `accent-${prefs?.accentColor || 'cyan'}`,
            prefs?.animationsEnabled === false && 'ui-no-animations',
        )}>
            <Sidebar
                collapsed={sidebarCollapsed}
                onToggle={toggle}
            />

            <div
                className={cn(
                    'flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden',
                    sidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-[240px]'
                )}
            >
                <Navbar onMenuToggle={toggle} />
                <MarketTickerBar />

                {/* Page content — terminal gets no overflow (grid handles it) */}
                <main className={cn(
                    'flex-1 min-h-0',
                    isTerminal ? 'overflow-hidden' : 'overflow-y-auto'
                )}>
                    <Outlet />
                </main>
            </div>

            {/* Portal target for popups/menus — inside themed container so CSS vars apply */}
            <div id="portal-root" />
        </div>
    );
}
