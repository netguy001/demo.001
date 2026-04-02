import api from './api';

const ADMIN_SESSION_STORAGE_KEY = 'alphasync_admin_session';

export function getAdminSessionToken() {
    try {
        return sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
    } catch {
        return null;
    }
}

export function setAdminSessionToken(token) {
    if (!token) return;
    try {
        sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, token);
    } catch {
    }
}

export function clearAdminSessionToken() {
    try {
        sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
    } catch {
    }
}

function withAdminSession(config = {}) {
    const token = getAdminSessionToken();
    const headers = { ...(config.headers || {}) };

    if (token) {
        headers['X-Admin-Session'] = token;
    }

    return {
        ...config,
        headers,
    };
}

function safeUserId(userId) {
    return encodeURIComponent(String(userId || ''));
}

const adminApi = {
    // ── 2FA Auth ────────────────────────────────────────────────────
    getTwoFactorStatus() {
        return api.get('/admin/auth/status');
    },

    setupTwoFactor() {
        return api.post('/admin/auth/setup-2fa');
    },

    enableTwoFactor(code) {
        return api.post('/admin/auth/enable-2fa', { code });
    },

    verifyTwoFactor(code) {
        return api.post('/admin/auth/verify-2fa', { code });
    },

    validateSession() {
        return api.post('/admin/auth/validate-session', {}, withAdminSession());
    },

    // ── Dashboard ───────────────────────────────────────────────────
    getDashboardStats() {
        return api.get('/admin/dashboard/stats', withAdminSession());
    },

    // ── User Management ─────────────────────────────────────────────
    listUsers(params = {}) {
        return api.get('/admin/users', withAdminSession({ params }));
    },

    getUserDetail(userId) {
        return api.get(`/admin/users/${safeUserId(userId)}`, withAdminSession());
    },

    approveUser(userId, durationDays) {
        return api.post(
            `/admin/users/${safeUserId(userId)}/approve`,
            { duration_days: durationDays },
            withAdminSession()
        );
    },

    deactivateUser(userId, reason, totpCode) {
        return api.post(
            `/admin/users/${safeUserId(userId)}/deactivate`,
            { reason, totp_code: totpCode },
            withAdminSession()
        );
    },

    reactivateUser(userId, durationDays) {
        return api.post(
            `/admin/users/${safeUserId(userId)}/reactivate`,
            { duration_days: durationDays },
            withAdminSession()
        );
    },

    setDuration(userId, durationDays) {
        return api.post(
            `/admin/users/${safeUserId(userId)}/set-duration`,
            { duration_days: durationDays },
            withAdminSession()
        );
    },

    // ── Admin Management (root only) ────────────────────────────────
    listAdmins() {
        return api.get('/admin/admins', withAdminSession());
    },

    promoteToAdmin(email, adminLevel = 'manage') {
        return api.post('/admin/admins/promote', { email, admin_level: adminLevel }, withAdminSession());
    },

    updateAdminLevel(adminId, adminLevel) {
        return api.patch(`/admin/admins/${safeUserId(adminId)}/level`, { admin_level: adminLevel }, withAdminSession());
    },

    revokeAdmin(adminId) {
        return api.delete(`/admin/admins/${safeUserId(adminId)}`, withAdminSession());
    },

    // ── Audit Log ───────────────────────────────────────────────────
    getAuditLog(params = {}) {
        return api.get('/admin/audit-log', withAdminSession({ params }));
    },
};

export default adminApi;
