"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Client hook for Web Push notifications.
 *
 * Exposes whether push is supported, the current permission/subscription
 * state, and enable()/disable() actions that wire up (or tear down) the
 * browser PushManager subscription and mirror it to the server.
 *
 * Reliability hardening:
 *  - VAPID fingerprint: the browser cannot read the key a subscription was
 *    created with, so we record the VAPID public key per endpoint in
 *    localStorage at subscribe time. On enable(), an existing subscription
 *    is only trusted when its stored fingerprint matches the current
 *    public key; a mismatch (a VAPID key change since it was created)
 *    triggers a safe unsubscribe + re-subscribe with the current key.
 *    Legacy subscriptions with no stored fingerprint are reused (they
 *    cannot be verified retroactively and we must not churn valid subs).
 *  - Server-side verification: "subscribed" is only reported when BOTH the
 *    browser subscription exists AND a matching push_subscriptions row
 *    exists (verified via GET /api/push/subscribe). A browser-only
 *    subscription with a missing/stale server row is treated as NOT
 *    subscribed until the server save succeeds.
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

/** localStorage prefix for per-endpoint VAPID fingerprints. */
const VAPID_FP_PREFIX = "push-vapid-fp:";

/** Converts a base64url VAPID key into the Uint8Array the PushManager wants. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  // Back the view with a concrete ArrayBuffer (not ArrayBufferLike) so it
  // satisfies the PushManager's BufferSource parameter type under strict TS.
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Stable fingerprint of the VAPID public key a subscription was created
 * with. The public key is not secret; the private key is never sent to the
 * client. Exported for unit tests.
 */
export function vapidFingerprint(publicKey: string): string {
  return publicKey.trim();
}

/**
 * Whether an existing browser subscription must be replaced because the
 * configured VAPID public key changed since it was created.
 *
 * - No stored fingerprint (legacy sub predating this feature): reuse it —
 *   we cannot verify retroactively and must not churn valid subscriptions.
 * - Stored fingerprint differs from the current key: the VAPID key changed
 *   → replace the subscription.
 * - Stored fingerprint matches: reuse.
 *
 * Pure + exported for unit tests.
 */
export function shouldResubscribeForVapid(
  storedFingerprint: string | null,
  currentFingerprint: string,
): boolean {
  // No (or empty) stored fingerprint = a legacy subscription that cannot be
  // verified retroactively — reuse it, never churn.
  if (!storedFingerprint) return false;
  return storedFingerprint !== currentFingerprint;
}

function fingerprintKey(endpoint: string): string {
  return `${VAPID_FP_PREFIX}${endpoint}`;
}

function readFingerprint(endpoint: string): string | null {
  try {
    return localStorage.getItem(fingerprintKey(endpoint));
  } catch {
    return null;
  }
}

function writeFingerprint(endpoint: string, fingerprint: string): void {
  try {
    localStorage.setItem(fingerprintKey(endpoint), fingerprint);
  } catch {
    /* storage unavailable — best-effort only */
  }
}

function removeFingerprint(endpoint: string): void {
  try {
    localStorage.removeItem(fingerprintKey(endpoint));
  } catch {
    /* ignore */
  }
}

/**
 * True when the current user has a push_subscriptions row whose endpoint
 * matches `endpoint`. Read via the RLS-scoped server client (the caller's
 * own rows only) — no service-role key reaches the browser.
 */
async function serverHasEndpoint(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch("/api/push/subscribe", { cache: "no-store" });
    if (!res.ok) return false;
    const json = (await res.json()) as { endpoints?: unknown };
    return (
      Array.isArray(json.endpoints) &&
      (json.endpoints as unknown[]).includes(endpoint)
    );
  } catch {
    return false;
  }
}

export interface PushState {
  /** Browser can do Web Push AND a VAPID key is configured. */
  supported: boolean;
  /** Notification permission: 'default' | 'granted' | 'denied'. */
  permission: NotificationPermission | null;
  /** This device currently has an active, server-registered subscription. */
  subscribed: boolean;
  /** A subscribe/unsubscribe call is in flight. */
  busy: boolean;
  /** True until the initial subscription check resolves. */
  loading: boolean;
  enable: () => Promise<{ ok: boolean; error?: string }>;
  disable: () => Promise<{ ok: boolean; error?: string }>;
}

