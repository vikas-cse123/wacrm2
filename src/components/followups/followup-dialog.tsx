"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  AGENT_NUMBER_COUNTRY_CODE_MESSAGE,
  normalizeAgentWhatsappNumber,
  normalizeRecipientPhone,
  type Followup,
} from "@/lib/followups/types";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

/**
 * Create / edit a reminder. The reminder is delivered TO THE
 * CREATOR's own stored WhatsApp number (`profiles.whatsapp_number`,
 * snapshotted at creation) FROM the already-connected WhatsApp
 * Business number, shown read-only. The customer is optional
 * context only and never the recipient — there is no "send to"
 * selector because the recipient is always the creator.
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
 * Create / edit a reminder. The contact picker is optional context
 * (personal reminders have no customer); the sender is the
 * already-connected WhatsApp Business number, shown read-only.
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
  const [contactQuery, setContactQuery] = useState("");
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [message, setMessage] = useState("");
  // The creator's own WhatsApp number — the reminder recipient.
  // Fetched separately (not via useAuth) so a pre-migration schema
  // degrades to the blocking state instead of breaking the dialog.
    const [agentNumber, setAgentNumber] = useState<string | null>(null);
    const [agentNumberIssue, setAgentNumberIssue] = useState<"missing" | "country-code" | null>(null);
  const [agentNumberLoading, setAgentNumberLoading] = useState(true);
  const [senderLine, setSenderLine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { user } = useAuth();

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setContactId(editing.contact_id);
      setContactLabel("");
      const local = toLocalInputValue(editing.scheduled_for);
      setDate(local.date);
      setTime(local.time);
      setMessage(editing.message_text);
    } else {
      setContactId(null);
      setContactLabel("");
      setContactQuery("");
      setDate("");
      setTime("");
      setMessage("");
    }
    setContactOptions([]);
    // Recipient check: the creator's own number. Missing/invalid =
    // blocking state (the server also fails closed on save).
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
              setAgentNumberIssue("missing");
            } else {
              const raw = (data as { whatsapp_number?: unknown }).whatsapp_number;
              const strict = normalizeAgentWhatsappNumber(raw);
              setAgentNumber(strict);
              // A stored number without a country code can no longer
              // deliver reliably: block with the specific fix prompt.
              // Never fall back to anything else.
              setAgentNumberIssue(
                strict !== null
                  ? null
                  : normalizeRecipientPhone(raw) !== null
                    ? "country-code"
                    : "missing",
              );
            }
            setAgentNumberLoading(false);
          },
          () => {
            setAgentNumber(null);
            setAgentNumberIssue("missing");
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

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = contactQuery.trim();
    if (q.length < 2) {
      setContactOptions([]);
      setContactSearching(false);
      return;
    }
    setContactSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const supabase = createClient();
        const like = `%${q}%`;
        const { data } = await supabase
          .from("contacts")
          .select("id, name, phone")
          .or(`name.ilike.${like},phone.ilike.${like}`)
          .order("name")
          .limit(10);
        setContactOptions((data ?? []) as ContactOption[]);
      } catch {
        setContactOptions([]);
      } finally {
        setContactSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [contactQuery]);

  const pickContact = useCallback((c: ContactOption) => {
    setContactId(c.id);
    setContactLabel(`${c.name || c.phone} · ${c.phone}`);
    setContactOpen(false);
  }, []);

  const scheduledISO = date && time ? new Date(`${date}T${time}`) : null;
  const scheduledValid =
    scheduledISO !== null &&
    !Number.isNaN(scheduledISO.getTime()) &&
    scheduledISO.getTime() > Date.now();
  // Customer is optional; the recipient is always the creator, so a
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
        contact_id: contactId,
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
          {!agentNumberLoading && agentNumberIssue !== null && (
            <p
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
            >
              {agentNumberIssue === "country-code" ? (
                <>{AGENT_NUMBER_COUNTRY_CODE_MESSAGE} Update it in{" "}
                <Link href="/settings?tab=profile" className="font-medium underline">
                  Settings → Your profile
                </Link>
                .</>
              ) : (
                <>Add your WhatsApp number in{" "}
                <Link href="/settings?tab=profile" className="font-medium underline">
                  Settings → Your profile
                </Link>{" "}
                before creating a reminder.</>
              )}
            </p>
          )}
          <div className="grid gap-2">
            <Label>
              Customer <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            {contactId ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                <span className="truncate text-foreground">{contactLabel || "Selected contact"}</span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setContactId(null);
                      setContactLabel("");
                    }}
                  >
                    Remove
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setContactId(null);
                      setContactLabel("");
                      setContactOpen(true);
                    }}
                  >
                    Change
                  </Button>
                </span>
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={contactQuery}
                  onChange={(e) => {
                    setContactQuery(e.target.value);
                    setContactOpen(true);
                  }}
                  onFocus={() => setContactOpen(true)}
                  placeholder="Search by name or phone…"
                  autoComplete="off"
                  aria-label="Search contacts"
                />
                {contactOpen && (contactOptions.length > 0 || contactSearching) && (
                  <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-md">
                    {contactSearching && contactOptions.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
                    ) : (
                      contactOptions.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => pickContact(c)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="truncate text-foreground">
                            {c.name || c.phone}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {c.phone}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

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
          <p className="-mt-2 text-xs text-muted-foreground">
            Uses your device timezone.
          </p>

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

          <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Send from · </span>
            <span className="font-medium text-foreground">
              {senderLine ?? "WhatsApp Business (connect in Settings)"}
            </span>
            <span className="text-muted-foreground"> to your WhatsApp number</span>
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
