import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/useAuthStore";
import Tooltip from "../ui/Tooltip";
import { cn } from "../../utils/cn";
import { SIDEBAR_EXPANDED_W, SIDEBAR_COLLAPSED_W } from "../../utils/constants";
import {
  Menu,
  ChevronLeft,
  LayoutDashboard,
  ChartCandlestick,
  Briefcase,
  Bot,
  Shield,
  Settings,
  LogOut,
  Globe,
  ClipboardList,
  Landmark,
  Gem,
} from "lucide-react";

/* ─── Avatar helpers ─────────────────────────────────────── */
function nameToColor(str = "") {
  const COLORS = [
    "#00bcd4",   // brand cyan
    "#0097a7",   // brand cyan dark
    "#10b981",   // bull green
    "#3b82f6",   // blue
    "#8b5cf6",   // purple
    "#f59e0b",   // amber
    "#ef4444",   // bear red
    "#14b8a6",   // teal
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++)
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

function getInitials(user) {
  if (user?.full_name?.trim()) {
    const parts = user.full_name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  if (user?.email) return user.email[0].toUpperCase();
  return "?";
}

/** Shows the user's photo if uploaded, otherwise their initials on a colored circle */
function UserAvatar({ user, size = 8 }) {
  const avatarUrl = user?.avatar_url; // e.g. /uploads/avatars/x.jpg — proxied by Vite
  const initials = getInitials(user);
  const bg = nameToColor(user?.email || user?.username || "");
  const dim = `w-${size} h-${size}`;

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={initials}
        className={`${dim} rounded-full object-cover flex-shrink-0 ring-1 ring-white/10`}
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
    );
  }

  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center flex-shrink-0 text-white font-semibold text-xs select-none ring-1 ring-white/10`}
      style={{ background: `linear-gradient(135deg, ${bg}cc, ${bg})` }}
    >
      {initials}
    </div>
  );
}

/* ─── Section definitions ────────────────────────────────── */
const NAV_SECTIONS = [
  {
    label: "Main",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
      { to: "/terminal", icon: ChartCandlestick, label: "Terminal" },
      { to: "/market", icon: Globe, label: "Market" },
    ],
  },
  {
    label: "Trading",
    items: [
      { to: "/portfolio", icon: Briefcase, label: "Portfolio" },
      { to: "/futures", icon: Landmark, label: "Futures" },
      { to: "/commodities", icon: Gem, label: "Commodities" },
      { to: "/orders", icon: ClipboardList, label: "Orders" },
      { to: "/algo", icon: Bot, label: "Algo Trading" },
      { to: "/zeroloss", icon: Shield, label: "ZeroLoss" },
    ],
  },
];

/* ─── Reusable nav item ──────────────────────────────────── */
function SidebarItem({ to, icon: Icon, label, collapsed }) {
  const link = (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          "relative flex items-center h-10 rounded-lg transition-colors duration-150 ease-out",
          "text-[13px] font-medium",
          collapsed
            ? "justify-center w-10 mx-auto"
            : "gap-3 px-3",
          isActive
            ? collapsed
              ? "bg-primary-500/10 text-primary-600 ring-1 ring-primary-500/20"
              : "bg-primary-500/[0.08] text-primary-600 border-l-[2px] border-primary-500 font-semibold"
            : collapsed
              ? "text-gray-500 hover:text-heading hover:bg-overlay/[0.05]"
              : "text-gray-500 hover:text-heading hover:bg-overlay/[0.04] border-l-[2px] border-transparent",
        )
      }
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      <span
        className={cn(
          "whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out",
          collapsed ? "opacity-0 max-w-0" : "opacity-100 max-w-[140px]"
        )}
      >
        {label}
      </span>
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip content={label} position="right" delay={200}>
        {link}
      </Tooltip>
    );
  }
  return link;
}

/* ─── Section label ──────────────────────────────────────── */
function SectionLabel({ label, collapsed }) {
  return (
    <p className={cn(
      "px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400 select-none transition-all duration-200 ease-in-out overflow-hidden whitespace-nowrap",
      collapsed ? "opacity-0 max-h-0 py-0" : "opacity-100 max-h-8"
    )}>
      {label}
    </p>
  );
}

export default function Sidebar({ collapsed, onToggle }) {
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user); // reactive — updates instantly on photo change
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <>
      {/* Mobile overlay */}
      {!collapsed && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden backdrop-blur-[2px]"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}

      <aside
        style={{ width: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W }}
        className={cn(
          "fixed left-0 top-0 h-screen z-40 flex flex-col",
          "bg-[var(--bg-base)] border-r border-edge/10",
          "transition-[width] duration-[250ms] ease-in-out overflow-hidden",
          collapsed
            ? "max-lg:-translate-x-full"
            : "max-lg:translate-x-0 max-lg:w-[240px]",
        )}
      >
        {/* ── Brand row ── */}
        <div
          className={cn(
            "flex-shrink-0 transition-all duration-300",
            collapsed
              ? "flex flex-col items-center gap-2 py-2.5 px-2"
              : "flex flex-col gap-0.5 justify-center h-20 px-4",
          )}
        >
          {collapsed && (
            <button
              type="button"
              onClick={onToggle}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="p-2 rounded-lg text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all duration-300"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <div className="flex items-center justify-between w-full">
            {collapsed ? (
              <a href="https://www.alphasync.app/">
                <img
                  src="/logo1.png"
                  alt="AlphaSync"
                  className="h-9 w-9 object-contain flex-shrink-0 transition-all duration-300 logo-light-adapt"
                />
              </a>
            ) : (
              <>
                <a href="https://www.alphasync.app/" className="block min-w-0 flex-1">
                  <img
                    src="/logo-full.png"
                    alt="AlphaSync"
                    className="h-14 max-w-[180px] object-contain object-left transition-all duration-300 logo-light-adapt"
                  />
                </a>
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  className="p-2 rounded-lg text-gray-400 hover:text-heading hover:bg-overlay/5 transition-all duration-300"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              </>
            )}
          </div>
          {/* Tagline — only visible when collapsed (expanded version is inline with logo) */}
        </div>

        {/* ── Divider ── */}
        <div className="mx-3 h-px bg-edge/8" />

        {/* ── Navigation ── */}
        <nav className="flex-1 px-2.5 overflow-y-auto overflow-x-hidden">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label}>
              <SectionLabel label={section.label} collapsed={collapsed} />
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <SidebarItem key={item.to} {...item} collapsed={collapsed} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* ── Divider ── */}
        <div className="mx-3 h-px bg-edge/8" />

        {/* ── Account module ── */}
        <div className="flex-shrink-0 p-2.5 space-y-1">
          {user && (
            <Tooltip content={`${user.full_name || user.username}`} position="right" delay={200}>
              <div
                onClick={collapsed ? () => navigate('/settings?tab=profile') : undefined}
                onKeyDown={collapsed ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate('/settings?tab=profile');
                  }
                } : undefined}
                role={collapsed ? 'button' : undefined}
                tabIndex={collapsed ? 0 : undefined}
                className={cn(
                  "flex items-center rounded-lg mb-1 transition-colors duration-200",
                  collapsed
                    ? "justify-center py-1.5 mx-auto w-10 cursor-pointer hover:bg-overlay/[0.05]"
                    : "gap-2.5 px-3 py-2.5 hover:bg-overlay/[0.03]",
                )}
              >
                <UserAvatar user={user} size={8} />
                <div
                  className={cn(
                    "min-w-0 overflow-hidden transition-all duration-200 ease-in-out",
                    collapsed ? "opacity-0 max-w-0" : "opacity-100 max-w-[180px]"
                  )}
                >
                    <button
                      type="button"
                      onClick={() => navigate('/settings?tab=profile')}
                      className="text-[13px] font-medium text-heading truncate leading-tight hover:text-primary-600 transition-colors cursor-pointer text-left w-full"
                      title="Open profile settings"
                    >
                      {user.full_name || user.username}
                    </button>
                    <a
                      href={`mailto:${user.email}`}
                      className="text-[11px] text-gray-500 truncate leading-tight mt-0.5 hover:text-primary-600 transition-colors cursor-pointer"
                      title="Send email"
                    >
                      {user.email}
                    </a>
                </div>
              </div>
            </Tooltip>
          )}

          {/* Settings */}
          <NavLink
            to="/settings"
            title={collapsed ? "Settings" : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center h-10 rounded-lg transition-colors duration-150 font-medium",
                collapsed ? "justify-center w-10 mx-auto" : "gap-3 px-3 w-full",
                isActive
                  ? "text-primary-600 bg-primary-500/[0.08]"
                  : "text-gray-500 hover:text-heading hover:bg-overlay/[0.04]",
              )
            }
          >
            <Settings className="w-[18px] h-[18px] flex-shrink-0" />
            <span
              className={cn(
                "text-[13px] font-medium whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out",
                collapsed ? "opacity-0 max-w-0" : "opacity-100 max-w-[140px]"
              )}
            >
              Settings
            </span>
          </NavLink>

          {/* Logout */}
          <button
            onClick={handleLogout}
            title={collapsed ? "Log Out" : undefined}
            className={cn(
                "flex items-center h-10 rounded-md transition-colors duration-200",
              "text-slate-500 dark:text-slate-400 hover:text-red-500 hover:bg-red-500/[0.06]",
              collapsed ? "justify-center w-10 mx-auto" : "gap-3 px-3 w-full",
            )}
          >
            <LogOut className="w-[18px] h-[18px] flex-shrink-0" />
            <span
              className={cn(
                "text-[13px] font-medium whitespace-nowrap overflow-hidden transition-all duration-200 ease-in-out",
                collapsed ? "opacity-0 max-w-0" : "opacity-100 max-w-[140px]"
              )}
            >
              Log Out
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
