"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Client hook for Web Push notifications.
 *
 * Exposes whether push is supported, the current permission/subscription
 * state, and enable()/disable() actions that wire up (or tear down) the
 * browser PushManager subscription and mirror it to the server.
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

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

    // Reflect whether this device already has a live subscription.
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(Boolean(sub)))
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

      // Reuse an existing subscription if present; otherwise create one.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });

      if (!res.ok) {
        // Roll back the browser subscription so state stays consistent.
        await sub.unsubscribe().catch(() => {});
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.error || "Could not enable notifications." };
      }

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
        await sub.unsubscribe().catch(() => {});
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
