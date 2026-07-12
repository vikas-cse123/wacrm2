"use client";

import { BellRing, BellOff, Smartphone } from "lucide-react";
import { toast } from "sonner";

import { usePushNotifications } from "@/hooks/use-push-notifications";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Notifications panel — a per-device on/off switch for mobile/desktop
 * push notifications on new inbox messages.
 *
 * "Per device" because a Web Push subscription is bound to the specific
 * browser/PWA install. Toggling on requests notification permission and
 * registers a subscription with the server; toggling off tears it down.
 */
export function NotificationsPanel() {
  const { supported, permission, subscribed, busy, loading, enable, disable } =
    usePushNotifications();

  const onToggle = async (next: boolean) => {
    const result = next ? await enable() : await disable();
    if (result.ok) {
      toast.success(
        next
          ? "Notifications enabled on this device."
          : "Notifications turned off on this device.",
      );
    } else {
      toast.error(result.error ?? "Something went wrong.");
    }
  };

  const blocked = permission === "denied";

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Notifications"
        description="Get a push notification when a new message arrives in the inbox. Install the app to your home screen to receive them on your phone."
      />

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-muted-foreground">
              {subscribed ? (
                <BellRing className="size-5" />
              ) : (
                <BellOff className="size-5" />
              )}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                New message notifications
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {subscribed
                  ? "On for this device. You'll be notified of new inbox messages."
                  : "Off. Turn on to be notified of new inbox messages on this device."}
              </p>
            </div>
          </div>

          <Switch
            checked={subscribed}
            onCheckedChange={onToggle}
            disabled={!supported || busy || loading || blocked}
            aria-label="Toggle new message notifications"
          />
        </div>

        {!supported && !loading && (
          <p className="mt-4 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Smartphone className="size-4 shrink-0" />
            This browser doesn&apos;t support push notifications. On iPhone,
            add the app to your Home Screen first, then open it from there.
          </p>
        )}

        {blocked && (
          <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Notifications are blocked for this site. Re-enable them in your
            browser or phone settings, then toggle this on.
          </p>
        )}
      </div>
    </section>
  );
}
