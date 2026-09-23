"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import {
  FOLLOWUP_MESSAGE_MAX,
  type Followup,
} from "@/lib/followups/types";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface TemplateOption {
  name: string;
  language: string;
}

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
 * Create / edit a follow-up. Contacts come from the existing
 * account-scoped search (no duplicates created); the sender is the
 * already-connected WhatsApp Business number, shown read-only.
 * An optional approved template covers sends outside the 24h
 * customer-service window (decided at send time, not here).
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
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateName, setTemplateName] = useState<string>("");
  const [senderLine, setSenderLine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setContactId(editing.contact_id);
      setContactLabel("");
      const local = toLocalInputValue(editing.scheduled_for);
      setDate(local.date);
      setTime(local.time);
      setMessage(editing.message_text);
      setTemplateName(editing.template_name ?? "");
    } else {
      setContactId(null);
      setContactLabel("");
      setContactQuery("");
      setDate("");
      setTime("");
      setMessage("");
      setTemplateName("");
    }
    setContactOptions([]);
    // Connected sender (read-only context) + approved templates.
    const supabase = createClient();
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
    supabase
      .from("message_templates")
      .select("name, language")
      .eq("status", "APPROVED")
      .order("name")
      .limit(100)
      .then(({ data }) => {
        setTemplates(
          ((data ?? []) as Array<{ name: string; language: string | null }>).map(
            (t) => ({ name: t.name, language: t.language ?? "en_US" }),
          ),
        );
      });
  }, [open, editing]);

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
  const canSubmit =
    !saving && contactId !== null && scheduledValid && message.trim().length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !scheduledISO) return;
    setSaving(true);
    try {
      const payload = {
        contact_id: contactId,
        scheduled_for: scheduledISO.toISOString(),
        message_text: message.trim(),
        template_name: templateName || null,
        template_language: "en_US",
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
      if (!res.ok) throw new Error(json?.error ?? "Could not save the follow-up.");
      toast.success(editing ? "Follow-up updated." : "Follow-up scheduled.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the follow-up.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit follow-up" : "New follow-up"}</DialogTitle>
          <DialogDescription>
            Sent from your connected WhatsApp Business number at the
            scheduled time.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label>Customer</Label>
            {contactId ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                <span className="truncate text-foreground">{contactLabel || "Selected contact"}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setContactId(null);
                    setContactLabel("");
                  }}
                >
                  Change
                </Button>
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
              <Label htmlFor="fu-message">Message</Label>
              <span className="text-xs text-muted-foreground">
                {message.trim().length}/{FOLLOWUP_MESSAGE_MAX}
              </span>
            </div>
            <Textarea
              id="fu-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Hi Rahul, just following up on your Singapore trip enquiry…"
            />
          </div>

          <div className="grid gap-2">
            <Label>Fallback template (optional)</Label>
            <Select
              value={templateName || "__none__"}
              onValueChange={(v) => setTemplateName(v === "__none__" ? "" : (v ?? ""))}
            >
              <SelectTrigger className="border-border bg-card">
                <SelectValue placeholder="No template — text only in window" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No template</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={`${t.name}|${t.language}`} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Used only if the 24-hour messaging window is closed at send
              time. Decided when sending, not now.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Send from · </span>
            <span className="font-medium text-foreground">
              {senderLine ?? "WhatsApp Business (connect in Settings)"}
            </span>
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
                  {editing ? "Save changes" : "Schedule Follow-up"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
