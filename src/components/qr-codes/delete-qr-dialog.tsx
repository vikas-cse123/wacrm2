"use client";

import { useState } from "react";
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
import type { QrCodeRecord } from "@/lib/qr-codes/types";

/** Delete confirmation. Deletes the REAL Meta QR code first. */
export function DeleteQrDialog({
  qr,
  open,
  onOpenChange,
  onDeleted,
}: {
  qr: QrCodeRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (reconciled: boolean) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!qr || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/qr-codes/${qr.id}`, { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        reconciled?: boolean;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not delete the QR code.");
      onOpenChange(false);
      onDeleted(json?.reconciled ?? false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the QR code.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this WhatsApp QR code?</DialogTitle>
          <DialogDescription>
            This will delete {qr ? `“${qr.name}”` : "the QR code"} from the
            connected WhatsApp Business number. Scans will stop working.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={handleDelete}
          >
            {deleting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete QR code"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
