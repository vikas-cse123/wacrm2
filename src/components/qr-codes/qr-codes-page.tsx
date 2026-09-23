"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Copy,
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ImportedQrCode,
  QrCodeRecord,
  QrSyncStatus,
} from "@/lib/qr-codes/types";
import { CreateQrDialog } from "./create-qr-dialog";
import { DeleteQrDialog } from "./delete-qr-dialog";
import { EditQrDialog } from "./edit-qr-dialog";
import { NameImportedDialog } from "./name-imported-dialog";
import { QrDetailDialog, type DetailQr } from "./qr-detail-dialog";

type LocalQr = QrCodeRecord & { sync_status?: QrSyncStatus };

function formatDate(iso: string): string {
  try {
    return format(new Date(iso), "d MMM yyyy");
  } catch {
    return "—";
  }
}

function StatusBadge({ status }: { status?: QrSyncStatus }) {
  if (status === "deleted_in_whatsapp") {
    return <Badge variant="destructive">Deleted in WhatsApp</Badge>;
  }
  if (status === "imported_from_whatsapp") {
    return <Badge variant="outline">Imported from WhatsApp</Badge>;
  }
  return null;
}

export function QrCodesPage() {
  const { canEditSettings } = useAuth();
  const [items, setItems] = useState<LocalQr[]>([]);
  const [imported, setImported] = useState<ImportedQrCode[]>([]);
  const [synced, setSynced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<DetailQr | null>(null);
  const [editQr, setEditQr] = useState<QrCodeRecord | null>(null);
  const [deleteQr, setDeleteQr] = useState<QrCodeRecord | null>(null);
  const [nameQr, setNameQr] = useState<ImportedQrCode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/qr-codes", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as {
        connected?: boolean;
        message?: string;
        error?: string;
        qr_codes?: LocalQr[];
      } | null;
      if (!res.ok) {
        if (res.status === 400 && json?.connected === false) {
          setNotConnected(true);
          setItems([]);
          return;
        }
        throw new Error(json?.error ?? "Could not load QR codes.");
      }
      setNotConnected(false);
      setItems(json?.qr_codes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load QR codes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/qr-codes/sync", { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        qr_codes?: LocalQr[];
        imported?: ImportedQrCode[];
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Sync failed.");
      setItems(json?.qr_codes ?? []);
      setImported(json?.imported ?? []);
      setSynced(true);
      toast.success("Synced with WhatsApp.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }, []);

  const stats = useMemo(() => {
    const active = synced
      ? items.filter((i) => i.sync_status !== "deleted_in_whatsapp").length
      : items.length;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = items.filter((i) => {
      const t = Date.parse(i.created_at);
      return !Number.isNaN(t) && t >= weekAgo;
    }).length;
    return { total: items.length, active, recent };
  }, [items, synced]);

  function openDetail(qr: DetailQr) {
    setDetail(qr);
  }

  function handleDeleted(reconciled: boolean) {
    setDetail(null);
    setDeleteQr(null);
    toast.success(
      reconciled
        ? "Removed — it was already deleted in WhatsApp."
        : "QR code deleted from WhatsApp.",
    );
    load();
  }

  async function copyLink(url: string | null) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("WhatsApp link copied.");
    } catch {
      toast.error("Could not copy the link.");
    }
  }

  function downloadImage(id: string) {
    const a = document.createElement("a");
    a.href = `/api/qr-codes/${id}/image`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            WhatsApp QR Codes
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Turn offline and online touchpoints into WhatsApp conversations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && (
            <Button
              type="button"
              variant="outline"
              onClick={sync}
              disabled={syncing || loading}
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Sync with WhatsApp
            </Button>
          )}
          {canEditSettings && (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create QR Code
            </Button>
          )}
        </div>
      </div>

      {/* Stats — local counts only. A scan is not a conversation, so no
          scan/lead metrics are shown. */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          {
            label: "Total QR Codes",
            value: String(stats.total),
            hint: synced ? "In this workspace" : "Sync to verify with WhatsApp",
          },
          {
            label: "Active in WhatsApp",
            value: synced ? String(stats.active) : "—",
            hint: synced ? "Confirmed by last sync" : "Press Sync with WhatsApp",
          },
          {
            label: "Recently Created",
            value: String(stats.recent),
            hint: "In the last 7 days",
          },
        ].map((s) => (
          <Card key={s.label} className="px-5 py-4">
            <p className="text-2xl font-bold text-foreground">{s.value}</p>
            <p className="mt-0.5 text-sm font-medium text-foreground">{s.label}</p>
            <p className="text-xs text-muted-foreground">{s.hint}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        {loading ? (
          <Card className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-12 w-12 animate-pulse rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </Card>
        ) : notConnected ? (
          <Card className="px-5 py-12 text-center">
            <QrCode className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-base font-semibold text-foreground">
              No WhatsApp number connected
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Connect a WhatsApp Business number first — QR codes live on
              that number.
            </p>
            <Link
              href="/settings?tab=whatsapp"
              className={buttonVariants({ className: "mt-4" })}
            >
              Open WhatsApp settings
            </Link>
          </Card>
        ) : error ? (
          <Card className="px-5 py-12 text-center">
            <p className="text-base font-semibold text-foreground">
              Could not load QR codes
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <Button type="button" variant="outline" className="mt-4" onClick={load}>
              Try again
            </Button>
          </Card>
        ) : items.length === 0 && imported.length === 0 ? (
          <Card className="px-5 py-12 text-center">
            <QrCode className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-base font-semibold text-foreground">
              Connect your customers to WhatsApp with a scan.
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Create a WhatsApp QR code with a pre-filled message. Place it
              on your website, brochures, ads, reception desk, visiting
              cards, or travel packages.
            </p>
            {canEditSettings && (
              <Button
                type="button"
                className="mt-4"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Create your first QR Code
              </Button>
            )}
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Desktop table */}
            <Card className="hidden overflow-hidden p-0 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>QR Preview</TableHead>
                    <TableHead>Prefilled Message</TableHead>
                    <TableHead>WhatsApp Link</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((qr) => (
                    <TableRow key={qr.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => openDetail(qr)}
                          className="flex items-center gap-2 text-left font-medium text-foreground hover:text-primary focus-visible:underline focus-visible:outline-none"
                        >
                          {qr.name}
                        </button>
                        <div className="mt-1">
                          <StatusBadge status={qr.sync_status} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => openDetail(qr)}
                          aria-label={`Preview ${qr.name}`}
                          className="block overflow-hidden rounded-md border border-border bg-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <img
                            src={`/api/qr-codes/${qr.id}/image`}
                            alt=""
                            loading="lazy"
                            className="h-12 w-12 object-cover"
                          />
                        </button>
                      </TableCell>
                      <TableCell className="max-w-70">
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {qr.prefilled_message}
                        </p>
                      </TableCell>
                      <TableCell>
                        {qr.deep_link_url ? (
                          <a
                            href={qr.deep_link_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                          >
                            Open WhatsApp
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {formatDate(qr.created_at)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Actions for ${qr.name}`}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openDetail(qr)}>
                              View details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => copyLink(qr.deep_link_url)}
                            >
                              <Copy className="h-4 w-4" />
                              Copy link
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => downloadImage(qr.id)}
                            >
                              <Download className="h-4 w-4" />
                              Download QR
                            </DropdownMenuItem>
                            {canEditSettings && (
                              <>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setDetail(null);
                                    setEditQr(qr);
                                  }}
                                >
                                  <Pencil className="h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setDetail(null);
                                    setDeleteQr(qr);
                                  }}
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            {/* Mobile cards */}
            <div className="grid gap-3 md:hidden">
              {items.map((qr) => (
                <Card key={qr.id} className="flex gap-3 p-4">
                  <button
                    type="button"
                    onClick={() => openDetail(qr)}
                    aria-label={`Preview ${qr.name}`}
                    className="shrink-0 overflow-hidden rounded-lg border border-border bg-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <img
                      src={`/api/qr-codes/${qr.id}/image`}
                      alt=""
                      loading="lazy"
                      className="h-20 w-20 object-cover"
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => openDetail(qr)}
                      className="truncate text-left text-sm font-semibold text-foreground focus-visible:underline focus-visible:outline-none"
                    >
                      {qr.name}
                    </button>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {qr.prefilled_message}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <StatusBadge status={qr.sync_status} />
                      <span className="text-xs text-muted-foreground">
                        {formatDate(qr.created_at)}
                      </span>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Actions for ${qr.name}`}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openDetail(qr)}>
                        View details
                      </DropdownMenuItem>
                      {qr.deep_link_url && (
                        <DropdownMenuItem
                          onClick={() =>
                            window.open(
                              qr.deep_link_url as string,
                              "_blank",
                              "noopener,noreferrer",
                            )
                          }
                        >
                          <ExternalLink className="h-4 w-4" />
                          Open WhatsApp
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => downloadImage(qr.id)}>
                        <Download className="h-4 w-4" />
                        Download QR
                      </DropdownMenuItem>
                      {canEditSettings && (
                        <>
                          <DropdownMenuItem
                            onClick={() => {
                              setDetail(null);
                              setEditQr(qr);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setDetail(null);
                              setDeleteQr(qr);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Card>
              ))}
            </div>

            {/* Imported from WhatsApp — needs a local name. */}
            {imported.length > 0 && (
              <Card className="p-5">
                <p className="text-sm font-semibold text-foreground">
                  Found in WhatsApp ({imported.length})
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  These QR codes exist on your number but have no WACRM name
                  yet. Naming them changes nothing in WhatsApp.
                </p>
                <div className="mt-3 space-y-2">
                  {imported.map((qr) => (
                    <div
                      key={qr.meta_code}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-foreground">
                          {qr.meta_code}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {qr.prefilled_message || "No prefilled message"}
                        </p>
                      </div>
                      {canEditSettings ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setNameQr(qr)}
                        >
                          Assign name
                        </Button>
                      ) : (
                        <Badge variant="outline">Imported from WhatsApp</Badge>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      <CreateQrDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />
      <QrDetailDialog
        qr={detail}
        canEdit={canEditSettings}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        onEdit={() => {
          if (detail && detail.id !== null) {
            setEditQr(detail as QrCodeRecord);
            setDetail(null);
          }
        }}
        onDelete={() => {
          if (detail && detail.id !== null) {
            setDeleteQr(detail as QrCodeRecord);
            setDetail(null);
          }
        }}
        onNameImported={() => {
          if (detail && detail.id === null) {
            setNameQr(detail as ImportedQrCode);
            setDetail(null);
          }
        }}
      />
      <EditQrDialog
        qr={editQr}
        open={editQr !== null}
        onOpenChange={(open) => {
          if (!open) setEditQr(null);
        }}
        onSaved={load}
      />
      <DeleteQrDialog
        qr={deleteQr}
        open={deleteQr !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteQr(null);
        }}
        onDeleted={handleDeleted}
      />
      <NameImportedDialog
        qr={nameQr}
        open={nameQr !== null}
        onOpenChange={(open) => {
          if (!open) setNameQr(null);
        }}
        onNamed={() => {
          load();
          sync();
        }}
      />
    </div>
  );
}
