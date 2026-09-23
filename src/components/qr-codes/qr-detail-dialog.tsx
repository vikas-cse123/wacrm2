"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ImportedQrCode,
  QrCodeRecord,
} from "@/lib/qr-codes/types";

export type DetailQr =
  | (QrCodeRecord & { sync_status?: string })
  | (ImportedQrCode & { created_at?: string });

function isStored(qr: DetailQr): qr is QrCodeRecord & { sync_status?: string } {
  return qr.id !== null;
}

/**
 * Detail view. The QR artwork always comes from Meta (streamed
 * through our image proxy) — never regenerated locally. Large
 * enough to scan straight from the screen.
 */
export function QrDetailDialog({
  qr,
  canEdit,
  onOpenChange,
  onEdit,
  onDelete,
  onNameImported,
}: {
  qr: DetailQr | null;
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onNameImported: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState<"SVG" | "PNG" | null>(null);

  async function downloadAs(format: "SVG" | "PNG") {
    if (!qr || !isStored(qr)) return;
    // Switching artwork format re-renders through Meta first so the
    // download is always WhatsApp's own image.
    if (format !== qr.image_format) {
      if (!canEdit) {
        toast.error("Only admins can re-render the QR image.");
        return;
      }
      setDownloading(format);
      try {
        const res = await fetch(`/api/qr-codes/${qr.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_format: format }),
        });
        const json = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) throw new Error(json?.error ?? "Could not re-render the image.");
        toast.success(`QR image re-rendered as ${format} by WhatsApp.`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not re-render the image.",
        );
        setDownloading(null);
        return;
      }
      setDownloading(null);
    }
    const a = document.createElement("a");
    a.href = `/api/qr-codes/${qr.id}/image`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyLink() {
    if (!qr?.deep_link_url) return;
    try {
      await navigator.clipboard.writeText(qr.deep_link_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy the link.");
    }
  }

  const stored = qr !== null && isStored(qr);

  return (
    <Dialog open={qr !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {qr && (
          <>
            <DialogHeader>
              <DialogTitle>{qr.name ?? "Imported from WhatsApp"}</DialogTitle>
              <DialogDescription>
                {stored
                  ? "Created by WhatsApp — WACRM keeps the name and link."
                  : "This QR code exists in WhatsApp but has no WACRM name yet."}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-5 sm:grid-cols-[220px_minmax(0,1fr)]">
              <div className="mx-auto w-55 max-w-full overflow-hidden rounded-xl border border-border bg-white p-3 sm:mx-0">
                {stored ? (
                  // Keyed by format + timestamp so a re-render swaps the art.
                  <img
                    key={`${qr.image_format}-${qr.updated_at}`}
                    src={`/api/qr-codes/${qr.id}/image`}
                    alt={`WhatsApp QR code for ${qr.name}`}
                    className="h-auto w-full"
                  />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-muted text-xs text-muted-foreground">
                    Preview available after naming
                  </div>
                )}
              </div>
              <div className="grid min-w-0 content-start gap-3 text-sm">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Prefilled message
                  </p>
                  <p className="mt-0.5 break-words text-foreground">
                    {qr.prefilled_message || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Meta QR code
                  </p>
                  <p className="mt-0.5 font-mono text-xs break-all text-foreground">
                    {qr.meta_code}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    WhatsApp link
                  </p>
                  <p className="mt-0.5 truncate text-xs text-foreground">
                    {qr.deep_link_url || "—"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {stored && (
                    <Badge variant="secondary">{qr.image_format}</Badge>
                  )}
                  {qr.sync_status === "deleted_in_whatsapp" && (
                    <Badge variant="destructive">Deleted in WhatsApp</Badge>
                  )}
                  {qr.sync_status === "imported_from_whatsapp" && (
                    <Badge variant="outline">Imported from WhatsApp</Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {stored ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={downloading !== null}
                    onClick={() => downloadAs("SVG")}
                  >
                    {downloading === "SVG" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Download SVG
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={downloading !== null}
                    onClick={() => downloadAs("PNG")}
                  >
                    {downloading === "PNG" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    Download PNG
                  </Button>
                  {qr.deep_link_url && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={copyLink}
                      >
                        {copied ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                        {copied ? "Copied" : "Copy link"}
                      </Button>
                      <a
                        href={qr.deep_link_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open WhatsApp
                      </a>
                    </>
                  )}
                  {canEdit && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onEdit}
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={onDelete}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </>
                  )}
                </>
              ) : (
                canEdit && (
                  <Button type="button" size="sm" onClick={onNameImported}>
                    Assign a name in WACRM
                  </Button>
                )
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
