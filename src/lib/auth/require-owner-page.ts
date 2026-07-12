import { redirect } from "next/navigation";

import { getCurrentAccount } from "./account";
import type { AccountRole } from "./roles";

/**
 * Server-side guard for owner-only route segments.
 *
 * Call at the top of a route-segment `layout.tsx` (a server component).
 * Non-owners — and anyone whose account context can't be resolved — are
 * redirected to /dashboard before the protected page renders, so the
 * page can't be reached by typing its URL. This is the backend
 * counterpart to the sidebar/header nav gating (which is cosmetic only).
 */
export async function requireOwnerPage(): Promise<void> {
  let role: AccountRole | null = null;
  try {
    const ctx = await getCurrentAccount();
    role = ctx.role;
  } catch {
    // Unauthenticated or no account context. Middleware normally handles
    // the auth redirect; falling through to the non-owner redirect below
    // keeps this safe either way. (redirect() must live outside the try —
    // it works by throwing, which a catch would otherwise swallow.)
    role = null;
  }

  if (role !== "owner") {
    redirect("/dashboard");
  }
}
