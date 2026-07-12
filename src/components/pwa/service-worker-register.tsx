"use client";

import { useEffect } from "react";

/**
 * Registers the root-scope service worker (/sw.js) once on the client.
 * The worker powers PWA install and Web Push. Registration is
 * best-effort — browsers without service-worker support (or insecure
 * origins) simply skip it, and the app works as before.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("[pwa] service worker registration failed:", err);
      });
    };

    // Defer to load so registration never competes with first paint.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
