"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, Fragment } from "react";
import { cn } from "@/lib/utils";
import { getTravelCrmUrl } from "@/lib/travel-crm";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import Image from "next/image";
import {
  Bell,
  Bot,
  CalendarClock,
  FileText,
  LayoutDashboard,
  MessageSquare,
  MessageSquareText,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Radio,
  Route,
  Settings,
  Sheet,
  Table2,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
  UserX,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: MessageSquare },
  { href: "/flows", label: "Flows", icon: Workflow, beta: false },
  { href: "/followups", label: "Follow-ups", icon: CalendarClock },
  { href: "/workspace", label: "Workspace", icon: Table2, beta: true },
  { href: "/broadcasts", label: "Bulk Messages", icon: Radio },
  { href: "/quick-replies", label: "Quick Replies", icon: MessageSquareText },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/agents", label: "AI Agents", icon: Bot },
  { href: "/data-export", label: "Flow Sheets", icon: Sheet },
  { href: "/all-sheets", label: "All Sheets", icon: Sheet },
  { href: "/chat-assignment", label: "Chat Assignment", icon: Route },
];

const bottomNavItems = [
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Google Sheets starts collapsed on every sidebar mount (no persistence). */
export const DEFAULT_SHEETS_COLLAPSED = true;

/**
 * Whether the Google Sheets group shows its children. An
 * explicitly expanded group is always open; a collapsed group
 * still opens when the user is on a sheets child route so the
 * active row is never hidden.
 */
export function resolveSheetsOpen(
  sheetsCollapsed: boolean,
  pathname: string
): boolean {
  if (!sheetsCollapsed) return true;
  return (
    pathname.startsWith("/data-export") || pathname.startsWith("/all-sheets")
  );
}

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { profileLoading, account, accountRole, canEditSettings } = useAuth();
  // Team Members lives at /settings?tab=members — same page as
  // Settings, distinguished by the tab param for highlighting.
  const isTeamMembersActive =
    pathname.startsWith("/settings") && searchParams.get("tab") === "members";
  // Collapsible GOOGLE SHEETS group (Flow Sheets + All Sheets).
  // Default COLLAPSED on every sidebar mount — no persistence, so a
  // refresh/reload always starts closed. Forced open while a sheets
  // child route is active so the highlighted row is never hidden
  // inside a closed group.
  const [sheetsCollapsed, setSheetsCollapsed] = useState(
    DEFAULT_SHEETS_COLLAPSED
  );
  const sheetsOpen = resolveSheetsOpen(sheetsCollapsed, pathname);
  // UI-only gating: Flows, AI Agents, and Settings are shown to the owner
  // only. Non-owners simply don't see these nav entries. This is purely a
  // visibility change — the backend/routes are untouched, so it can be
  // reverted by removing the `isOwner` checks below.
  const isOwner = accountRole === "owner";
  const visibleNavItems = navItems.filter((item) => {
    if (
      !isOwner &&
      (item.href === "/flows" || item.href === "/agents" || item.href === "/data-export" || item.href === "/all-sheets" || item.href === "/workspace" || item.href === "/chat-assignment")
    ) {
      return false;
    }
    return true;
  });
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Cross-app card target — centralized in getTravelCrmUrl so a
  // missing/invalid value falls back to the default Travel CRM URL
  // instead of hiding the card. Wait for the profile fetch to settle
  // first, otherwise the card flashes in once the row resolves.
  const travelCrmUrl = !profileLoading ? getTravelCrmUrl(account) : null;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          "lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none",
        )}
        aria-label="Primary"
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2">
  <Image
    src="/interscale-logo.png"
    alt="Interscale Marketing"
    width={32}
    height={32}
    className="h-8 w-8 rounded-lg"
  />
  <span className="text-sm font-semibold text-foreground">
  <p className="text-[15.6px] leading-tight">WhatsApp CRM</p>
  <p className="text-[9.8px] leading-tight text-muted-foreground">from Interscale Marketing</p>
</span>
</Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {visibleNavItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === "/notifications" && unreadNotifications > 0;

              return (
                <Fragment key={item.href}>
                  {/* Collapsible group header for the two sheets
                      entries — a button, never a navigation link.
                      Rendered inline at the first sheets item so
                      owner-gating and ordering stay untouched. */}
                  {item.href === "/data-export" && (
                    <li>
                      <button
                        type="button"
                        onClick={() => setSheetsCollapsed((v) => !v)}
                        aria-expanded={sheetsOpen}
                        className="flex w-full items-center justify-between px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Google Sheets
                        {sheetsOpen ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </li>
                  )}
                  {((item.href === "/data-export" || item.href === "/all-sheets") && !sheetsOpen) ? null : (
                  <li>
                  <Link
                    href={item.href}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {item.beta && (
                      <span
                        aria-label="Beta feature"
                        className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                      >
                        Beta
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={`${totalUnread} unread conversation${totalUnread === 1 ? "" : "s"}`}
                        className="relative flex h-2 w-2"
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={`${unreadNotifications} unread notification${unreadNotifications === 1 ? "" : "s"}`}
                        className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    )}
                  </Link>
                </li>
                  )}
                </Fragment>
              );
            })}
          </ul>

          {/* Bottom section: Team Members (admin+, same page as
              Settings distinguished by ?tab=members) above Settings.
              Identical row markup to the entries below. */}
          {/* Settings — visible to all roles. */}
          <div className="my-4 border-t border-border" />

              <ul className="flex flex-col gap-1">
                {canEditSettings && (
                  <li key="/settings?tab=members">
                    <Link
                      href="/settings?tab=members"
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                        isTeamMembersActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <UsersRound className="h-4 w-4" />
                      Team Members
                    </Link>
                  </li>
                )}
                {bottomNavItems.map((item) => {
                  const isActive =
                    pathname.startsWith(item.href) && !isTeamMembersActive;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
        </nav>

        {/* Travel CRM cross-app card. This replaces the old sidebar
            profile block (avatar/name/email) — the top-right header
            menu remains the profile home. Hidden entirely when no URL
            is configured. Opens in a new tab; never a router link. */}
        {travelCrmUrl ? (
          <div className="shrink-0 border-t border-border p-3">
            <a
              href={travelCrmUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open Travel Agency CRM in a new tab"
              title="Open Travel Agency CRM in a new tab"
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-indigo-500 ring-1 ring-inset ring-indigo-500/20 transition-colors duration-150 hover:bg-indigo-500/10"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white">
                <Image
                  src="/logos/travel-crm-icon.png"
                  alt="Travel Agency CRM"
                  width={24}
                  height={24}
                  className="h-6 w-6 object-contain"
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate">Travel Agency CRM</span>
                <span className="truncate text-[10px] font-normal text-indigo-500/80">
                  Switch to Travel Agency CRM
                </span>
              </span>
              <ExternalLink
                className="h-3.5 w-3.5 shrink-0 opacity-70"
                aria-hidden="true"
              />
            </a>
          </div>
        ) : null}
      </aside>
    </>
  );
}
