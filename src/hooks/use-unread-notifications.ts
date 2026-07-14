"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Notification } from "@/types";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * RLS on `notifications` already scopes every read to `auth.uid() =
 * user_id`, so no explicit filter is needed here — same pattern as
 * `useTotalUnread` for conversations.
 */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) return;

      // head:true skips fetching rows — we only need the `count`
      // supabase-js returns alongside the (empty) response body.
      const { count: unreadCount, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("read_at", null);
      if (cancelled || error) return;
      setCount(unreadCount ?? 0);

      // Subscribe to changes for this specific user only
      const channel = supabase
        .channel(`notifications-unread-count-${userId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            if (cancelled) return;
            if (payload.eventType === "INSERT") {
              const row = payload.new as Notification;
              if (!row.read_at) setCount((n) => n + 1);
            } else if (payload.eventType === "UPDATE") {
              const newRow = payload.new as Notification;
              if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
            } else if (payload.eventType === "DELETE") {
              const oldRow = payload.old as Partial<Notification>;
              if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
            }
          },
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}
