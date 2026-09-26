// ============================================================
// Workspace selected-flow persistence — remembers the user's last
// Workspace flow per account so returning (navigation, refresh)
// reopens the same flow instead of the first one.
//
// Stored value is the stable `flow_id` ONLY — never the display
// name (names can be renamed or duplicated across flows). Scoped
// per account, so one account's selection can never leak into
// another's.
//
// Same safe-storage conventions as workspace-visibility.ts:
// SSR-safe (no localStorage on the server), quota-safe (private
// mode degrades to session-only selection), corrupt-safe (blank
// or foreign values read as absent). Table data, filters,
// pagination, and column state are deliberately NOT persisted
// here.
// ============================================================

const STORAGE_PREFIX = 'wacrm:workspace-selected-flow';

/** Account-scoped storage key. The stored value is a flow_id. */
export function selectedFlowStorageKey(accountId: string): string {
  return `${STORAGE_PREFIX}:${accountId}`;
}

function storage(): Storage | null {
  try {
    // `typeof` guard: SSR prerender and bare-node have no localStorage.
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Last selected flow_id for the account, or null when absent,
 * blank, or unreadable (caller falls back to the first flow).
 * Never throws.
 */
export function loadSelectedFlowId(accountId: string | null): string | null {
  if (!accountId) return null;
  try {
    const raw = storage()?.getItem(selectedFlowStorageKey(accountId));
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    return raw.trim();
  } catch {
    return null;
  }
}

/**
 * Persist the newly selected flow_id immediately on every
 * Workspace flow change. Never throws — quota errors degrade to
 * session-only selection (state still lives in React).
 */
export function saveSelectedFlowId(
  accountId: string | null,
  flowId: string,
): void {
  if (!accountId) return;
  if (typeof flowId !== 'string' || flowId.trim() === '') return;
  try {
    storage()?.setItem(selectedFlowStorageKey(accountId), flowId.trim());
  } catch {
    // Session-only fallback: state still lives in React.
  }
}

/**
 * Pick the initial Workspace flow from a freshly loaded flow-id
 * list: the remembered id when it is still listed (same account,
 * still accessible), else the first available flow, else null
 * (preserves the existing empty-state behavior). Pure — the
 * table request derives from the returned id, so the remembered
 * flow's data is the first (and only) fetch: no wrong-flow flash.
 */
export function resolveInitialFlowId(
  flowIds: readonly string[],
  savedFlowId: string | null,
): string | null {
  if (savedFlowId && flowIds.includes(savedFlowId)) return savedFlowId;
  return flowIds[0] ?? null;
}
