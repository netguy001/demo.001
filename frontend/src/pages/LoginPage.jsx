// LoginPage.jsx — Combined Login + Register (exact match to demo-login.html)
import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../stores/useAuthStore";
import toast from "react-hot-toast";
import usePageMeta from "../hooks/usePageMeta";

/* Password Strength */
function PwdStrength({ password }) {
  if (!password) return null;
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  const cls = score <= 1 ? "weak" : score <= 2 ? "medium" : "strong";
  return (
    <div className="pwd-strength">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className={"pwd-bar" + (i <= score ? " " + cls : "")} />
      ))}
    </div>
  );
}

/* Main Auth Page */
export default function LoginPage() {
  usePageMeta(
    "α·SIM Demo Trading — Login | AlphaSync",
    "Start paper trading for free. \u20B910L virtual capital, live NSE/BSE data, zero risk. No broker account needed."
  );

  const [tab, setTab] = useState("login");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [regFname, setRegFname] = useState("");
  const [regLname, setRegLname] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPass, setRegPass] = useState("");
  const [regAgree, setRegAgree] = useState(false);
  const [regLoading, setRegLoading] = useState(false);

  const [googleLoading, setGoogleLoading] = useState(false);
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [showRegPass, setShowRegPass] = useState(false);

  // ── Phone collection modal state ─────────────────────────────────────
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [pendingProfile, setPendingProfile] = useState(null);
  const [phoneValue, setPhoneValue] = useState("");
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneError, setPhoneError] = useState("");

  const loginWithEmail = useAuthStore((s) => s.loginWithEmail);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const registerWithEmail = useAuthStore((s) => s.registerWithEmail);
  const resendVerification = useAuthStore((s) => s.resendVerification);
  const submitPhone = useAuthStore((s) => s.submitPhone);
  const existingUser = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const adminIntent = (searchParams.get("intent") || "").toLowerCase() === "admin";

  const routeByAccountStatus = (profile) => {
    const status = (profile?.account_status || "active").toLowerCase();
    const isActive = status === "active" && profile?.is_active !== false;

    if (isActive) {
      if (adminIntent) {
        if ((profile?.role || "").toLowerCase() === "admin") {
          navigate("/admin/panel");
        } else {
          toast.error(
            `Signed in as ${profile?.email || "this account"}, but it is not an admin account.`
          );
          navigate("/admin");
        }
        return;
      }

      localStorage.setItem("alphasync_trading_mode", "demo");
      localStorage.setItem("alphasync_onboarded", "1");
      navigate("/dashboard");
    } else {
      navigate("/account-status");
    }
  };

  // ── Phone gate: show modal if user has no phone, otherwise route ─────
  const handleAuthSuccess = (profile) => {
    if (!profile?.phone) {
      setPendingProfile(profile);
      setPhoneValue("");
      setPhoneError("");
      setShowPhoneModal(true);
    } else {
      routeByAccountStatus(profile);
    }
  };

  const handlePhoneSubmit = async () => {
    const raw = phoneValue.trim();
    // Client-side pre-validation (matches backend rules)
    const digits = raw.replace(/[\s\-()+]/g, "").replace(/^91(\d{10})$/, "$1");
    const clean = digits.startsWith("+91") ? digits.slice(3) : digits;
    if (!/^[6-9]\d{9}$/.test(clean)) {
      setPhoneError("Enter a valid 10-digit Indian mobile number (starts with 6–9).");
      return;
    }
    setPhoneError("");
    setPhoneLoading(true);
    try {
      await submitPhone(raw);
      setShowPhoneModal(false);
      routeByAccountStatus(pendingProfile);
    } catch (err) {
      const msg =
        err?.response?.data?.detail ||
        err?.message ||
        "Could not save mobile number. Please try again.";
      setPhoneError(msg);
    } finally {
      setPhoneLoading(false);
    }
  };

  // No auto-redirect — let user interact with login page even if session exists

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    try {
      const result = await loginWithEmail(loginEmail, loginPass);
      if ((result?.user?.account_status || "active") !== "active") {
        toast("Login successful. Your account is pending review.");
      } else {
        toast.success("Welcome back!");
      }
      handleAuthSuccess(result?.user);
    } catch (err) {
      const code = err.code;
      if (code === "auth/email-not-verified") {
        try {
          await resendVerification(loginEmail, loginPass);
          toast.error("Email not verified. We sent a new verification link.");
        } catch {
          toast.error("Email not verified. Check your inbox.");
        }
        navigate("/verify-email", { state: { email: loginEmail, password: loginPass } });
        return;
      } else if (
        code === "auth/user-not-found" ||
        code === "auth/wrong-password" ||
        code === "auth/invalid-credential"
      ) {
        toast.error("Invalid email or password");
      } else if (code === "auth/too-many-requests") {
        toast.error("Too many attempts. Try again later.");
      } else {
        toast.error(err.message || "Login failed");
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (regPass.length < 6) return toast.error("Password must be at least 6 characters");
    setRegLoading(true);
    try {
      const fullName = (regFname + " " + regLname).trim();
      const result = await registerWithEmail(regEmail, regPass, fullName, "");
      if (result.needsVerification) {
        navigate("/verify-email", { state: { email: regEmail, password: regPass } });
      } else {
        localStorage.setItem("alphasync_trading_mode", "demo");
        localStorage.setItem("alphasync_onboarded", "1");
        navigate("/dashboard");
      }
    } catch (err) {
      const code = err.code;
      if (code === "auth/email-already-in-use") {
        toast.error("Email already registered. Try signing in.");
      } else if (code === "auth/weak-password") {
        toast.error("Password is too weak.");
      } else {
        toast.error(err.message || "Registration failed");
      }
    } finally {
      setRegLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    try {
      const result = await loginWithGoogle("login");
      const signedInEmail = result?.user?.email || "selected Google account";
      if ((result?.user?.account_status || "active") !== "active") {
        toast(`Signed in as ${signedInEmail}. Your account is under review.`);
      } else {
        toast.success(`Welcome back, ${signedInEmail}!`);
      }
      handleAuthSuccess(result?.user);
    } catch (err) {
      if (err.response?.status === 404) {
        toast.error("Account not found. Please create an account first.");
        setTab("register");
        return;
      }
      if (err.code !== "auth/popup-closed-by-user") {
        toast.error(err.message || "Google sign-in failed");
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleGoogleRegister = async () => {
    setGoogleLoading(true);
    try {
      const result = await loginWithGoogle("register");
      const signedInEmail = result?.user?.email || "selected Google account";
      if ((result?.user?.account_status || "active") !== "active") {
        toast.success(`Registered as ${signedInEmail}. Account pending approval.`);
      } else {
        toast.success(result.isNew ? `Welcome to AlphaSync, ${signedInEmail}!` : `Welcome back, ${signedInEmail}!`);
      }
      handleAuthSuccess(result?.user);
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") {
        toast.error(err.message || "Google sign-up failed");
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!loginEmail) return toast.error("Enter your email first");
    try {
      const { resetPassword } = useAuthStore.getState();
      await resetPassword(loginEmail);
      toast.success("Password reset email sent!");
    } catch {
      toast.error("Could not send reset email.");
    }
  };

  return (
    <div className="auth-page-shell">
      <style dangerouslySetInnerHTML={{ __html: AUTH_STYLES }} />

      {/* ── Phone Collection Modal ────────────────────────────────── */}
      {showPhoneModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
          padding: "1rem",
        }}>
          <div style={{
            background: "var(--bg-surface, #1e293b)",
            border: "1px solid var(--border, rgba(255,255,255,0.1))",
            borderRadius: "20px",
            padding: "2rem",
            width: "100%",
            maxWidth: "420px",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            color: "var(--text-primary, #f8fafc)",
          }}>
            {/* Icon + Title */}
            <div style={{ display: "flex", alignItems: "center", gap: ".75rem", marginBottom: "1.25rem" }}>
              <div style={{
                width: 48, height: 48, borderRadius: 14,
                background: "rgba(6,182,212,.15)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "1.4rem",
              }}>📱</div>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>Verify your mobile number</h2>
                <p style={{ margin: 0, fontSize: ".82rem", color: "var(--text-muted, #94a3b8)", marginTop: ".2rem" }}>
                  Required once — skipped on future sign-ins
                </p>
              </div>
            </div>

            <p style={{ fontSize: ".85rem", color: "var(--text-secondary, #cbd5e1)", marginBottom: "1.25rem", lineHeight: 1.6 }}>
              Please enter your <strong>10-digit Indian mobile number</strong>. This is collected once to
              verify your identity and will be visible to admins for account management.
            </p>

            {/* Input */}
            <label style={{ display: "block", fontSize: ".78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-muted, #94a3b8)", marginBottom: ".4rem" }}>
              Mobile Number
            </label>
            <div style={{ display: "flex", gap: ".5rem", marginBottom: ".75rem" }}>
              <span style={{
                display: "flex", alignItems: "center", padding: "0 .75rem",
                background: "rgba(255,255,255,.06)", border: "1px solid var(--border, rgba(255,255,255,.1))",
                borderRadius: 10, fontSize: ".85rem", color: "var(--text-secondary, #cbd5e1)",
                whiteSpace: "nowrap",
              }}>🇮🇳 +91</span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="9876543210"
                value={phoneValue}
                onChange={(e) => {
                  setPhoneError("");
                  // Only allow digits, max 10
                  const v = e.target.value.replace(/\D/g, "").slice(0, 10);
                  setPhoneValue(v);
                }}
                onKeyDown={(e) => e.key === "Enter" && handlePhoneSubmit()}
                style={{
                  flex: 1, padding: ".65rem .9rem",
                  background: "rgba(255,255,255,.06)",
                  border: `1px solid ${phoneError ? "#ef4444" : "var(--border, rgba(255,255,255,.1))"}`,
                  borderRadius: 10,
                  color: "var(--text-primary, #f8fafc)",
                  fontSize: "1rem", fontFamily: "monospace",
                  outline: "none",
                }}
                autoFocus
              />
            </div>

            {phoneError && (
              <p style={{ color: "#ef4444", fontSize: ".8rem", marginBottom: ".75rem" }}>
                {phoneError}
              </p>
            )}

            <p style={{ fontSize: ".75rem", color: "var(--text-muted, #94a3b8)", marginBottom: "1.25rem" }}>
              <i className="fa fa-lock" style={{ marginRight: ".35rem" }}></i>
              Your number is stored securely and used only for account verification.
            </p>

            {/* Submit */}
            <button
              onClick={handlePhoneSubmit}
              disabled={phoneLoading || phoneValue.length < 10}
              style={{
                width: "100%", padding: ".75rem",
                background: phoneLoading || phoneValue.length < 10
                  ? "rgba(6,182,212,.25)"
                  : "linear-gradient(135deg, #06b6d4, #0284c7)",
                color: "#fff", border: "none", borderRadius: 12,
                fontSize: ".95rem", fontWeight: 700, cursor: phoneLoading || phoneValue.length < 10 ? "not-allowed" : "pointer",
                opacity: phoneLoading || phoneValue.length < 10 ? 0.65 : 1,
                display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem",
                transition: "all .2s",
              }}
            >
              {phoneLoading ? (
                <><i className="fa fa-spinner fa-spin"></i> Saving...</>
              ) : (
                <><i className="fa fa-check-circle"></i> Confirm &amp; Continue</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* NAV */}
      <nav className="auth-nav">
        <div className="auth-nav-logo">
          <img src="/logo.png" alt="AlphaSync" />
          <span className="auth-nav-badge">{"α·SIM"}</span>
        </div>
        <div className="auth-nav-links">
          <a href="/">{"←"} Back to home</a>
          <a href="/login" style={{ color: "var(--primary-light)" }}>Live Trading {"→"}</a>
          <a href="/admin" style={{ color: "var(--green-light)" }}>Admin Panel</a>
        </div>
      </nav>

      {/* AUTH LAYOUT */}
      <div className="auth-wrap">

        {/* LEFT PANEL — Branding */}
        <div className="auth-left">
          <div className="auth-left-inner">
            <div className="demo-mode-badge">
              <span className="dot"></span>
              {"α·SIM"} &nbsp;&middot;&nbsp; Demo Trading
            </div>

            <h1>
              Trade the market.<br />
              <span className="text-gradient">Risk absolutely nothing.</span>
            </h1>
            <p className="sub">
              Practice with {"₹"}10 Lakh of virtual capital on live NSE &amp; BSE data. No real money, no broker account, no risk — just pure trading experience.
            </p>

            <div className="demo-features">
              <div className="demo-feat">
                <div className="icon cyan"><i className="fa fa-bolt"></i></div>
                <span><strong>Live Market Data</strong>Real-time NSE &amp; BSE prices — same data as professional traders</span>
              </div>
              <div className="demo-feat">
                <div className="icon green"><i className="fa fa-shield-halved"></i></div>
                <span><strong>Zero Broker Setup</strong>No API keys, no brokerage account needed to get started</span>
              </div>
              <div className="demo-feat">
                <div className="icon indigo"><i className="fa fa-chart-line"></i></div>
                <span><strong>Full Analytics Dashboard</strong>P&amp;L tracking, position sizing, risk metrics &amp; strategy reports</span>
              </div>
            </div>

            <div className="virtual-capital">
              <div>
                <div className="vc-label">Starting Virtual Capital</div>
                <div className="vc-amount">{"₹"}10,00,000</div>
              </div>
              <div className="vc-tag">Reset anytime</div>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL — Auth Form */}
        <div className="auth-right">
          <div className="auth-form-wrap">

            {/* Tabs */}
            <div className="auth-tabs" role="tablist">
              <button
                className={"auth-tab" + (tab === "login" ? " active" : "")}
                onClick={() => setTab("login")}
                type="button"
                role="tab"
              >
                Login
              </button>
              <button
                className={"auth-tab" + (tab === "register" ? " active" : "")}
                onClick={() => setTab("register")}
                type="button"
                role="tab"
              >
                Create Account
              </button>
            </div>

            {/* LOGIN PANEL */}
            <div className={"form-panel" + (tab === "login" ? " active" : "")}>
              <div className="form-heading">
                <h2>Welcome back {"👋"}</h2>
                <p>Login to your {"α·SIM"} demo account</p>
              </div>

              <form onSubmit={handleLogin}>
                <div className="form-group">
                  <label>Email Address</label>
                  <div className="input-wrap">
                    <i className="input-icon fa fa-envelope"></i>
                    <input
                      type="email"
                      placeholder="you@email.com"
                      required
                      autoComplete="email"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Password</label>
                  <div className="input-wrap">
                    <i className="input-icon fa fa-lock"></i>
                    <input
                      type={showLoginPass ? "text" : "password"}
                      placeholder="••••••••"
                      required
                      autoComplete="current-password"
                      value={loginPass}
                      onChange={(e) => setLoginPass(e.target.value)}
                    />
                    <i
                      className={"toggle-pass fa " + (showLoginPass ? "fa-eye-slash" : "fa-eye")}
                      onClick={() => setShowLoginPass(!showLoginPass)}
                    ></i>
                  </div>
                </div>

                <div className="form-helper">
                  <label>
                    <input type="checkbox" />
                    Remember me
                  </label>
                  <a
                    href="#forgot"
                    onClick={(e) => { e.preventDefault(); handleForgotPassword(); }}
                  >
                    Forgot password?
                  </a>
                </div>

                <button type="submit" className="btn-demo-submit" disabled={loginLoading}>
                  {loginLoading ? (
                    <span><i className="fa fa-spinner fa-spin"></i> Signing in...</span>
                  ) : (
                    <span><i className="fa fa-play-circle"></i> Enter {"α·SIM"} Dashboard</span>
                  )}
                </button>
              </form>

              <div className="or-divider">or continue with</div>

              <button className="btn-google" onClick={handleGoogleLogin} disabled={googleLoading} type="button">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" width="18" height="18" />
                {googleLoading ? "Signing in..." : "Continue with Google"}
              </button>

              <p className="terms-text">
                By logging in you agree to our <a href="/terms">Terms</a> &amp; <a href="/privacy">Privacy Policy</a>
              </p>
            </div>

            {/* REGISTER PANEL */}
            <div className={"form-panel" + (tab === "register" ? " active" : "")}>
              <div className="form-heading">
                <h2>Start trading free {"🚀"}</h2>
                <p>Create your {"α·SIM"} account — takes 30 seconds</p>
              </div>

              <form onSubmit={handleRegister}>
                <div className="form-row">
                  <div className="form-group">
                    <label>First Name</label>
                    <div className="input-wrap">
                      <i className="input-icon fa fa-user"></i>
                      <input
                        type="text"
                        placeholder="First name"
                        required
                        autoComplete="given-name"
                        value={regFname}
                        onChange={(e) => setRegFname(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Last Name</label>
                    <div className="input-wrap">
                      <i className="input-icon fa fa-user"></i>
                      <input
                        type="text"
                        placeholder="Last name"
                        required
                        autoComplete="family-name"
                        value={regLname}
                        onChange={(e) => setRegLname(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="form-group">
                  <label>Email Address</label>
                  <div className="input-wrap">
                    <i className="input-icon fa fa-envelope"></i>
                    <input
                      type="email"
                      placeholder="you@email.com"
                      required
                      autoComplete="email"
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Create Password</label>
                  <div className="input-wrap">
                    <i className="input-icon fa fa-lock"></i>
                    <input
                      type={showRegPass ? "text" : "password"}
                      placeholder="Min 8 characters"
                      required
                      autoComplete="new-password"
                      value={regPass}
                      onChange={(e) => setRegPass(e.target.value)}
                    />
                    <i
                      className={"toggle-pass fa " + (showRegPass ? "fa-eye-slash" : "fa-eye")}
                      onClick={() => setShowRegPass(!showRegPass)}
                    ></i>
                  </div>
                  <PwdStrength password={regPass} />
                </div>

                <div className="form-group" style={{ marginBottom: "1.25rem" }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: ".5rem", cursor: "pointer", fontSize: ".82rem", color: "var(--text-muted)" }}>
                    <input
                      type="checkbox"
                      required
                      checked={regAgree}
                      onChange={(e) => setRegAgree(e.target.checked)}
                      style={{ marginTop: "2px", flexShrink: 0 }}
                    />
                    <span>
                      I agree to the{" "}
                      <a href="/terms" style={{ color: "var(--cyan)", margin: "0 .2rem" }}>Terms of Service</a>
                      {" "}and{" "}
                      <a href="/privacy" style={{ color: "var(--cyan)", margin: "0 .2rem" }}>Privacy Policy</a>
                    </span>
                  </label>
                </div>

                <button type="submit" className="btn-demo-submit" disabled={regLoading}>
                  {regLoading ? (
                    <span><i className="fa fa-spinner fa-spin"></i> Creating account...</span>
                  ) : (
                    <span><i className="fa fa-rocket"></i> Create Free Account &amp; Start Trading</span>
                  )}
                </button>
              </form>

              <div className="or-divider">or sign up with</div>

              <button className="btn-google" onClick={handleGoogleRegister} disabled={googleLoading} type="button">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" width="18" height="18" />
                {googleLoading ? "Signing up..." : "Sign up with Google"}
              </button>
            </div>

            {/* Switch to real trading */}
            <div className="switch-subdomain">
              Ready for real trading?{" "}
              <a href="/login">
                Switch to {"α·AUTO"} / {"α·SCALP"}
                <i className="fa fa-arrow-right" style={{ fontSize: ".75rem" }}></i>
              </a>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CSS — exact match to demo-login.html styles
   All missing CSS variables from the HTML's style.css are
   hardcoded here so the design matches pixel-perfect.
   ═══════════════════════════════════════════════════════════════ */
const AUTH_STYLES = `
  /* ── Missing CSS variables from demo style.css ── */
  .auth-page-shell {
    --cyan: #06b6d4;
    --primary-light: #818cf8;
    --green-light: #6ee7b7;
    --amber: #f59e0b;
    --radius-full: 999px;
    --radius-md: 12px;
    --radius-sm: 8px;
    --radius-lg: 16px;
    --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
    --font-display: 'Inter', system-ui, -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', 'Menlo', 'Consolas', monospace;
    --bg-card: #1a1f3a;
    --transition: all 0.2s ease;

    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    max-height: 100dvh;
    overflow: hidden;
    background: var(--bg-base);
    font-family: var(--font-sans);
    color: var(--text-primary);
  }

  .text-gradient {
    background: linear-gradient(135deg, #06b6d4, #10b981);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  /* ── Auth layout ── */
  .auth-wrap {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    height: calc(100vh - 72px);
    height: calc(100dvh - 72px);
    max-height: calc(100dvh - 72px);
    overflow: hidden;
  }

  /* ── LEFT PANEL — Branding ── */
  .auth-left {
    background: linear-gradient(145deg, #040d1e 0%, #071a38 60%, #052040 100%);
    padding: 2rem 2.5rem;
    display: flex;
    flex-direction: column;
    justify-content: center;
    position: relative;
    overflow: hidden;
    border-right: 1px solid var(--border);
  }
  .auth-left::before {
    content: '';
    position: absolute;
    width: 380px; height: 380px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(6,182,212,.18) 0%, transparent 70%);
    top: -100px; right: -80px;
    animation: pulse-orb 6s ease-in-out infinite;
  }
  .auth-left::after {
    content: '';
    position: absolute;
    width: 300px; height: 300px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(16,185,129,.12) 0%, transparent 70%);
    bottom: -80px; left: -60px;
    animation: pulse-orb 8s ease-in-out infinite reverse;
  }
  @keyframes pulse-orb {
    0%, 100% { transform: scale(1); opacity: .8; }
    50%       { transform: scale(1.12); opacity: 1; }
  }
  .auth-left-inner { position: relative; z-index: 1; }

  .demo-mode-badge {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    background: rgba(6,182,212,.12);
    border: 1px solid rgba(6,182,212,.35);
    color: var(--cyan);
    font-size: .72rem;
    font-weight: 700;
    letter-spacing: .08em;
    padding: .3rem .75rem;
    border-radius: var(--radius-full);
    margin-bottom: 1rem;
  }
  .demo-mode-badge .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--cyan);
    animation: blink 1.5s ease-in-out infinite;
  }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }

  .auth-left h1 {
    font-size: clamp(1.5rem, 2.5vw, 2.2rem);
    line-height: 1.2;
    margin-bottom: .75rem;
    color: var(--text-primary);
    font-family: var(--font-display, 'Inter', sans-serif);
    font-weight: 800;
  }
  .auth-left p.sub {
    color: var(--text-secondary);
    font-size: .9rem;
    line-height: 1.6;
    margin-bottom: 1.25rem;
    max-width: 380px;
  }

  /* feature pills */
  .demo-features { display: flex; flex-direction: column; gap: .5rem; margin-bottom: 1.5rem; }
  .demo-feat {
    display: flex;
    align-items: center;
    gap: .6rem;
    background: rgba(255,255,255,.04);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: .5rem .75rem;
    transition: var(--transition);
  }
  .demo-feat:hover { background: rgba(6,182,212,.07); border-color: rgba(6,182,212,.3); }
  .demo-feat .icon {
    width: 30px; height: 30px;
    border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    font-size: .85rem;
    flex-shrink: 0;
  }
  .demo-feat .icon.cyan  { background: rgba(6,182,212,.15); color: var(--cyan); }
  .demo-feat .icon.green { background: rgba(16,185,129,.15); color: var(--green); }
  .demo-feat .icon.indigo{ background: rgba(99,102,241,.15); color: var(--primary-light); }
  .demo-feat span { font-size: .82rem; color: var(--text-secondary); line-height: 1.35; }
  .demo-feat span strong { color: var(--text-primary); display: block; font-size: .88rem; }

  /* virtual capital display */
  .virtual-capital {
    background: linear-gradient(135deg, rgba(6,182,212,.12), rgba(16,185,129,.08));
    border: 1px solid rgba(6,182,212,.3);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: .75rem;
  }
  .vc-label { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: .15rem; }
  .vc-amount { font-size: 1.4rem; font-weight: 800; color: var(--cyan); font-family: var(--font-mono, 'JetBrains Mono', monospace); }
  .vc-tag {
    font-size: .7rem; font-weight: 700;
    background: rgba(16,185,129,.15);
    color: var(--green);
    border: 1px solid rgba(16,185,129,.3);
    padding: .25rem .75rem;
    border-radius: var(--radius-full);
  }

  /* ── RIGHT PANEL — Auth Form ── */
  .auth-right {
    background: var(--bg-card);
    padding: 1.15rem 1.75rem;
    display: flex;
    flex-direction: column;
    justify-content: center;
    overflow: hidden;
    overflow-x: hidden;
  }
  .auth-form-wrap {
    max-width: 420px;
    margin: 0 auto;
    width: 100%;
  }

  /* Tab switcher */
  .auth-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    background: var(--bg-surface, var(--bg-base));
    border-radius: var(--radius-md);
    padding: 4px;
    margin-bottom: .95rem;
  }
  .auth-tab {
    padding: .5rem .75rem;
    text-align: center;
    font-size: .9rem;
    font-weight: 600;
    color: var(--text-muted);
    border-radius: 8px;
    cursor: pointer;
    transition: var(--transition);
    border: none;
    background: none;
    font-family: var(--font-sans);
  }
  .auth-tab.active {
    background: var(--bg-elevated);
    color: var(--cyan);
    box-shadow: 0 2px 10px rgba(0,0,0,.3);
  }

  /* form heading */
  .form-heading { margin-bottom: .75rem; }
  .form-heading h2 {
    font-size: 1.35rem;
    margin-bottom: .2rem;
    color: var(--text-primary);
    font-family: var(--font-display, 'Inter', sans-serif);
    font-weight: 700;
  }
  .form-heading p { font-size: .82rem; color: var(--text-muted); }

  /* input fields */
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  .form-group { margin-bottom: .6rem; }
  .form-group label {
    display: block;
    font-size: .78rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: .3rem;
    letter-spacing: .02em;
  }
  .input-wrap { position: relative; }
  .input-wrap .input-icon {
    position: absolute;
    left: .9rem; top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    font-size: .85rem;
    pointer-events: none;
  }
  .input-wrap input {
    width: 100%;
    background: var(--bg-base);
    border: 1.5px solid var(--border);
    border-radius: var(--radius-md);
    padding: .55rem .9rem .55rem 2.4rem;
    color: var(--text-primary);
    font-size: .85rem;
    font-family: var(--font-sans);
    transition: var(--transition);
    outline: none;
    box-sizing: border-box;
  }
  .input-wrap input::placeholder { color: var(--text-muted); }
  .input-wrap input:focus {
    border-color: var(--cyan);
    box-shadow: 0 0 0 3px rgba(6,182,212,.12);
  }
  .input-wrap .toggle-pass {
    position: absolute;
    right: .9rem; top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    cursor: pointer;
    font-size: .9rem;
    transition: color .2s;
  }
  .input-wrap .toggle-pass:hover { color: var(--cyan); }

  /* submit button */
  .btn-demo-submit {
    width: 100%;
    padding: .6rem;
    border-radius: var(--radius-md);
    background: linear-gradient(135deg, #06b6d4, #10b981);
    color: #fff;
    font-weight: 700;
    font-size: .9rem;
    font-family: var(--font-sans);
    border: none;
    cursor: pointer;
    transition: var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: .5rem;
    margin-bottom: .55rem;
    box-shadow: 0 4px 20px rgba(6,182,212,.3);
  }
  .btn-demo-submit:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 30px rgba(6,182,212,.45);
    filter: brightness(1.05);
  }
  .btn-demo-submit:disabled { opacity: .6; cursor: not-allowed; transform: none; }

  /* divider */
  .or-divider {
    display: flex;
    align-items: center;
    gap: .5rem;
    margin: .6rem 0;
    color: var(--text-muted);
    font-size: .75rem;
  }
  .or-divider::before, .or-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* Google SSO */
  .btn-google {
    width: 100%;
    padding: .58rem;
    border-radius: var(--radius-md);
    background: transparent;
    border: 1.5px solid var(--border);
    color: var(--text-primary);
    font-size: .85rem;
    font-weight: 600;
    font-family: var(--font-sans);
    cursor: pointer;
    transition: var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: .5rem;
    margin-bottom: .55rem;
  }
  .btn-google:hover { background: rgba(255,255,255,.05); border-color: rgba(255,255,255,.2); }
  .btn-google:disabled { opacity: .6; cursor: not-allowed; }
  .btn-google img { width: 16px; height: 16px; }

  /* helper links */
  .form-helper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: .75rem;
  }
  .form-helper label { display: flex; align-items: center; gap: .4rem; font-size: .82rem; color: var(--text-muted); cursor: pointer; }
  .form-helper a { font-size: .82rem; color: var(--cyan); text-decoration: none; }
  .form-helper a:hover { text-decoration: underline; }

  /* terms */
  .terms-text {
    font-size: .77rem;
    color: var(--text-muted);
    text-align: center;
    line-height: 1.6;
  }
  .terms-text a { color: var(--cyan); }

  /* switch mode */
  .switch-subdomain {
    margin-top: 1rem;
    padding-top: .85rem;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: .85rem;
    color: var(--text-muted);
  }
  .switch-subdomain a {
    color: var(--primary-light);
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    text-decoration: none;
  }
  .switch-subdomain a:hover { color: var(--text-primary); }

  /* form panels */
  .form-panel { display: none; }
  .form-panel.active { display: block; }

  /* password strength */
  .pwd-strength { margin-top: .4rem; display: flex; gap: 4px; }
  .pwd-bar {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--border);
    transition: background .3s;
  }
  .pwd-bar.weak   { background: #ef4444; }
  .pwd-bar.medium { background: var(--amber); }
  .pwd-bar.strong { background: var(--green); }

  /* Navbar */
  .auth-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: .75rem 1.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-base);
    position: sticky; top: 0; z-index: 100;
    flex-shrink: 0;
  }
  .auth-nav-logo { display: flex; align-items: center; gap: .5rem; }
  .auth-nav-logo img { height: 32px; }
  .auth-nav-badge {
    font-size: .68rem; font-weight: 700;
    background: rgba(6,182,212,.12);
    color: var(--cyan);
    border: 1px solid rgba(6,182,212,.3);
    padding: .15rem .5rem;
    border-radius: var(--radius-full);
    letter-spacing: .05em;
  }
  .auth-nav-links { display: flex; align-items: center; gap: .75rem; }
  .auth-nav-links a { font-size: .8rem; color: var(--text-muted); transition: color .2s; text-decoration: none; }
  .auth-nav-links a:hover { color: var(--text-primary); }

  /* ── Ultra Responsive Design ── */
  
  /* Large screens (1200px+) */
  @media (min-width: 1200px) {
    .auth-left { padding: 2.5rem 3rem; }
    .auth-right { padding: 2rem 3rem; }
    .auth-left h1 { font-size: 2.4rem; }
  }
  
  /* Medium screens (901px - 1199px) */
  @media (max-width: 1199px) and (min-width: 901px) {
    .auth-left { padding: 1.5rem 2rem; }
    .auth-right { padding: 1.1rem 1.5rem; }
    .auth-left h1 { font-size: 1.8rem; }
    .auth-left p.sub { font-size: .9rem; }
    .demo-feat span { font-size: .82rem; }
    .demo-feat span strong { font-size: .88rem; }
    .virtual-capital { padding: 1rem; }
    .vc-amount { font-size: 1.4rem; }
  }

  /* Tablets and small laptops (768px - 900px) */
  @media (max-width: 900px) {
    .auth-wrap { 
      grid-template-columns: 1fr; 
      height: calc(100vh - 56px);
      max-height: calc(100vh - 56px);
    }
    .auth-left { display: none; }
    .auth-right { 
      padding: 1.5rem; 
      height: 100%;
      overflow-y: auto;
    }
    .auth-form-wrap { max-width: 380px; }
    .form-row { grid-template-columns: 1fr 1fr; gap: .6rem; }
  }

  /* Mobile landscape and small tablets (481px - 767px) */
  @media (max-width: 767px) and (min-width: 481px) {
    .auth-nav { padding: .6rem 1rem; }
    .auth-nav-logo img { height: 28px; }
    .auth-nav-links { gap: .5rem; }
    .auth-nav-links a { font-size: .75rem; }
    .auth-right { padding: 1.25rem 1.5rem; }
    .form-heading h2 { font-size: 1.25rem; }
    .form-heading p { font-size: .78rem; }
  }

  /* Mobile portrait (up to 480px) */
  @media (max-width: 480px) {
    .auth-page-shell {
      height: 100vh;
      height: 100dvh;
    }
    .auth-nav { 
      padding: .5rem .75rem; 
      height: auto;
    }
    .auth-nav-logo img { height: 26px; }
    .auth-nav-badge { 
      font-size: .6rem; 
      padding: .1rem .4rem; 
    }
    .auth-nav-links { gap: .4rem; }
    .auth-nav-links a { font-size: .7rem; }
    
    .auth-wrap {
      height: calc(100vh - 48px);
      height: calc(100dvh - 48px);
      max-height: calc(100vh - 48px);
    }
    .auth-right { 
      padding: 1rem .75rem; 
      justify-content: flex-start;
      padding-top: 0.75rem;
    }
    .auth-form-wrap { max-width: 100%; }
    
    .auth-tabs { 
      margin-bottom: .75rem; 
      padding: 3px;
    }
    .auth-tab { 
      padding: .4rem .5rem; 
      font-size: .8rem; 
    }
    
    .form-heading { margin-bottom: .75rem; }
    .form-heading h2 { font-size: 1.15rem; }
    .form-heading p { font-size: .75rem; }
    
    .form-row { 
      grid-template-columns: 1fr; 
      gap: .5rem; 
    }
    .form-group { margin-bottom: .5rem; }
    .form-group label { 
      font-size: .72rem; 
      margin-bottom: .2rem; 
    }
    .input-wrap input { 
      padding: .5rem .75rem .5rem 2.2rem; 
      font-size: .8rem; 
    }
    .input-wrap .input-icon { 
      left: .7rem; 
      font-size: .8rem; 
    }
    
    .btn-demo-submit { 
      padding: .6rem; 
      font-size: .82rem; 
    }
    .btn-google { 
      padding: .55rem; 
      font-size: .8rem; 
    }
    .btn-google img { width: 14px; height: 14px; }
    
    .or-divider { 
      margin: .4rem 0; 
      font-size: .7rem; 
    }
    
    .form-helper { 
      margin-bottom: .6rem; 
      flex-wrap: wrap;
      gap: .5rem;
    }
    .form-helper label, .form-helper a { font-size: .75rem; }
    
    .terms-text { font-size: .7rem; }
    
    .switch-subdomain { 
      margin-top: .75rem; 
      padding-top: .75rem; 
      font-size: .78rem; 
    }
    
    .pwd-strength { margin-top: .3rem; }
  }

  /* Extra small screens (up to 360px) */
  @media (max-width: 360px) {
    .auth-nav { padding: .4rem .5rem; }
    .auth-nav-logo img { height: 22px; }
    .auth-nav-badge { display: none; }
    .auth-nav-links a { font-size: .65rem; }
    
    .auth-right { padding: .75rem .5rem; }
    
    .auth-tab { font-size: .75rem; padding: .35rem .4rem; }
    
    .form-heading h2 { font-size: 1.05rem; }
    .form-heading p { font-size: .7rem; }
    
    .input-wrap input { 
      padding: .45rem .6rem .45rem 2rem; 
      font-size: .78rem; 
    }
    
    .btn-demo-submit, .btn-google { 
      padding: .5rem; 
      font-size: .78rem; 
    }
  }

  /* Handle landscape orientation on mobile */
  @media (max-height: 500px) and (orientation: landscape) {
    .auth-page-shell {
      height: auto;
      min-height: 100vh;
      min-height: 100dvh;
      overflow-y: auto;
    }
    .auth-wrap {
      height: auto;
      min-height: calc(100vh - 48px);
      min-height: calc(100dvh - 48px);
    }
    .auth-right {
      overflow-y: visible;
    }
  }
`;