export function usePushNotifications(): PushState {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    null,
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isSupported =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window &&
      Boolean(VAPID_PUBLIC_KEY);

    setSupported(isSupported);

    if (!isSupported) {
      setLoading(false);
      return;
    }

    setPermission(Notification.permission);

    // Reflect whether this device has a live, SERVER-REGISTERED
    // subscription. A browser PushSubscription with no matching
    // push_subscriptions row cannot deliver, so it must not be reported
    // as "On". (AutoEnablePush re-syncs the server row on load when the
    // permission is granted.)
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (sub) => {
        if (!sub) {
          setSubscribed(false);
          return;
        }
        const synced = await serverHasEndpoint(sub.endpoint);
        if (!synced) {
          setSubscribed(false);
          return;
        }
        // Record a fingerprint for future VAPID-change checks.
        if (VAPID_PUBLIC_KEY) {
          writeFingerprint(sub.endpoint, vapidFingerprint(VAPID_PUBLIC_KEY));
        }
        setSubscribed(true);
      })
      .catch(() => setSubscribed(false))
      .finally(() => setLoading(false));
  }, []);

  const enable = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC_KEY) {
      return { ok: false, error: "Push notifications aren't supported here." };
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        return {
          ok: false,
          error:
            perm === "denied"
              ? "Notifications are blocked. Enable them in your browser settings."
              : "Notification permission was not granted.",
        };
      }

      const reg = await navigator.serviceWorker.ready;
      const currentFp = vapidFingerprint(VAPID_PUBLIC_KEY);

      let sub = await reg.pushManager.getSubscription();

      // VAPID-key-change handling: reuse an existing subscription only when
      // its recorded fingerprint matches the current public key (or when it
      // is a legacy subscription with no recorded fingerprint). A mismatch
      // means the VAPID key changed since it was created — replace it.
      if (sub) {
        const storedFp = readFingerprint(sub.endpoint);
        if (shouldResubscribeForVapid(storedFp, currentFp)) {
          const staleEndpoint = sub.endpoint;
          removeFingerprint(staleEndpoint);
          await sub.unsubscribe().catch(() => {});
          // Drop the orphaned server row for the old endpoint so it does
          // not accumulate.
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: staleEndpoint }),
          }).catch(() => {});
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          });
        } else {
          // Valid (or unverifiable legacy) subscription — reuse it, and
          // record a fingerprint so a future VAPID change is detected.
          writeFingerprint(sub.endpoint, currentFp);
        }
      } else {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Include the VAPID public key used so the server can reject a
        // build/runtime key mismatch up front (never the private key).
        body: JSON.stringify({ ...sub.toJSON(), vapidPublicKey: VAPID_PUBLIC_KEY }),
      });

      if (!res.ok) {
        // Roll back the browser subscription + fingerprint so state stays
        // consistent — never report "enabled" when the server save failed.
        await sub.unsubscribe().catch(() => {});
        removeFingerprint(sub.endpoint);
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.error || "Could not enable notifications." };
      }

      writeFingerprint(sub.endpoint, currentFp);
      setSubscribed(true);
      return { ok: true };
    } catch (err) {
      console.error("[push] enable failed:", err);
      return { ok: false, error: "Something went wrong enabling notifications." };
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const disable = useCallback(async () => {
    if (!supported) return { ok: false, error: "Not supported." };
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        removeFingerprint(endpoint);
        const unsubscribed = await sub.unsubscribe().catch(() => false);
        if (!unsubscribed) {
          return {
            ok: false,
            error: "Browser refused to unsubscribe. Try clearing site data.",
          };
        }
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
      setSubscribed(false);
      return { ok: true };
    } catch (err) {
      console.error("[push] disable failed:", err);
      return { ok: false, error: "Could not disable notifications." };
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { supported, permission, subscribed, busy, loading, enable, disable };
}