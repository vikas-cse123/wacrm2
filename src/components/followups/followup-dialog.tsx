"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  FOLLOWUP_MESSAGE_MAX,
  formatAgentNumberForDisplay,
  normalizeAgentWhatsappNumber,
  type Followup,
} from "@/lib/followups/types";

/**
 * Create / edit a reminder. The reminder is delivered TO THE
 * CREATOR's current Reminder WhatsApp Number
 * (`profiles.whatsapp_number`, re-read from the database on every
 * open and snapshotted by the server at creation) FROM the
 * already-connected WhatsApp Business number. The connected
 * Business number is the SENDER only and is never used as the
 * recipient display. There is no customer field: a reminder has
 * no recipient selector because the recipient is always the
 * creator's saved number.
 */

function toLocalInputValue(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Create / edit a reminder. No customer field: the sender is the
 * already-connected WhatsApp Business number (shown read-only)
 * and the recipient is always the creator's saved Reminder
 * WhatsApp Number.
 */
export function FollowupDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Followup | null;
  onSaved: () => void;
}) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [message, setMessage] = useState("");
  // The creator's own WhatsApp number — the reminder recipient.
  // Fetched separately (not via useAuth) so a pre-migration schema
  // degrades to the blocking state instead of breaking the dialog.
    const [agentNumber, setAgentNumber] = useState<string | null>(null);
  const [agentNumberLoading, setAgentNumberLoading] = useState(true);
  const [senderLine, setSenderLine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (!open) return;
    if (editing) {
      const local = toLocalInputValue(editing.scheduled_for);
      setDate(local.date);
      setTime(local.time);
      setMessage(editing.message_text);
    } else {
      setDate("");
      setTime("");
      setMessage("");
    }
    // Recipient: the creator's CURRENT Reminder WhatsApp Number
    // (`profiles.whatsapp_number` — the same field Settings →
    // Reminder WhatsApp Number reads and writes). Re-fetched on
    // every open and reset first so a previously loaded value can
    // never linger after the user saves a new number in Settings.
    // Missing/invalid = blocking state (the server also fails
    // closed on save).
    setAgentNumberLoading(true);
    setAgentNumber(null);
    const supabase = createClient();
    if (user?.id) {
      // Two-arg `then` (no `.catch`): the PostgREST builder's
      // thenable types as PromiseLike, which has no `catch`.
      void supabase
        .from("profiles")
        .select("whatsapp_number")
        .eq("user_id", user.id)
        .maybeSingle()
        .then(
          ({ data, error }) => {
            if (error || !data) {
              setAgentNumber(null);
            } else {
              // Strict normalization applies the +91 default for
              // bare 10-digit numbers; null blocks submission.
              setAgentNumber(
                normalizeAgentWhatsappNumber(
                  (data as { whatsapp_number?: unknown }).whatsapp_number,
                ),
              );
            }
            setAgentNumberLoading(false);
          },
          () => {
            setAgentNumber(null);
            setAgentNumberLoading(false);
          },
        );
    } else {
      setAgentNumberLoading(false);
    }
    // Connected sender (read-only context).
    fetch("/api/whatsapp/business-profile", { cache: "no-store" })
      .then((r) => r.json().catch(() => null))
      .then((json) => {
        const data = json as {
          phone_number?: string;
          verified_name?: string | null;
        } | null;
        if (data?.phone_number) {
          setSenderLine(
            `${data.verified_name ? `${data.verified_name} · ` : ""}${data.phone_number}`,
          );
        } else {
          setSenderLine(null);
        }
      })
      .catch(() => setSenderLine(null));
  }, [open, editing, user?.id]);

  const scheduledISO = date && time ? new Date(`${date}T${time}`) : null;
  const scheduledValid =
    scheduledISO !== null &&
    !Number.isNaN(scheduledISO.getTime()) &&
    scheduledISO.getTime() > Date.now();
  // The recipient is always the creator's saved number, so a
  // missing agent number blocks submission (fail closed).
  const canSubmit =
    !saving &&
    !agentNumberLoading &&
    agentNumber !== null &&
    scheduledValid &&
    message.trim().length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !scheduledISO) return;
    setSaving(true);
    try {
      const payload = {
        // No customer field: creation never attaches a contact.
        contact_id: null,
        scheduled_for: scheduledISO.toISOString(),
        message_text: message.trim(),
        // New reminders are text-only. Preserve any template stored
        // on a legacy row being edited (no UI to change it).
        template_name: editing?.template_name ?? null,
        template_language: editing?.template_language ?? "en_US",
      };
      const url = editing ? `/api/followups/${editing.id}` : "/api/followups";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the reminder.");
      toast.success(editing ? "Reminder updated." : "Reminder scheduled.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the reminder.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit reminder" : "New Reminder"}</DialogTitle>
          <DialogDescription>
            Delivered to your WhatsApp number from your connected
            WhatsApp Business number at the scheduled time.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          {!agentNumberLoading && agentNumber === null && (
            <p
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
            >
              Add your WhatsApp number in{" "}
              <Link href="/settings?tab=reminder-number" className="font-medium underline">
                Settings → Reminder WhatsApp Number
              </Link>{" "}
              before creating a reminder.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="fu-date">Date</Label>
              <Input
                id="fu-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fu-time">Time</Label>
              <Input
                id="fu-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
          </div>
          {/* <p className="-mt-2 text-xs text-muted-foreground">
            Uses your device timezone.
          </p> */}

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="fu-message">Reminder message</Label>
              <span className="text-xs text-muted-foreground">
                {message.trim().length}/{FOLLOWUP_MESSAGE_MAX}
              </span>
            </div>
            <Textarea
              id="fu-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Call Rahul about the Singapore package…"
            />
          </div>

          <div className="space-y-0.5 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <div>
              <span className="text-muted-foreground">Send from · </span>
              <span className="font-medium text-foreground">
                {senderLine ?? "WhatsApp Business (connect in Settings)"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Send to · </span>
              <span className="font-medium text-foreground">
                {agentNumberLoading
                  ? "Loading…"
                  : agentNumber
                    ? formatAgentNumberForDisplay(agentNumber)
                    : "Set your number in Settings → Reminder WhatsApp Number"}
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  {editing ? "Save changes" : "Schedule Reminder"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
