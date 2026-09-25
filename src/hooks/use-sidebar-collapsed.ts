import { useCallback, useReducer } from "react";
import { useSyncExternalStore } from "react";

// ============================================================
// Sidebar collapse preference — persisted UI state.
//
// Expanded (default) = full sidebar with labels; collapsed = a
// narrow desktop icon rail. Stored in localStorage per account
// (same scoping pattern as workspace column visibility), so the
// choice survives navigation (shell state) and refresh (storage).
// Collapsing only ever affects lg+ presentation classes — the
// mobile drawer always renders full-width regardless.
//
// SSR-safe: initial state is always expanded; the stored value
// syncs in an effect, so server and first-client HTML agree.
// ============================================================

const STORAGE_PREFIX = "wacrm:sidebar-collapsed:v1";

export function sidebarCollapsedStorageKey(accountId: string): string {
  return `${STORAGE_PREFIX}:${accountId}`;
}

/** Stored preference for this scope. Missing/corrupt → expanded. */
export function loadSidebarCollapsed(accountId: string | null): boolean {
  try {
    if (accountId === null || typeof localStorage === "undefined") return false;
    return localStorage.getItem(sidebarCollapsedStorageKey(accountId)) === "1";
  } catch {
    return false;
  }
}

/** Persist (collapsed) or clear (expanded = default state) the preference. */
export function saveSidebarCollapsed(accountId: string, collapsed: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    const key = sidebarCollapsedStorageKey(accountId);
    if (collapsed) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Session-only fallback: state still lives in React.
  }
}

export interface SidebarCollapsed {
  collapsed: boolean;
  toggle: () => void;
}

function subscribeToCollapse(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/**
 * Shell-owned collapse state. Scope derives from the account every
 * render; switching accounts simply reads the other scope.
 * useSyncExternalStore (server snapshot: expanded) keeps server
 * and first-client HTML agreeing, syncs other tabs for free, and
 * satisfies the set-state-in-effect rule the naive effect version
 * trips. The local bump re-renders this tab after its own writes
 * (same-tab storage writes fire no event).
 */
export function useSidebarCollapsed(accountId: string | null): SidebarCollapsed {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const getSnapshot = useCallback(
    () => loadSidebarCollapsed(accountId),
    [accountId],
  );
  const collapsed = useSyncExternalStore(
    subscribeToCollapse,
    getSnapshot,
    () => false,
  );
  const toggle = useCallback(() => {
    if (accountId === null) return;
    saveSidebarCollapsed(accountId, !loadSidebarCollapsed(accountId));
    bump();
  }, [accountId]);
  return { collapsed, toggle };
}
