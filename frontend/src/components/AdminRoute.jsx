import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/useAuthStore';

export default function AdminRoute({ children }) {
    const user = useAuthStore((s) => s.user);
    const initializing = useAuthStore((s) => s.initializing);

    if (initializing) {
        return (
            <div className="min-h-screen flex items-center justify-center" style={{ background: '#0b1020' }}>
                <div
                    className="w-10 h-10 border-2 rounded-full animate-spin"
                    style={{ borderColor: 'rgba(56,189,248,0.35)', borderTopColor: '#38bdf8' }}
                />
            </div>
        );
    }

    if (!user || user.role !== 'admin') {
        return <Navigate to="/admin" replace />;
    }

    return children;
}
