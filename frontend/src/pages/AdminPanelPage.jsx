import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import {
    Shield, Users, Clock, UserCheck, UserX, RefreshCw, LogOut,
    Search, ChevronLeft, ChevronRight, AlertTriangle, Loader2,
    KeyRound, CheckCircle2, XCircle, Activity, Eye, X,
    Crown, UserPlus, Settings2, Trash2, ShieldCheck, EyeOff
} from 'lucide-react';

import { useAuthStore } from '../stores/useAuthStore';
import adminApi, {
    clearAdminSessionToken,
    getAdminSessionToken,
    setAdminSessionToken,
} from '../services/adminApi';

const DEFAULT_ACTION_STATE = { durationDays: 30, reason: '', totpCode: '' };

function parseApiError(error, fallback = 'Request failed') {
    return error?.response?.data?.detail || error?.message || fallback;
}

function safeDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
}

function statusTone(status) {
    switch ((status || '').toLowerCase()) {
        case 'active': return { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)', text: '#10b981' };
        case 'pending_approval': return { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', text: '#f59e0b' };
        case 'expired': return { bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.3)', text: '#f97316' };
        case 'deactivated': return { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', text: '#ef4444' };
        default: return { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', text: '#94a3b8' };
    }
}

const LEVEL_COLORS = {
    root: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', text: '#f59e0b', icon: Crown },
    manage: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)', text: '#10b981', icon: ShieldCheck },
    view_only: { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', text: '#94a3b8', icon: EyeOff },
};

function StatusPill({ status }) {
    const tone = statusTone(status);
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider whitespace-nowrap"
            style={{ background: tone.bg, border: `1px solid ${tone.border}`, color: tone.text }}>
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tone.text }} />
            {(status || 'unknown').replace('_', ' ')}
        </span>
    );
}

function LevelPill({ level }) {
    const cfg = LEVEL_COLORS[level] || LEVEL_COLORS.view_only;
    const Icon = cfg.icon;
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider whitespace-nowrap"
            style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.text }}>
            <Icon size={12} />
            {(level || 'unknown').replace('_', ' ')}
        </span>
    );
}

function StatCard({ icon: Icon, label, value, color }) {
    return (
        <div className="glass-card p-5 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: color || 'var(--brand)' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
            </div>
            <div className="text-3xl font-extrabold font-mono" style={{ color: color || 'var(--text-primary)' }}>{value}</div>
        </div>
    );
}

