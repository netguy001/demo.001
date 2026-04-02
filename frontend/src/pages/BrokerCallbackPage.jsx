import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBrokerStore } from '../stores/useBrokerStore';
import toast from 'react-hot-toast';

/**
 * BrokerCallbackPage — handles the OAuth redirect from Zebu.
 *
 * URL pattern: /broker/callback?code=<auth_code>&state=<state>
 *
 * Flow:
 *   1. Zebu redirects browser here after successful login.
 *   2. We extract `code` + `state` from query params.
 *   3. POST them to /api/broker/zebu/callback.
 *   4. On success → navigate to /dashboard.
 *   5. On failure → show error and redirect to /select-broker.
 */
export default function BrokerCallbackPage() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [status, setStatus] = useState('processing');
    const handleCallback = useBrokerStore((s) => s.handleCallback);

    useEffect(() => {
        // Zebu redirect sends: susertoken, uid, actid, code/auth_code, state
        const susertoken = searchParams.get('susertoken') || '';
        const uid = searchParams.get('uid') || '';
        const actid = searchParams.get('actid') || '';
        const authCode = searchParams.get('code') || searchParams.get('auth_code') || susertoken;
        const state = searchParams.get('state') || '';

        if ((!authCode && !susertoken) || !state) {
            setStatus('error');
            toast.error('Invalid broker callback — missing parameters');
            setTimeout(() => navigate('/select-broker'), 2000);
            return;
        }

        let cancelled = false;

        (async () => {
            try {
                await handleCallback(authCode, state, { susertoken, uid, actid });
                if (cancelled) return;
                setStatus('success');
                toast.success('Broker connected successfully!');
                localStorage.setItem('alphasync_onboarded', '1');
                setTimeout(() => navigate('/dashboard'), 1200);
            } catch (err) {
                if (cancelled) return;
                setStatus('error');
                toast.error(err.message || 'Broker connection failed');
                setTimeout(() => navigate('/select-broker'), 2500);
            }
        })();

        return () => { cancelled = true; };
    }, [searchParams, handleCallback, navigate]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-surface-950">
            <div className="text-center space-y-4">
                {status === 'processing' && (
                    <>
                        <div className="w-12 h-12 mx-auto border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                        <p className="text-gray-500 text-sm">Connecting your broker account...</p>
                    </>
                )}
                {status === 'success' && (
                    <>
                        <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/20 flex items-center justify-center">
                            <svg className="w-6 h-6 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <p className="text-heading text-sm font-medium">Broker connected!</p>
                        <p className="text-gray-500 text-xs">Redirecting to dashboard...</p>
                    </>
                )}
                {status === 'error' && (
                    <>
                        <div className="w-12 h-12 mx-auto rounded-full bg-red-500/20 flex items-center justify-center">
                            <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </div>
                        <p className="text-heading text-sm font-medium">Connection failed</p>
                        <p className="text-gray-500 text-xs">Redirecting back...</p>
                    </>
                )}
            </div>
        </div>
    );
}
