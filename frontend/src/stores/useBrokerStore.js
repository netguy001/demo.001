import { create } from 'zustand';
import api from '../services/api';

/**
 * Broker connection store.
 *
 * Tracks whether the user has an active broker session and provides
 * actions to initiate OAuth, handle callback, disconnect, and poll status.
 */
export const useBrokerStore = create((set, get) => ({
    /** @type {'disconnected'|'connecting'|'connected'|'expired'} */
    status: 'disconnected',

    /** Zebu broker user ID (e.g. "FA12345") */
    brokerUserId: null,

    /** ISO timestamp when token expires */
    tokenExpiry: null,

    /** True while an API call is in-flight */
    loading: false,

    /** Last error message */
    error: null,

    // ─── Actions ──────────────────────────────────────────────────

    /**
     * Initiate Zebu OAuth — returns the redirect URL.
     * Frontend should then do `window.location.href = url`.
     */
    connect: async () => {
        set({ loading: true, error: null });
        try {
            const res = await api.get('/broker/zebu/connect');
            set({ status: 'connecting', loading: false });
            return res.data; // { redirect_url, state }
        } catch (err) {
            const msg = err.response?.data?.detail || 'Failed to initiate broker connection';
            set({ loading: false, error: msg });
            throw new Error(msg);
        }
    },

    /**
     * Exchange OAuth callback params for a stored token.
     * Called from BrokerCallbackPage after Zebu redirects back.
     *
     * @param {string} authCode - auth_code or susertoken from Zebu redirect
     * @param {string} state    - OAuth state token
     * @param {object} extra    - { susertoken, uid, actid } from Zebu redirect params
     */
    handleCallback: async (authCode, state, extra = {}) => {
        set({ loading: true, error: null });
        try {
            const res = await api.post('/broker/zebu/callback', {
                auth_code: authCode,
                state,
                susertoken: extra.susertoken || '',
                uid: extra.uid || '',
                actid: extra.actid || '',
            });
            set({
                status: 'connected',
                brokerUserId: res.data.broker_user_id,
                loading: false,
            });
            return res.data;
        } catch (err) {
            const msg = err.response?.data?.detail || 'Broker callback failed';
            set({ status: 'disconnected', loading: false, error: msg });
            throw new Error(msg);
        }
    },

    /**
     * Disconnect the broker connection.
     */
    disconnect: async () => {
        set({ loading: true, error: null });
        try {
            await api.delete('/broker/zebu/disconnect');
            set({
                status: 'disconnected',
                brokerUserId: null,
                tokenExpiry: null,
                loading: false,
            });
        } catch (err) {
            const msg = err.response?.data?.detail || 'Disconnect failed';
            set({ loading: false, error: msg });
        }
    },

    /**
     * Direct Zebu login via QuickAuth API.
     * Use when vendor SSO redirect is unavailable.
     *
     * @param {string} zebuUserId - Zebu account User ID
     * @param {string} password   - Zebu password (sent to backend, hashed server-side)
     * @param {string} totp       - TOTP / 2FA code (optional)
     * @param {string} apiKey     - API Key from MYNT portal (required)
     * @param {string} vendorCode - Vendor code (optional, defaults to user ID)
     */
    login: async (zebuUserId, password, factor2 = '', apiKey = '', vendorCode = '') => {
        set({ loading: true, error: null });
        try {
            const res = await api.post('/broker/zebu/login', {
                zebu_user_id: zebuUserId,
                password,
                factor2,
                api_key: apiKey,
                vendor_code: vendorCode || undefined,
            });
            set({
                status: 'connected',
                brokerUserId: res.data.broker_user_id,
                loading: false,
            });
            return res.data;
        } catch (err) {
            const msg = err.response?.data?.detail || 'Zebu login failed';
            set({ status: 'disconnected', loading: false, error: msg });
            throw new Error(msg);
        }
    },

    /**
     * Fetch current broker status from backend.
     * Call this on app mount / dashboard load.
     */
    fetchStatus: async () => {
        try {
            const res = await api.get('/broker/status', { params: { broker: 'zebu' } });
            const d = res.data;
            set({
                status: d.connected ? 'connected' : d.is_expired ? 'expired' : 'disconnected',
                brokerUserId: d.broker_user_id || null,
                tokenExpiry: d.token_expiry || null,
            });
        } catch {
            // silent — status check is non-critical
        }
    },

    /**
     * Dev helper: manually inject a session token.
     */
    manualToken: async (sessionToken, brokerUserId = '', uid = '') => {
        set({ loading: true, error: null });
        try {
            const res = await api.post('/broker/zebu/manual-token', {
                session_token: sessionToken,
                broker_user_id: brokerUserId,
                uid,
            });
            set({ status: 'connected', brokerUserId: res.data.broker_user_id, loading: false });
            return res.data;
        } catch (err) {
            const msg = err.response?.data?.detail || 'Manual token failed';
            set({ loading: false, error: msg });
            throw new Error(msg);
        }
    },
}));