/* ── Manage User Modal ─────────────────────────────────────────────── */
function ManageUserModal({ user: selectedUser, userDetail, detailLoading, actionState, setActionState, onAction, onClose, actionLoading }) {
    if (!selectedUser) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl animate-slide-up"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
                onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--brand-glow)' }}>
                            <UserCheck size={20} style={{ color: 'var(--brand)' }} />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>Manage User</h2>
                            <p className="text-sm truncate" style={{ color: 'var(--text-secondary)' }}>{selectedUser.email}</p>
                        </div>
                    </div>
                    <button className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
                        style={{ color: 'var(--text-muted)' }} onClick={onClose}><X size={18} /></button>
                </div>
                <div className="p-5 flex flex-col gap-5">
                    {/* ── Identity ── */}
                    <div>
                        <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Identity &amp; Contact</div>
                        <div className="grid grid-cols-2 gap-3">
                            {[
                                { label: 'Full Name', content: <span className="text-sm font-medium">{selectedUser.full_name || '—'}</span> },
                                { label: 'Username', content: <span className="text-sm font-mono">{selectedUser.username || '—'}</span> },
                                { label: 'Email / Gmail', content: <span className="text-sm break-all">{selectedUser.email}</span> },
                                { label: 'Mobile Number', content: selectedUser.phone
                                    ? <span className="text-sm font-mono font-semibold" style={{ color: '#10b981' }}>{selectedUser.phone}</span>
                                    : <span className="text-sm font-semibold" style={{ color: '#f59e0b' }}>⚠ Not set</span> },
                                { label: 'Auth Provider', content: <span className="text-sm">{selectedUser.auth_provider === 'google.com' ? '🔵 Google OAuth' : selectedUser.auth_provider === 'password' ? '🔑 Email / Password' : (selectedUser.auth_provider || '—')}</span> },
                                { label: 'Email Verified', content: selectedUser.is_verified
                                    ? <span className="flex items-center gap-1 font-semibold text-sm" style={{ color: '#10b981' }}><CheckCircle2 size={13} /> Verified</span>
                                    : <span className="flex items-center gap-1 font-semibold text-sm" style={{ color: '#ef4444' }}><XCircle size={13} /> Unverified</span> },
                            ].map(({ label, content }) => (
                                <div key={label} className="p-3 rounded-xl" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                                    <div className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
                                    {content}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* ── Account Status ── */}
                    <div>
                        <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Account Status &amp; Dates</div>
                        <div className="grid grid-cols-2 gap-3">
                            {[
                                { label: 'Status', content: <StatusPill status={selectedUser.account_status} /> },
                                { label: 'Active', content: selectedUser.is_active
                                    ? <span className="flex items-center gap-1.5 font-semibold text-sm" style={{ color: '#10b981' }}><CheckCircle2 size={14} /> Yes</span>
                                    : <span className="flex items-center gap-1.5 font-semibold text-sm" style={{ color: '#ef4444' }}><XCircle size={14} /> No</span> },
                                { label: 'Registered On', content: <span className="text-xs font-mono">{safeDate(selectedUser.created_at)}</span> },
                                { label: 'Last Updated', content: <span className="text-xs font-mono">{safeDate(selectedUser.updated_at)}</span> },
                                { label: 'Access Expires', content: <span className="text-xs font-mono">{safeDate(selectedUser.access_expires_at)}</span> },
                                { label: 'Approved At', content: <span className="text-xs font-mono">{safeDate(selectedUser.approved_at)}</span> },
                            ].map(({ label, content }) => (
                                <div key={label} className="p-3 rounded-xl" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                                    <div className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
                                    {content}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className="label-text">Duration (days)</label>
                            <input className="input-field" type="number" min={1} max={365} value={actionState.durationDays}
                                onChange={(e) => setActionState((p) => ({ ...p, durationDays: Number(e.target.value || 1) }))} />
                        </div>
                        <div>
                            <label className="label-text">Deactivation Reason</label>
                            <input className="input-field" value={actionState.reason} placeholder="Optional reason" maxLength={500}
                                onChange={(e) => setActionState((p) => ({ ...p, reason: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label-text">TOTP For Deactivate</label>
                            <input className="input-field" value={actionState.totpCode} placeholder="Required to deactivate" inputMode="numeric"
                                onChange={(e) => setActionState((p) => ({ ...p, totpCode: e.target.value.replace(/\D/g, '').slice(0, 8) }))} />
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                        <button className="btn-primary flex items-center gap-2 text-sm" disabled={actionLoading} onClick={() => onAction('approve')}>
                            {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />} Approve</button>
                        <button className="btn-primary flex items-center gap-2 text-sm" disabled={actionLoading} onClick={() => onAction('reactivate')}>
                            {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Reactivate</button>
                        <button className="btn-secondary flex items-center gap-2 text-sm" disabled={actionLoading} onClick={() => onAction('set-duration')}>
                            {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />} Update Duration</button>
                        <button className="flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-full transition-all"
                            style={{ background: actionLoading ? '#6b7280' : 'linear-gradient(135deg, #ef4444, #b91c1c)', color: '#fff', opacity: actionLoading ? 0.6 : 1 }}
                            disabled={actionLoading} onClick={() => onAction('deactivate')}>
                            {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />} Deactivate</button>
                    </div>
                    <div className="rounded-xl p-4" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                        <h3 className="text-sm font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <Activity size={14} style={{ color: 'var(--brand)' }} /> Detail Snapshot
                        </h3>
                        {detailLoading ? (
                            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}><Loader2 size={14} className="animate-spin" /> Loading...</div>
                        ) : userDetail ? (
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                {[
                                    { label: 'Portfolio Value', value: userDetail.portfolio?.current_value != null ? `₹${Number(userDetail.portfolio.current_value).toLocaleString()}` : '—' },
                                    { label: 'Capital', value: userDetail.portfolio?.available_capital != null ? `₹${Number(userDetail.portfolio.available_capital).toLocaleString()}` : '—' },
                                    { label: 'Holdings', value: userDetail.holdings?.length || 0 },
                                    { label: 'Orders', value: userDetail.recent_orders?.length || 0 },
                                ].map(({ label, value }) => (
                                    <div key={label}>
                                        <div className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
                                        <div className="font-mono font-semibold text-sm">{value}</div>
                                    </div>
                                ))}
                            </div>
                        ) : <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No details available.</div>}
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ── Admin Management Modal (Root Only) ────────────────────────────── */
function AdminManagementModal({ admins, adminsLoading, onClose, onPromote, onUpdateLevel, onRevoke }) {
    const [promoteEmail, setPromoteEmail] = useState('');
    const [promoteLevel, setPromoteLevel] = useState('manage');
    const [promoting, setPromoting] = useState(false);

    async function handlePromote() {
        if (!promoteEmail.trim()) { toast.error('Enter an email address'); return; }
        setPromoting(true);
        try {
            await onPromote(promoteEmail.trim(), promoteLevel);
            setPromoteEmail('');
            setPromoteLevel('manage');
        } finally {
            setPromoting(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
            <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl animate-slide-up"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
                onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(245,158,11,0.12)' }}>
                            <Crown size={20} style={{ color: '#f59e0b' }} />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Admin Management</h2>
                            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Create, update, and revoke admin access</p>
                        </div>
                    </div>
                    <button className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                        style={{ color: 'var(--text-muted)' }} onClick={onClose}><X size={18} /></button>
                </div>

                <div className="p-5 flex flex-col gap-5">
                    {/* Add New Admin */}
                    <div className="rounded-xl p-4" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                        <h3 className="text-sm font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <UserPlus size={14} style={{ color: 'var(--brand)' }} /> Add New Admin
                        </h3>
                        <div className="flex flex-wrap gap-3 items-end">
                            <div className="flex-1 min-w-[200px]">
                                <label className="label-text">User Email</label>
                                <input className="input-field" value={promoteEmail} placeholder="user@example.com"
                                    onChange={(e) => setPromoteEmail(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handlePromote()} />
                            </div>
                            <div className="w-[160px]">
                                <label className="label-text">Permission Level</label>
                                <select className="input-field" value={promoteLevel} onChange={(e) => setPromoteLevel(e.target.value)}>
                                    <option value="manage">Manage</option>
                                    <option value="view_only">View Only</option>
                                </select>
                            </div>
                            <button className="btn-primary flex items-center gap-2" onClick={handlePromote} disabled={promoting}>
                                {promoting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                                Add Admin
                            </button>
                        </div>
                    </div>

                    {/* Admin List */}
                    <div>
                        <h3 className="text-sm font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <Shield size={14} style={{ color: 'var(--brand)' }} /> Current Admins
                        </h3>
                        {adminsLoading ? (
                            <div className="flex items-center gap-2 text-sm py-4" style={{ color: 'var(--text-muted)' }}>
                                <Loader2 size={14} className="animate-spin" /> Loading admins...
                            </div>
                        ) : admins.length === 0 ? (
                            <div className="text-sm py-4" style={{ color: 'var(--text-muted)' }}>No admins found.</div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {admins.map((a) => (
                                    <div key={a.id} className="flex items-center justify-between gap-3 p-3 rounded-xl transition-colors"
                                        style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                                                style={{ background: a.is_root ? 'rgba(245,158,11,0.12)' : 'var(--brand-glow)' }}>
                                                {a.is_root ? <Crown size={16} style={{ color: '#f59e0b' }} /> : <Shield size={16} style={{ color: 'var(--brand)' }} />}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium truncate">{a.full_name || a.username}</div>
                                                <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{a.email}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-shrink-0">
                                            <LevelPill level={a.effective_level} />
                                            {!a.is_root && (
                                                <div className="flex gap-1">
                                                    <select
                                                        className="text-xs px-2 py-1 rounded-lg"
                                                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                                        value={a.effective_level}
                                                        onChange={(e) => onUpdateLevel(a.id, e.target.value)}
                                                    >
                                                        <option value="manage">Manage</option>
                                                        <option value="view_only">View Only</option>
                                                    </select>
                                                    <button
                                                        className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
                                                        style={{ color: '#ef4444', background: 'rgba(239,68,68,0.1)' }}
                                                        title="Revoke admin access"
                                                        onClick={() => {
                                                            if (window.confirm(`Revoke admin access for ${a.email}?`)) {
                                                                onRevoke(a.id);
                                                            }
                                                        }}
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            )}
                                            {a.is_root && (
                                                <span className="text-xs px-2 py-1 rounded-lg" style={{ color: 'var(--text-muted)' }}>Protected</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ── 2FA Setup ─────────────────────────────────────────────────────── */
function AdminAuthSetup({ setupLoading, setupPayload, authCode, setAuthCode, onGenerate, onEnable }) {
    return (
        <section className="glass-card p-6 max-w-3xl animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--brand-glow)' }}>
                    <KeyRound size={20} style={{ color: 'var(--brand)' }} />
                </div>
                <div>
                    <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Admin 2FA Setup</h2>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Scan the secret in your authenticator app and verify to activate.</p>
                </div>
            </div>
            {!setupPayload ? (
                <button className="btn-primary" onClick={onGenerate} disabled={setupLoading}>
                    {setupLoading ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Generating...</span> : 'Generate 2FA Secret'}
                </button>
            ) : (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div>
                            <label className="label-text">Manual Secret</label>
                            <div className="input-field font-mono text-sm break-all" style={{ height: 'auto', minHeight: 48 }}>{setupPayload.secret}</div>
                        </div>
                        <div>
                            <label className="label-text">Provisioning URI</label>
                            <textarea readOnly value={setupPayload.uri} className="input-field font-mono text-xs" style={{ height: 'auto', minHeight: 92, resize: 'vertical' }} />
                        </div>
                    </div>
                    <div className="flex gap-3 items-center flex-wrap">
                        <input value={authCode} onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                            placeholder="Enter 6-digit code" className="input-field max-w-[200px]" inputMode="numeric" />
                        <button className="btn-primary" onClick={onEnable} disabled={setupLoading}>
                            {setupLoading ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Verifying...</span> : 'Enable 2FA'}
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}

/* ── 2FA Verify ────────────────────────────────────────────────────── */
function AdminAuthVerify({ verifyLoading, authCode, setAuthCode, onVerify }) {
    return (
        <section className="glass-card p-6 max-w-xl animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--brand-glow)' }}>
                    <Shield size={20} style={{ color: 'var(--brand)' }} />
                </div>
                <div>
                    <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Admin 2FA Verification</h2>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Enter a fresh authenticator code to open a secure admin session.</p>
                </div>
            </div>
            <div className="flex gap-3 items-center flex-wrap">
                <input value={authCode} onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="Enter 6-digit code" className="input-field max-w-[200px]" inputMode="numeric"
                    onKeyDown={(e) => e.key === 'Enter' && onVerify()} />
                <button className="btn-primary" onClick={onVerify} disabled={verifyLoading}>
                    {verifyLoading ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Verifying...</span> : 'Verify & Enter'}
                </button>
            </div>
        </section>
    );
}

/* ══════════════════════════════════════════════════════════════════════
   Main Admin Panel
   ══════════════════════════════════════════════════════════════════════ */
export default function AdminPanelPage() {
    const navigate = useNavigate();
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);

    const [bootstrapping, setBootstrapping] = useState(true);
    const [authStage, setAuthStage] = useState('verify');
    const [setupPayload, setSetupPayload] = useState(null);
    const [setupLoading, setSetupLoading] = useState(false);
    const [verifyLoading, setVerifyLoading] = useState(false);
    const [authCode, setAuthCode] = useState('');
    const [adminLevel, setAdminLevel] = useState('manage');

    const [stats, setStats] = useState(null);
    const [usersData, setUsersData] = useState({ users: [], total: 0, page: 1, per_page: 25, total_pages: 1 });
    const [usersLoading, setUsersLoading] = useState(false);
    const [filters, setFilters] = useState({ status: '', search: '', page: 1, perPage: 25 });
    const [draftFilters, setDraftFilters] = useState({ status: '', search: '' });

    const [modalUserId, setModalUserId] = useState(null);
    const [selectedUserDetail, setSelectedUserDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [actionState, setActionState] = useState(DEFAULT_ACTION_STATE);

    const [auditData, setAuditData] = useState({ logs: [], total: 0 });
    const [auditLoading, setAuditLoading] = useState(false);

    // Admin management state (root only)
    const [showAdminModal, setShowAdminModal] = useState(false);
    const [adminsList, setAdminsList] = useState([]);
    const [adminsLoading, setAdminsLoading] = useState(false);
    const [auditOpen, setAuditOpen] = useState(false);

    const isRoot = adminLevel === 'root';
    const canManage = adminLevel === 'root' || adminLevel === 'manage';

    const modalUser = useMemo(
        () => usersData.users.find((u) => u.id === modalUserId) || null,
        [usersData.users, modalUserId]
    );

    const clearAdminSession = useCallback(() => { clearAdminSessionToken(); }, []);

    const resetToVerifyStage = useCallback((message = 'Admin session expired. Please verify 2FA again.') => {
        clearAdminSession();
        setAuthStage('verify');
        setSetupPayload(null);
        setAuthCode('');
        setModalUserId(null);
        setShowAdminModal(false);
        if (message) toast.error(message);
    }, [clearAdminSession]);

    const loadStats = useCallback(async () => {
        const { data } = await adminApi.getDashboardStats();
        setStats(data);
        if (data?.admin_level) setAdminLevel(data.admin_level);
    }, []);

    const loadUsers = useCallback(async () => {
        setUsersLoading(true);
        try {
            const { data } = await adminApi.listUsers({ status: filters.status || undefined, search: filters.search || undefined, page: filters.page, per_page: filters.perPage });
            setUsersData(data);
        } finally { setUsersLoading(false); }
    }, [filters.page, filters.perPage, filters.search, filters.status]);

    const loadAudit = useCallback(async () => {
        setAuditLoading(true);
        try {
            const { data } = await adminApi.getAuditLog({ page: 1, per_page: 25 });
            setAuditData(data || { logs: [], total: 0 });
        } finally { setAuditLoading(false); }
    }, []);

    const loadAdmins = useCallback(async () => {
        setAdminsLoading(true);
        try {
            const { data } = await adminApi.listAdmins();
            setAdminsList(data?.admins || []);
        } catch (err) {
            if (err?.response?.status === 403) return; // not root, ignore
            toast.error(parseApiError(err, 'Failed to load admins'));
        } finally { setAdminsLoading(false); }
    }, []);

    const loadSelectedUserDetail = useCallback(async (userId) => {
        if (!userId) return;
        setDetailLoading(true);
        try {
            const { data } = await adminApi.getUserDetail(userId);
            setSelectedUserDetail(data);
        } finally { setDetailLoading(false); }
    }, []);

    const refreshDashboard = useCallback(async () => {
        // Audit log is lazy — only refresh it if the section is currently open.
        const toLoad = [loadStats(), loadUsers()];
        if (auditOpen) toLoad.push(loadAudit());
        const results = await Promise.allSettled(toLoad);
        const failedSections = [];
        if (results[0]?.status === 'rejected') failedSections.push({ name: 'stats', reason: results[0]?.reason });
        if (results[1]?.status === 'rejected') failedSections.push({ name: 'users', reason: results[1]?.reason });
        if (failedSections.length) {
            const authFailed = failedSections.some((f) => [401, 403].includes(f?.reason?.response?.status));
            if (authFailed) { resetToVerifyStage(); return; }
            toast.error(`Failed to load: ${failedSections.map((f) => f.name).join(', ')}`);
        }
    }, [auditOpen, loadAudit, loadStats, loadUsers, resetToVerifyStage]);

    const bootstrapAdmin = useCallback(async () => {
        if (!user || user.role !== 'admin') { setBootstrapping(false); return; }
        setBootstrapping(true);
        try {
            const existingSession = getAdminSessionToken();
            if (existingSession) {
                try {
                    const { data } = await adminApi.validateSession();
                    if (data?.admin_level) setAdminLevel(data.admin_level);
                    setAuthStage('dashboard');
                    await refreshDashboard();
                    return;
                } catch { clearAdminSession(); }
            }
            const statusRes = await adminApi.getTwoFactorStatus();
            setAuthStage(statusRes?.data?.has_2fa ? 'verify' : 'setup');
        } catch (err) {
            toast.error(parseApiError(err, 'Failed to initialize admin access'));
            setAuthStage('verify');
        } finally { setBootstrapping(false); }
    }, [clearAdminSession, refreshDashboard, user]);

    useEffect(() => { bootstrapAdmin(); }, [bootstrapAdmin]);

    useEffect(() => {
        if (authStage === 'dashboard' && modalUserId) {
            loadSelectedUserDetail(modalUserId).catch((err) => {
                if ([401, 403].includes(err?.response?.status)) { resetToVerifyStage(); return; }
                toast.error(parseApiError(err, 'Failed to load user detail'));
            });
        } else { setSelectedUserDetail(null); }
    }, [authStage, loadSelectedUserDetail, resetToVerifyStage, modalUserId]);

    async function handleGenerateSetup() {
        setSetupLoading(true);
        try { const { data } = await adminApi.setupTwoFactor(); setSetupPayload(data); toast.success('2FA secret generated'); }
        catch (err) { toast.error(parseApiError(err, 'Failed to generate 2FA secret')); }
        finally { setSetupLoading(false); }
    }

    async function handleEnableTwoFactor() {
        if (authCode.length < 6) { toast.error('Enter a valid 2FA code'); return; }
        setSetupLoading(true);
        try { await adminApi.enableTwoFactor(authCode); setAuthCode(''); toast.success('2FA enabled. Verify to continue.'); setAuthStage('verify'); }
        catch (err) { toast.error(parseApiError(err, 'Failed to enable 2FA')); }
        finally { setSetupLoading(false); }
    }

    async function handleVerifySession() {
        if (authCode.length < 6) { toast.error('Enter a valid 2FA code'); return; }
        setVerifyLoading(true);
        try {
            const { data } = await adminApi.verifyTwoFactor(authCode);
            setAdminSessionToken(data?.session_token);
            setAuthCode('');
            setAuthStage('dashboard');
            await refreshDashboard();
            toast.success('Admin session verified');
        } catch (err) { toast.error(parseApiError(err, '2FA verification failed')); }
        finally { setVerifyLoading(false); }
    }

    function openManageModal(userId) { setModalUserId(userId); setActionState(DEFAULT_ACTION_STATE); }
    function closeManageModal() { setModalUserId(null); setSelectedUserDetail(null); setActionState(DEFAULT_ACTION_STATE); }

    const [actionLoading, setActionLoading] = useState(false);

    async function runUserAction(actionName) {
        if (!modalUser) { toast.error('Select a user first'); return; }
        if (actionLoading) return;
        const durationDays = Number(actionState.durationDays);
        setActionLoading(true);
        try {
            if (actionName === 'approve') { await adminApi.approveUser(modalUser.id, durationDays); toast.success('User approved'); }
            else if (actionName === 'reactivate') { await adminApi.reactivateUser(modalUser.id, durationDays); toast.success('User reactivated'); }
            else if (actionName === 'set-duration') { await adminApi.setDuration(modalUser.id, durationDays); toast.success('Duration updated'); }
            else if (actionName === 'deactivate') {
                if (actionState.totpCode.length < 6) { toast.error('TOTP code required'); setActionLoading(false); return; }
                await adminApi.deactivateUser(modalUser.id, actionState.reason?.trim() || null, actionState.totpCode);
                toast.success('User deactivated');
                setActionState((p) => ({ ...p, reason: '', totpCode: '' }));
            }
            await refreshDashboard();
            if (modalUserId) await loadSelectedUserDetail(modalUserId);
        } catch (err) {
            if ([401, 403].includes(err?.response?.status)) resetToVerifyStage('Session expired. Please verify 2FA again.');
            else toast.error(parseApiError(err, 'Action failed'));
        } finally {
            setActionLoading(false);
        }
    }

    // Admin management actions (root only)
    async function handlePromoteAdmin(email, level) {
        try {
            await adminApi.promoteToAdmin(email, level);
            toast.success(`${email} promoted to admin (${level})`);
            await loadAdmins();
        } catch (err) { toast.error(parseApiError(err, 'Failed to promote')); }
    }

    async function handleUpdateAdminLevel(adminId, newLevel) {
        try {
            await adminApi.updateAdminLevel(adminId, newLevel);
            toast.success('Admin level updated');
            await loadAdmins();
        } catch (err) { toast.error(parseApiError(err, 'Failed to update level')); }
    }

    async function handleRevokeAdmin(adminId) {
        try {
            await adminApi.revokeAdmin(adminId);
            toast.success('Admin access revoked');
            await loadAdmins();
        } catch (err) { toast.error(parseApiError(err, 'Failed to revoke')); }
    }

    function openAdminManagement() {
        setShowAdminModal(true);
        loadAdmins();
    }

    async function handleEndAdminSession() {
        clearAdminSession(); setAuthStage('verify'); setSetupPayload(null); setAuthCode(''); setModalUserId(null); setShowAdminModal(false);
        toast('Admin session ended');
    }

    async function handleSignOut() { clearAdminSession(); await logout(); navigate('/login', { replace: true }); }

    const statusOptions = [
        { label: 'All statuses', value: '' },
        { label: 'Pending Approval', value: 'pending_approval' },
        { label: 'Active', value: 'active' },
        { label: 'Expired', value: 'expired' },
        { label: 'Deactivated', value: 'deactivated' },
    ];

    if (bootstrapping) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: 'var(--bg-base)' }}>
                <Loader2 size={40} className="animate-spin" style={{ color: 'var(--brand)' }} />
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Preparing secure admin workspace...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen p-4 md:p-6 lg:p-8" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
            {/* Header */}
            <header className="flex flex-wrap justify-between items-center gap-4 mb-6">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Shield size={14} style={{ color: 'var(--brand)' }} />
                        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>AlphaSync Control Center</span>
                        {authStage === 'dashboard' && <LevelPill level={adminLevel} />}
                    </div>
                    <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Admin Panel</h1>
                    <div className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Signed in as {user?.email || 'admin'}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {authStage === 'dashboard' && isRoot && (
                        <button className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-full transition-all"
                            style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}
                            onClick={openAdminManagement}>
                            <Crown size={14} /> Manage Admins
                        </button>
                    )}
                    <button className="btn-secondary flex items-center gap-2 text-sm" onClick={() => refreshDashboard()}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                    <button className="btn-secondary flex items-center gap-2 text-sm" onClick={handleEndAdminSession}>
                        <Shield size={14} /> End Session
                    </button>
                    <button className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-full transition-all"
                        style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
                        onClick={handleSignOut}>
                        <LogOut size={14} /> Sign Out
                    </button>
                </div>
            </header>

            {authStage === 'setup' && <AdminAuthSetup setupLoading={setupLoading} setupPayload={setupPayload} authCode={authCode} setAuthCode={setAuthCode} onGenerate={handleGenerateSetup} onEnable={handleEnableTwoFactor} />}
            {authStage === 'verify' && <AdminAuthVerify verifyLoading={verifyLoading} authCode={authCode} setAuthCode={setAuthCode} onVerify={handleVerifySession} />}

            {authStage === 'dashboard' && (
                <div className="flex flex-col gap-5 animate-fade-in">
                    {/* View-only banner */}
                    {!canManage && (
                        <div className="glass-card p-4 flex items-center gap-3" style={{ borderColor: 'rgba(148,163,184,0.3)' }}>
                            <EyeOff size={18} style={{ color: 'var(--text-muted)' }} />
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                                You have <strong>view-only</strong> access. Contact the root admin for elevated permissions.
                            </span>
                        </div>
                    )}

                    {/* Stats Grid */}
                    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <StatCard icon={Users} label="Total Users" value={stats?.total_users ?? 0} />
                        <StatCard icon={Clock} label="Pending Approval" value={stats?.pending_approval ?? 0} color="#f59e0b" />
                        <StatCard icon={UserCheck} label="Active" value={stats?.active ?? 0} color="#10b981" />
                        <StatCard icon={AlertTriangle} label="Expired / Deactivated" value={(stats?.expired ?? 0) + (stats?.deactivated ?? 0)} color="#f97316" />
                    </section>

                    {/* User Accounts Table */}
                    <section className="glass-card p-5">
                        <div className="flex flex-wrap justify-between items-baseline gap-3 mb-4">
                            <div>
                                <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>User Accounts</h2>
                                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Full lifecycle control: approve, activate, deactivate, duration</p>
                            </div>
                            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{usersData.total} user{usersData.total !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="flex flex-wrap gap-3 mb-4 items-end">
                            <div className="relative flex-1 min-w-[200px]">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                                <input className="input-field pl-9" placeholder="Search email / username / name" value={draftFilters.search}
                                    onChange={(e) => setDraftFilters((p) => ({ ...p, search: e.target.value }))}
                                    onKeyDown={(e) => e.key === 'Enter' && setFilters((p) => ({ ...p, status: draftFilters.status, search: draftFilters.search, page: 1 }))} />
                            </div>
                            <select className="input-field w-auto min-w-[170px]" value={draftFilters.status}
                                onChange={(e) => setDraftFilters((p) => ({ ...p, status: e.target.value }))}>
                                {statusOptions.map((opt) => <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>)}
                            </select>
                            <button className="btn-primary flex items-center gap-2" disabled={usersLoading}
                                onClick={() => setFilters((p) => ({ ...p, status: draftFilters.status, search: draftFilters.search, page: 1 }))}>
                                {usersLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Apply
                            </button>
                        </div>
                        <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--border)' }}>
                            <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1020 }}>
                                <colgroup>
                                    <col style={{ width: '18%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} />
                                    <col style={{ width: '14%' }} /><col style={{ width: '10%' }} /><col style={{ width: '14%' }} />
                                    <col style={{ width: '12%' }} /><col style={{ width: '8%' }} />
                                </colgroup>
                                <thead>
                                    <tr style={{ background: 'var(--bg-muted)' }}>
                                        {['Email', 'Full Name', 'Mobile', 'Status', 'Provider', 'Registered', 'Expires', 'Action'].map((h) => (
                                            <th key={h} className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wider"
                                                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {usersData.users.length === 0 ? (
                                        <tr><td colSpan={8} className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>No non-admin users found yet.</td></tr>
                                    ) : usersData.users.map((u) => (
                                        <tr key={u.id} className="transition-colors" style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td className="px-3 py-3 text-xs font-medium truncate" title={u.email}>{u.email}</td>
                                            <td className="px-3 py-3 text-xs truncate" style={{ color: 'var(--text-secondary)' }} title={u.full_name || u.username}>{u.full_name || u.username || '—'}</td>
                                            <td className="px-3 py-3 text-xs font-mono truncate" style={{ color: u.phone ? 'var(--text-primary)' : '#ef4444' }}>
                                                {u.phone || <span style={{ color: '#f59e0b', fontStyle: 'italic' }}>Not set</span>}
                                            </td>
                                            <td className="px-3 py-3"><StatusPill status={u.account_status} /></td>
                                            <td className="px-3 py-3 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                                                {u.auth_provider === 'google.com' ? '🔵 Google' : u.auth_provider === 'password' ? '🔑 Email' : (u.auth_provider || '—')}
                                            </td>
                                            <td className="px-3 py-3 text-xs font-mono truncate" style={{ color: 'var(--text-secondary)' }}>{safeDate(u.created_at)}</td>
                                            <td className="px-3 py-3 text-xs font-mono truncate" style={{ color: 'var(--text-secondary)' }}>{safeDate(u.access_expires_at)}</td>
                                            <td className="px-3 py-3">
                                                {canManage ? (
                                                    <button className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-all"
                                                        style={{ background: 'var(--brand-glow)', color: 'var(--brand)', border: '1px solid rgba(0,188,212,0.2)' }}
                                                        onClick={() => openManageModal(u.id)}><Eye size={11} /> Manage</button>
                                                ) : (
                                                    <button className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-all"
                                                        style={{ background: 'rgba(148,163,184,0.08)', color: 'var(--text-muted)', border: '1px solid rgba(148,163,184,0.15)' }}
                                                        onClick={() => openManageModal(u.id)}><Eye size={11} /> View</button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="flex justify-between items-center mt-4">
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {usersData.page} of {Math.max(1, usersData.total_pages || 1)}</span>
                            <div className="flex gap-2">
                                <button className="btn-secondary flex items-center gap-1 text-xs px-3 py-1.5" style={{ height: 'auto' }}
                                    disabled={(usersData.page || 1) <= 1}
                                    onClick={() => setFilters((p) => ({ ...p, page: Math.max(1, p.page - 1) }))}><ChevronLeft size={14} /> Prev</button>
                                <button className="btn-secondary flex items-center gap-1 text-xs px-3 py-1.5" style={{ height: 'auto' }}
                                    disabled={(usersData.page || 1) >= Math.max(1, usersData.total_pages || 1)}
                                    onClick={() => setFilters((p) => ({ ...p, page: p.page + 1 }))}> Next <ChevronRight size={14} /></button>
                            </div>
                        </div>
                    </section>

                    {/* Audit Log — collapsible */}
                    <section className="glass-card overflow-hidden">
                        {/* ── Header / toggle ── */}
                        <button
                            className="w-full flex items-center justify-between p-5 text-left transition-colors"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                            onClick={() => {
                                const opening = !auditOpen;
                                setAuditOpen(opening);
                                if (opening && !auditData.logs?.length) loadAudit();
                            }}
                        >
                            <div>
                                <div className="flex items-center gap-2">
                                    <Activity size={16} style={{ color: 'var(--brand)' }} />
                                    <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Audit Log</h2>
                                    {auditData.total > 0 && (
                                        <span className="text-xs font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--brand-glow)', color: 'var(--brand)' }}>
                                            {auditData.total}
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Every admin action is recorded for accountability</p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                {auditOpen && (
                                    <button
                                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full"
                                        style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                                        onClick={(e) => { e.stopPropagation(); loadAudit(); }}
                                    >
                                        <RefreshCw size={11} /> Refresh
                                    </button>
                                )}
                                <div style={{
                                    width: 28, height: 28, borderRadius: 8,
                                    background: 'var(--bg-muted)', border: '1px solid var(--border)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    transition: 'transform .22s',
                                    transform: auditOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                }}>
                                    <ChevronLeft size={16} style={{ color: 'var(--text-muted)', transform: 'rotate(-90deg)' }} />
                                </div>
                            </div>
                        </button>

                        {/* ── Body (collapsed/expanded) ── */}
                        {auditOpen && (
                            <div style={{ borderTop: '1px solid var(--border)' }} className="p-5 pt-4">
                                {auditLoading ? (
                                    <div className="flex items-center gap-2 text-sm py-4" style={{ color: 'var(--text-muted)' }}>
                                        <Loader2 size={14} className="animate-spin" /> Loading audit log...
                                    </div>
                                ) : auditData.logs?.length ? (
                                    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--border)' }}>
                                        <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 680 }}>
                                            <colgroup>
                                                <col style={{ width: '22%' }} /><col style={{ width: '16%' }} /><col style={{ width: '20%' }} />
                                                <col style={{ width: '26%' }} /><col style={{ width: '16%' }} />
                                            </colgroup>
                                            <thead>
                                                <tr style={{ background: 'var(--bg-muted)' }}>
                                                    {['Time', 'Admin', 'Action', 'Target', 'IP'].map((h) => (
                                                        <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider"
                                                            style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {auditData.logs.map((log) => (
                                                    <tr key={log.id} className="transition-colors" style={{ borderBottom: '1px solid var(--border)' }}>
                                                        <td className="px-4 py-3 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{safeDate(log.created_at)}</td>
                                                        <td className="px-4 py-3 text-sm truncate">{log.admin_name || 'Unknown'}</td>
                                                        <td className="px-4 py-3">
                                                            <span className="text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
                                                                style={{ background: 'var(--brand-glow)', color: 'var(--brand)' }}>{log.action}</span>
                                                        </td>
                                                        <td className="px-4 py-3 text-sm truncate" style={{ color: 'var(--text-secondary)' }}>{log.target_user_name || '—'}</td>
                                                        <td className="px-4 py-3 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{log.ip_address || '—'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <div className="text-sm py-4" style={{ color: 'var(--text-muted)' }}>No audit entries found.</div>
                                )}
                            </div>
                        )}
                    </section>
                </div>
            )}

            {/* Manage User Modal */}
            {modalUser && canManage && (
                <ManageUserModal user={modalUser} userDetail={selectedUserDetail} detailLoading={detailLoading}
                    actionState={actionState} setActionState={setActionState} onAction={runUserAction} onClose={closeManageModal} actionLoading={actionLoading} />
            )}

            {/* View-only user detail modal (read only for view_only admins) */}
            {modalUser && !canManage && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
                    style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} onClick={closeManageModal}>
                    <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl animate-slide-up"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid var(--border)' }}>
                            <div className="min-w-0">
                                <h2 className="text-lg font-bold truncate">{modalUser.full_name || modalUser.username}</h2>
                                <p className="text-sm truncate" style={{ color: 'var(--text-secondary)' }}>{modalUser.email}</p>
                            </div>
                            <button className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: 'var(--text-muted)' }} onClick={closeManageModal}><X size={18} /></button>
                        </div>
                        <div className="p-5 flex flex-col gap-4">
                            {/* Identity */}
                            <div>
                                <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Identity &amp; Contact</div>
                                <div className="grid grid-cols-2 gap-2">
                                    {[
                                        { label: 'Full Name', value: modalUser.full_name || '—' },
                                        { label: 'Username', value: modalUser.username || '—' },
                                        { label: 'Email', value: modalUser.email },
                                        { label: 'Mobile', value: modalUser.phone || 'Not set' },
                                        { label: 'Auth Provider', value: modalUser.auth_provider === 'google.com' ? '🔵 Google' : modalUser.auth_provider === 'password' ? '🔑 Email' : (modalUser.auth_provider || '—') },
                                        { label: 'Email Verified', value: modalUser.is_verified ? '✅ Yes' : '❌ No' },
                                    ].map(({ label, value }) => (
                                        <div key={label} className="p-2.5 rounded-xl" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                                            <div className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
                                            <div className="text-xs break-all">{value}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {/* Account status */}
                            <div>
                                <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Status &amp; Dates</div>
                                <div className="grid grid-cols-2 gap-2">
                                    {[
                                        { label: 'Status', value: <StatusPill status={modalUser.account_status} /> },
                                        { label: 'Active', value: modalUser.is_active ? '✅ Yes' : '❌ No' },
                                        { label: 'Registered', value: safeDate(modalUser.created_at) },
                                        { label: 'Approved At', value: safeDate(modalUser.approved_at) },
                                        { label: 'Expires', value: safeDate(modalUser.access_expires_at) },
                                    ].map(({ label, value }) => (
                                        <div key={label} className="p-2.5 rounded-xl" style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)' }}>
                                            <div className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
                                            <div className="text-xs font-mono">{value}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="p-3 rounded-xl text-center text-sm" style={{ background: 'rgba(148,163,184,0.08)', color: 'var(--text-muted)' }}>
                                <EyeOff size={14} className="inline mr-1" /> View-only access. Contact root admin for management permissions.
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Admin Management Modal (root only) */}
            {showAdminModal && (
                <AdminManagementModal admins={adminsList} adminsLoading={adminsLoading}
                    onClose={() => setShowAdminModal(false)} onPromote={handlePromoteAdmin}
                    onUpdateLevel={handleUpdateAdminLevel} onRevoke={handleRevokeAdmin} />
            )}
        </div>
    );
}
