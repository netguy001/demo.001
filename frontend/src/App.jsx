import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { ThemeProvider } from './context/ThemeContext';
import AppShell from './components/layout/AppShell';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuthStore } from './stores/useAuthStore';

// ── Eagerly loaded (prevents flash on refresh) ───────────────────────────────
import LoginPage from './pages/LoginPage';
import PortfolioPage from './pages/PortfolioPage';
import MarketPage from './pages/MarketPage';
import OrdersPage from './pages/OrdersPage';
import FuturesPage from './pages/FuturesPage';
import CommoditiesPage from './pages/CommoditiesPage';
import AlgoTradingPage from './pages/AlgoTradingPage';
import ZeroLossPage from './pages/ZeroLossPage';
import SettingsPage from './pages/SettingsPage';
import DashboardWorkspace from './workspaces/DashboardWorkspace';
import TradingWorkspace from './workspaces/TradingWorkspace';
import BrokerSelectPage from './pages/BrokerSelectPage';
import BrokerCallbackPage from './pages/BrokerCallbackPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import AccountStatusPage from './pages/AccountStatusPage';
import AdminAccessPage from './pages/AdminAccessPage';
import AdminPanelPage from './pages/AdminPanelPage';

export default function App() {
    useEffect(() => {
        const unsubscribe = useAuthStore.getState().initAuth();
        return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
    }, []);

    return (
        <ThemeProvider>
            <BrowserRouter>
                <ErrorBoundary fallback="Something went wrong while loading this page.">
                    <Routes>
                        {/* ── Public ── */}
                        <Route path="/" element={<LoginPage />} />
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/register" element={<LoginPage />} />
                        <Route path="/verify-email" element={<VerifyEmailPage />} />
                        <Route path="/admin" element={<AdminAccessPage />} />
                        <Route path="/admin/panel" element={
                            <AdminRoute><AdminPanelPage /></AdminRoute>
                        } />

                        <Route path="/account-status" element={
                            <ProtectedRoute><AccountStatusPage /></ProtectedRoute>
                        } />

                        {/* ── Protected (mode/broker select, no AppShell) ── */}
                        <Route path="/select-mode" element={<Navigate to="/dashboard" replace />} />
                        <Route path="/select-broker" element={
                            <ProtectedRoute><BrokerSelectPage /></ProtectedRoute>
                        } />
                        <Route path="/broker/callback" element={
                            <ProtectedRoute><BrokerCallbackPage /></ProtectedRoute>
                        } />

                        {/* ── Protected (inside AppShell — requires onboarding) ── */}
                        <Route
                            element={
                                <ProtectedRoute requireOnboarding>
                                    <AppShell />
                                </ProtectedRoute>
                            }
                        >
                            <Route path="/dashboard" element={<DashboardWorkspace />} />
                            <Route path="/terminal" element={<TradingWorkspace />} />
                            <Route path="/market" element={<MarketPage />} />
                            <Route path="/futures" element={<FuturesPage />} />
                            <Route path="/commodities" element={<CommoditiesPage />} />
                            <Route path="/portfolio" element={<PortfolioPage />} />
                            <Route path="/orders" element={<OrdersPage />} />
                            <Route path="/algo" element={<AlgoTradingPage />} />
                            <Route path="/zeroloss" element={<ZeroLossPage />} />
                            <Route path="/settings" element={<SettingsPage />} />
                        </Route>

                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </ErrorBoundary>
            </BrowserRouter>

            <Toaster
                position="bottom-right"
                toastOptions={{
                    duration: 4000,
                    style: {
                        background: 'rgb(var(--surface-700))',
                        color: 'rgb(var(--c-heading))',
                        border: '1px solid rgb(var(--c-edge) / 0.08)',
                        fontSize: '14px',
                        borderRadius: '10px',
                    },
                    success: { iconTheme: { primary: '#22c55e', secondary: '#fff' } },
                    error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
                }}
            />
        </ThemeProvider>
    );
}
