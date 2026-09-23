"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

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
import {
  QR_PREFILLED_MESSAGE_MAX_LENGTH,
  normalizeQrImageFormat,
  type QrImageFormat,
} from "@/lib/whatsapp/meta-api";
import { QR_NAME_MAX_LENGTH, type QrCodeRecord } from "@/lib/qr-codes/types";

/**
 * Edit dialog. Renames locally; prefilled-message and format changes
 * re-render through Meta (Meta is authoritative for the QR itself).
 */
export function EditQrDialog({
  qr,
  open,
  onOpenChange,
  onSaved,
}: {
  qr: QrCodeRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [format, setFormat] = useState<QrImageFormat>("SVG");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && qr) {
      setName(qr.name);
      setMessage(qr.prefilled_message);
      setFormat(normalizeQrImageFormat(qr.image_format));
    }
  }, [open, qr]);

  const nameValid =
    name.trim().length > 0 && name.trim().length <= QR_NAME_MAX_LENGTH;
  const messageValid =
    message.trim().length > 0 &&
    message.trim().length <= QR_PREFILLED_MESSAGE_MAX_LENGTH;
  const unchanged =
    qr !== null &&
    name.trim() === qr.name &&
    message.trim() === qr.prefilled_message &&
    format === normalizeQrImageFormat(qr.image_format);
  const canSubmit = nameValid && messageValid && !unchanged && !saving && qr !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !qr) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      if (name.trim() !== qr.name) patch.name = name.trim();
      if (message.trim() !== qr.prefilled_message) {
        patch.prefilled_message = message.trim();
      }
      if (format !== normalizeQrImageFormat(qr.image_format)) {
        patch.image_format = format;
      }
      const res = await fetch(`/api/qr-codes/${qr.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        meta_missing?: boolean;
      } | null;
      if (!res.ok) {
        throw new Error(
          json?.error ?? "Could not save the QR code.",
        );
      }
      toast.success("QR code updated.");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the QR code.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit QR code</DialogTitle>
          <DialogDescription>
            Message and format changes update the actual QR code in
            WhatsApp. The name stays local to WACRM.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="qr-edit-name">Name</Label>
            <Input
              id="qr-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={QR_NAME_MAX_LENGTH + 10}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="qr-edit-message">Prefilled message</Label>
              <span className="text-xs text-muted-foreground">
                {message.trim().length}/{QR_PREFILLED_MESSAGE_MAX_LENGTH}
              </span>
            </div>
            <Textarea
              id="qr-edit-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
          </div>
          <div className="grid gap-2">
            <Label>QR image format</Label>
            <div className="flex gap-2" role="radiogroup" aria-label="QR image format">
              {(["SVG", "PNG"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  onClick={() => setFormat(f)}
                  className={
                    format === f
                      ? "flex-1 rounded-lg border border-primary bg-primary-soft px-3 py-2 text-sm font-medium text-primary"
                      : "flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                  }
                >
                  {f}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Switching format re-renders the image through WhatsApp.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
