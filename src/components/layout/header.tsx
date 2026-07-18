"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import {
  LogOut,
  Menu,
  Phone,
  Settings as SettingsIcon,
  User,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/inbox": "Inbox",
  "/notifications": "Notifications",
  "/contacts": "Contacts",
  "/pipelines": "Pipelines",
  "/broadcasts": "Broadcasts",
  "/automations": "Automations",
  "/settings": "Settings",
};

function getPageTitle(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "Dashboard";
}

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
}

export function Header({ onOpenSidebar }: HeaderProps) {
  const pathname = usePathname();
  const { profile, accountId, accountRole, signOut } = useAuth();
  const [connectedPhone, setConnectedPhone] = useState<{
    accountId: string;
    number: string | null;
  } | null>(null);
  // UI-only: Settings link is owner-only, matching the sidebar gating.
  const isOwner = accountRole === "owner";
  const title = getPageTitle(pathname);
  const connectedPhoneNumber =
    connectedPhone?.accountId === accountId ? connectedPhone.number : null;

  // The connected number is safe account-level metadata, unlike the access
  // token and other WhatsApp credentials. Every account member can see it so
  // agents always know which business number they are replying from.
  useEffect(() => {
    if (!accountId) return;

    let cancelled = false;
    fetch("/api/whatsapp/config", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        setConnectedPhone({
          accountId,
          number: payload.connected
            ? payload.phone_info?.display_phone_number ?? null
            : null,
        });
      })
      .catch(() => {
        if (!cancelled) setConnectedPhone({ accountId, number: null });
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        {connectedPhoneNumber ? (
          <div
            className="flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-foreground sm:px-3"
            title={`Connected WhatsApp number: ${connectedPhoneNumber}`}
            aria-label={`Connected WhatsApp number: ${connectedPhoneNumber}`}
          >
            <Phone className="size-3.5 shrink-0 text-primary" />
            <span className="max-w-28 truncate sm:max-w-none">
              {connectedPhoneNumber}
            </span>
          </div>
        ) : null}
        <ModeToggle />

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70 sm:gap-3 sm:pl-1 sm:pr-3"
          aria-label="Open account menu"
        >
          <Avatar className="size-8">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? "Avatar"}
              />
            ) : null}
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? "User"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? "User"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            Profile
          </DropdownMenuItem>
          {isOwner && (
            <DropdownMenuItem
              render={
                <Link
                  href="/settings?tab=whatsapp"
                  className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                />
              }
            >
              <SettingsIcon className="size-4" />
              Settings
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
