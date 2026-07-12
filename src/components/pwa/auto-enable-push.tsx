"use client";

import { useEffect, useRef } from "react";
import { usePushNotifications } from "@/hooks/use-push-notifications";

// Remembers, per device, that we've already auto-asked for permission so
// we don't re-prompt on every load (which browsers penalize and users
// find annoying).
const AUTO_ASKED_KEY = "push-auto-asked";

/**
 * Turns notifications on by default, as far as browser rules allow.
 *
 * Mounted inside the authed dashboard, on first load it:
 *   - If permission is already granted → silently (re)creates the push
 *     subscription. This is the key behaviour: once a user has allowed
 *     notifications once, they stay on across sessions, new devices under
 *     the same login, and rebuilds — no need to touch Settings.
 *   - If permission hasn't been decided yet → asks once per device.
 *     Works automatically on Android/desktop. iOS requires a user tap,
 *     so there the prompt is a no-op and the user enables via the
 *     Settings → Notifications toggle the first time.
 *
 * Fully best-effort: every failure path is swallowed inside the hook, so
 * this never disrupts the app.
 */
export function AutoEnablePush() {
  const { supported, permission, subscribed, loading, enable } =
    usePushNotifications();
  const ran = useRef(false);

  useEffect(() => {
    if (loading || !supported || subscribed || ran.current) return;
    ran.current = true;

    if (permission === "granted") {
      // Already allowed — subscribe silently (no prompt is shown).
      void enable();
      return;
    }

    if (permission === "default") {
      let asked: string | null = null;
      try {
        asked = localStorage.getItem(AUTO_ASKED_KEY);
      } catch {
        /* storage unavailable — treat as not-yet-asked */
      }
      if (!asked) {
        try {
          localStorage.setItem(AUTO_ASKED_KEY, "1");
        } catch {
          /* ignore */
        }
        // Requests permission, then subscribes on grant. On iOS this
        // resolves without a prompt (needs a gesture) and is harmless.
        void enable();
      }
    }
  }, [loading, supported, subscribed, permission, enable]);

  return null;
}
