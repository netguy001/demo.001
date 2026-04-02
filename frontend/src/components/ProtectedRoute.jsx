import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/useAuthStore';

/**
 * requireOnboarding — when true, user must have completed broker
 * setup before accessing the wrapped route. Otherwise they are
 * redirected to /dashboard (demo mode auto-onboards).
 */
export default function ProtectedRoute({ children, requireOnboarding = false }) {
    const user = useAuthStore((s) => s.user);
    const initializing = useAuthStore((s) => s.initializing);

    // Fast path: if we have a cached user in localStorage, skip the spinner
    // entirely to prevent the flash. Firebase will validate in the background.
    const hasCachedUser = !user && initializing && (() => {
        try { return !!localStorage.getItem('alphasync_user'); } catch { return false; }
    })();

    if (initializing && !hasCachedUser) {
        // Use the same spinner style as PageSkeleton to prevent visual jump
        return (
            <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base, #0f0f1e)' }}>
                <div className="w-10 h-10 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(6,182,212,0.3)', borderTopColor: '#06b6d4' }} />
            </div>
        );
    }

    if (!user && !hasCachedUser) {
        return <Navigate to="/login" replace />;
    }

    // For dashboard/app routes, ensure onboarding is complete
    if (requireOnboarding) {
        const status = (user?.account_status || 'active').toLowerCase();
        const isActive = status === 'active' && user?.is_active !== false;
        if (!isActive) {
            return <Navigate to="/account-status" replace />;
        }

        const onboarded = localStorage.getItem('alphasync_onboarded');
        if (!onboarded) {
            const tradingMode = localStorage.getItem('alphasync_trading_mode');
            if (tradingMode === 'demo') {
                localStorage.setItem('alphasync_onboarded', '1');
            } else if (tradingMode === 'live') {
                return <Navigate to="/select-broker" replace />;
            } else {
                localStorage.setItem('alphasync_trading_mode', 'demo');
                localStorage.setItem('alphasync_onboarded', '1');
            }
        }
    }

    return children;
}
