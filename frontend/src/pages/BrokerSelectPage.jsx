import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/useAuthStore";
import { useBrokerStore } from "../stores/useBrokerStore";
import toast from "react-hot-toast";
import {
  ArrowRight,
  ShieldCheck,
  Sparkles,
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  User,
  Lock,
  X,
  AlertCircle,
} from "lucide-react";

/* ─── Animated Background ────────────────────────────────────── */
function FloatingOrbs() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {[...Array(12)].map((_, i) => (
        <div
          key={i}
          className="absolute rounded-full"
          style={{
            width: `${Math.random() * 4 + 2}px`,
            height: `${Math.random() * 4 + 2}px`,
            left: `${Math.random() * 100}%`,
            top: `${Math.random() * 100}%`,
            background: `rgba(16, 185, 129, ${0.10 + Math.random() * 0.15})`,
            animation: `floatOrb ${8 + Math.random() * 12}s ease-in-out infinite`,
            animationDelay: `${Math.random() * 5}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ─── Broker Data ────────────────────────────────────────────── */
const BROKERS = [
  {
    id: "zebull",
    name: "Zebull (Mynt)",
    logoText: "ZEBULL",
    logoSub: "MYNT",
    color: "#00b894",
    active: true,
  },
  {
    id: "zerodha",
    name: "Zerodha",
    logoText: "ZERODHA",
    logoSub: "",
    color: "#387ed1",
    active: false,
  },
  {
    id: "angelone",
    name: "Angel One",
    logoText: "ANGEL",
    logoSub: "ONE",
    color: "#ff6b35",
    active: false,
  },
  {
    id: "upstox",
    name: "Upstox",
    logoText: "UPSTOX",
    logoSub: "",
    color: "#7b2ff7",
    active: false,
  },
  {
    id: "groww",
    name: "Groww",
    logoText: "GROWW",
    logoSub: "",
    color: "#5367ff",
    active: false,
  },
  {
    id: "dhan",
    name: "Dhan",
    logoText: "DHAN",
    logoSub: "",
    color: "#00d1b2",
    active: false,
  },
];

/* ─── Broker Card — Big square box with logo + name ──────────── */
function BrokerCard({ broker, index, onSelect, selected }) {
  const isSelected = selected === broker.id;
  const delay = index * 50;

  return (
    <div
      className={`
                group relative flex flex-col items-center justify-center rounded-2xl border aspect-square backdrop-blur-xl
                transition-all duration-400 cursor-pointer select-none
                ${isSelected
          ? "border-emerald-400/60 ring-2 ring-emerald-400/20 scale-[1.04]"
          : broker.active
            ? "border-white/10 hover:border-emerald-400/30 hover:scale-[1.04]"
            : "border-white/10 opacity-65 hover:opacity-80"
        }
            `}
      style={{
        background: isSelected
          ? "rgba(6, 95, 70, 0.28)"
          : "rgba(15, 23, 42, 0.74)",
        border: isSelected ? undefined : '1px solid rgba(148,163,184,0.14)',
        boxShadow: isSelected ? '0 20px 44px rgba(16,185,129,0.14)' : '0 16px 36px rgba(2,8,23,0.24)',
        animation: `brokerSlideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms both`,
      }}
      onClick={() => broker.active && onSelect(broker.id)}
    >
      {/* Selection check */}
      {isSelected && (
        <div
          className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/40"
          style={{
            animation: "popIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both",
          }}
        >
          <Check className="w-3 h-3 text-white stroke-2" />
        </div>
      )}

      {/* Coming Soon badge */}
      {!broker.active && (
        <div className="absolute top-2.5 right-2.5">
          <span className="text-[7px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded bg-white/10 text-slate-300 border border-white/10">
            Soon
          </span>
        </div>
      )}

      {/* Logo Box */}
      <div
        className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl flex flex-col items-center justify-center gap-0.5 mb-3 transition-transform duration-300 group-hover:scale-110"
        style={{
          background: `${broker.color}12`,
          border: `1.5px solid ${broker.color}30`,
          boxShadow: isSelected ? `0 0 30px ${broker.color}15` : "none",
        }}
      >
        <span
          className="text-[11px] sm:text-[13px] font-black tracking-wider leading-none"
          style={{ color: broker.color }}
        >
          {broker.logoText}
        </span>
        {broker.logoSub && (
          <span
            className="text-[7px] sm:text-[8px] font-bold tracking-widest leading-none mt-0.5 opacity-60"
            style={{ color: broker.color }}
          >
            {broker.logoSub}
          </span>
        )}
      </div>

      {/* Name */}
      <span
        className={`text-xs font-semibold text-center leading-tight px-2 transition-colors ${isSelected ? "text-white" : "text-slate-300 group-hover:text-white"}`}
      >
        {broker.name}
      </span>
    </div>
  );
}

/* ─── Zebu Login Modal ────────────────────────────────────────── */
function ZebuLoginModal({ open, onClose, onSuccess }) {
  const [uid, setUid] = useState("");
  const [password, setPassword] = useState("");
  const [factor2, setFactor2] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [vendorCode, setVendorCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const brokerLogin = useBrokerStore((s) => s.login);
  const loading = useBrokerStore((s) => s.loading);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!uid.trim() || !password.trim()) {
      toast.error("User ID and Password are required");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("API Key is required (from MYNT portal)");
      return;
    }
    try {
      await brokerLogin(uid.trim(), password, factor2.trim(), apiKey.trim(), vendorCode.trim());
      toast.success("Zebu connected successfully!");
      onSuccess?.();
    } catch (err) {
      toast.error(err.message || "Login failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        style={{ animation: "fadeIn 0.2s ease both" }}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl border border-slate-200 shadow-2xl"
        style={{
          background: "#FFFFFF",
          boxShadow: "0 32px 80px rgba(2,8,23,0.45)",
          animation: "modalSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-slate-200">
          <div className="flex items-center gap-3 mb-2">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{
                background: "rgba(0, 184, 148, 0.12)",
                border: "1.5px solid rgba(0, 184, 148, 0.3)",
              }}
            >
              <span
                className="text-[10px] font-black tracking-wider"
                style={{ color: "#00b894" }}
              >
                ZEBU
              </span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Connect Zebull
              </h2>
              <p className="text-xs text-slate-500">
                Enter your Zebu trading account credentials
              </p>
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* User ID */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              Zebu User ID
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                placeholder="e.g. FA12345"
                className="zebu-login-input w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 text-sm placeholder-slate-400 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 outline-none transition-all"
                autoFocus
                autoComplete="username"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your Zebu password"
                className="zebu-login-input w-full pl-10 pr-10 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 text-sm placeholder-slate-400 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 outline-none transition-all"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* 2FA: DOB or TOTP */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              DOB / 2FA{" "}
              <span className="text-slate-400 font-normal">(DD-MM-YYYY or TOTP)</span>
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={factor2}
                onChange={(e) => setFactor2(e.target.value)}
                placeholder="DD-MM-YYYY or 6-digit TOTP"
                maxLength={10}
                className="zebu-login-input w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 text-sm placeholder-slate-400 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 outline-none transition-all"
                autoComplete="off"
              />
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              API Key{" "}
              <span className="text-slate-400 font-normal">(from MYNT portal)</span>
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Your API Key from MYNT portal"
                className="zebu-login-input w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 text-sm placeholder-slate-400 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 outline-none transition-all"
                autoComplete="off"
              />
            </div>
          </div>

          {/* Vendor Code */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              Vendor Code{" "}
              <span className="text-slate-400 font-normal">(optional, defaults to User ID)</span>
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={vendorCode}
                onChange={(e) => setVendorCode(e.target.value)}
                placeholder={uid || "Same as User ID"}
                className="zebu-login-input w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 text-sm placeholder-slate-400 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 outline-none transition-all"
                autoComplete="off"
              />
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading || !uid.trim() || !password.trim() || !apiKey.trim()}
            className={`
              w-full py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2.5 transition-all duration-300
              ${loading || !uid.trim() || !password.trim()
                ? "bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed"
                : "bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:shadow-lg hover:shadow-emerald-500/25 hover:scale-[1.02] active:scale-[0.98]"
              }
            `}
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Authenticating...
              </>
            ) : (
              <>
                Connect Zebull <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <div className="px-6 pb-5">
          <div className="flex items-center gap-1.5 justify-center px-3 py-2 rounded-full bg-slate-50 border border-slate-200">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500/60" />
            <span className="text-[10px] text-gray-600">
              Password is hashed before sending · Token encrypted at rest
            </span>
          </div>
        </div>
      </div>

      <style>{`
        .zebu-login-input {
          color: #0f172a;
          caret-color: #0f172a;
        }
        .zebu-login-input::placeholder {
          color: #94a3b8;
          opacity: 1;
        }
        .zebu-login-input:-webkit-autofill,
        .zebu-login-input:-webkit-autofill:hover,
        .zebu-login-input:-webkit-autofill:focus,
        .zebu-login-input:-webkit-autofill:active {
          -webkit-text-fill-color: #0f172a !important;
          caret-color: #0f172a !important;
          box-shadow: 0 0 0px 1000px #f8fafc inset !important;
          transition: background-color 5000s ease-in-out 0s;
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalSlideUp {
          from { opacity: 0; transform: translateY(30px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────── */
export default function BrokerSelectPage() {
  const navigate = useNavigate();
  const [selectedBroker, setSelectedBroker] = useState(null);
  const [showContent, setShowContent] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [masterStatus, setMasterStatus] = useState(null);
  const [masterStatusLoading, setMasterStatusLoading] = useState(true);
  const brokerLoading = useBrokerStore((s) => s.loading);

  // Check master Zebu connection status on page load
  useEffect(() => {
    const checkMasterStatus = async () => {
      try {
        const response = await fetch("/api/broker/master-status");
        if (response.ok) {
          const data = await response.json();
          setMasterStatus(data);
        } else {
          setMasterStatus({
            connected: false,
            error: "Failed to check master Zebu status",
            details: {}
          });
        }
      } catch (err) {
        setMasterStatus({
          connected: false,
          error: "Unable to reach backend — check if server is running",
          details: {}
        });
      } finally {
        setMasterStatusLoading(false);
      }
    };

    checkMasterStatus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleSelect = (brokerId) => {
    setSelectedBroker(brokerId);
  };

  const handleContinue = async () => {
    if (!selectedBroker) return;

    // For Zebull — open direct login modal
    if (selectedBroker === "zebull") {
      setShowLoginModal(true);
      return;
    }

    // For other brokers (coming soon) — just go to dashboard
    setIsTransitioning(true);
    setTimeout(() => navigate("/dashboard"), 500);
  };

  const handleLoginSuccess = () => {
    setShowLoginModal(false);
    localStorage.setItem('alphasync_trading_mode', 'live');
    localStorage.setItem('alphasync_onboarded', '1');
    setIsTransitioning(true);
    setTimeout(() => navigate("/dashboard"), 400);
  };

  const handleBack = () => {
    navigate("/dashboard");
  };

  return (
    <div
      className={`min-h-screen w-full overflow-x-hidden transition-all duration-500 bg-surface-950 ${isTransitioning ? "opacity-0 scale-[1.02]" : "opacity-100 scale-100"}`}
    >
      <FloatingOrbs />

      {/* Gradient overlays */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full bg-emerald-400/[0.06] blur-[120px]" />
        <div className="absolute bottom-0 left-1/4 w-[500px] h-[500px] rounded-full bg-teal-400/[0.04] blur-[100px]" />
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
        {/* Back button */}
        <div
          style={{
            animation: showContent ? "fadeDown 0.5s ease both" : "none",
          }}
        >
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:text-white border border-white/10 hover:border-white/20 bg-slate-900/75 hover:bg-slate-800/85 backdrop-blur-md transition-all duration-300 mb-8"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </button>
        </div>

        {/* Header */}
        <div
          className="text-center mb-10"
          style={{
            animation: showContent
              ? "fadeDown 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both"
              : "none",
          }}
        >
          <div className="flex justify-center mb-5">
            <a href="https://www.alphasync.app/">
              <img
                src="/logo.png"
                alt="AlphaSync"
                className="h-12 sm:h-14 object-contain brightness-100"
              />
            </a>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-500/10 border border-primary-500/20 mb-4 backdrop-blur-md">
            <Sparkles className="w-3.5 h-3.5 text-primary-400" />
            <span className="text-[11px] font-semibold text-sky-300">
              Demo Trading
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-2">
            Select Your{" "}
            <span className="bg-gradient-to-r from-emerald-500 via-teal-500 to-primary-500 bg-clip-text text-transparent">
              Broker
            </span>
          </h1>
          <p className="text-sm text-slate-400">
            Choose your preferred broker to get started.
          </p>
        </div>

        {/* Master Zebu Status Alert */}
        {!masterStatusLoading && masterStatus && !masterStatus.connected && (
          <div className="mb-8 p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 backdrop-blur-sm">
            <div className="flex gap-3 items-start">
              <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold text-amber-200 text-sm mb-1">
                  Live Market Data Unavailable
                </h3>
                <p className="text-amber-100/90 text-sm mb-2">
                  {masterStatus.error || "Master Zebu account is not configured."}
                </p>
                <p className="text-xs text-amber-100/70">
                  To enable live NSE market data for all users, configure Zebu master account credentials in backend .env file.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Broker Grid */}
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4 mb-10">
          {BROKERS.map((broker, i) => (
            <BrokerCard
              key={broker.id}
              broker={broker}
              index={i}
              onSelect={handleSelect}
              selected={selectedBroker}
            />
          ))}
        </div>

        {/* Continue */}
        <div
          className="flex flex-col items-center gap-3"
          style={{
            animation: showContent
              ? "fadeDown 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.6s both"
              : "none",
          }}
        >
          <button
            onClick={handleContinue}
            disabled={!selectedBroker || brokerLoading}
            className={`
                            px-10 py-3 rounded-xl text-sm font-bold flex items-center gap-2.5 transition-all duration-400
                            ${selectedBroker
                ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:shadow-lg hover:shadow-emerald-500/25 hover:scale-[1.03] active:scale-[0.97]"
                : "bg-slate-900/80 border border-white/10 text-slate-400 cursor-not-allowed"
              }
                        `}
          >
            {brokerLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Connecting...
              </>
            ) : selectedBroker ? (
              <>
                Continue with{" "}
                {BROKERS.find((b) => b.id === selectedBroker)?.name}
                <ArrowRight className="w-4 h-4" />
              </>
            ) : (
              "Select a broker to continue"
            )}
          </button>

          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900/80 border border-white/10 backdrop-blur-md shadow-[0_10px_30px_rgba(2,8,23,0.25)]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400/80" />
            <span className="text-[10px] text-slate-300">
              Credentials encrypted · Never stored on our servers
            </span>
          </div>
        </div>
      </div>

      <style>{`
                @keyframes floatOrb {
                    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.3; }
                    25% { transform: translate(15px, -25px) scale(1.15); opacity: 0.5; }
                    50% { transform: translate(-10px, -50px) scale(0.85); opacity: 0.35; }
                    75% { transform: translate(12px, -15px) scale(1.05); opacity: 0.45; }
                }
                @keyframes fadeDown {
                    from { opacity: 0; transform: translateY(-18px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes brokerSlideUp {
                    from { opacity: 0; transform: translateY(30px) scale(0.92); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes popIn {
                    from { opacity: 0; transform: scale(0); }
                    to { opacity: 1; transform: scale(1); }
                }
            `}</style>

      {/* Zebu Login Modal */}
      <ZebuLoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  );
}
