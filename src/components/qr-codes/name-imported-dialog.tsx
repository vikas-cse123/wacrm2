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
import { QR_NAME_MAX_LENGTH, type ImportedQrCode } from "@/lib/qr-codes/types";

/**
 * Assign a WACRM display name to a QR code that exists in WhatsApp
 * but has no local metadata. Creates the code in Meta first (a
 * no-op match) — actually: Meta already holds it, so we only store
 * local metadata keyed by its Meta code.
 */
export function NameImportedDialog({
  qr,
  open,
  onOpenChange,
  onNamed,
}: {
  qr: ImportedQrCode | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNamed: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName("");
  }, [open ]);

  const canSubmit =
    name.trim().length > 0 &&
    name.trim().length <= QR_NAME_MAX_LENGTH &&
    !saving &&
    qr !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !qr) return;
    setSaving(true);
    try {
      const res = await fetch("/api/qr-codes/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meta_code: qr.meta_code,
          name: name.trim(),
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the name.");
      toast.success("QR code added to WACRM.");
      onOpenChange(false);
      onNamed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the name.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Name this QR code</DialogTitle>
          <DialogDescription>
            This code already exists in WhatsApp. Give it a WACRM display
            name so your team can recognize it — nothing changes in
            WhatsApp.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="qr-adopt-name">Name</Label>
            <Input
              id="qr-adopt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reception desk QR"
              maxLength={QR_NAME_MAX_LENGTH + 10}
              autoComplete="off"
            />
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
                "Save name"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
