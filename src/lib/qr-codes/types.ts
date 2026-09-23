import type { QrImageFormat } from "@/lib/whatsapp/meta-api";

/**
 * WACRM metadata row for a Meta message QR code. Meta remains the
 * source of truth for the code, deep link, and image — this row only
 * organizes them per account (display name + last-known Meta values).
 */
export interface QrCodeRecord {
  id: string;
  account_id: string;
  meta_code: string;
  name: string;
  prefilled_message: string;
  deep_link_url: string | null;
  qr_image_url: string | null;
  image_format: QrImageFormat;
  created_at: string;
  updated_at: string;
}

/** Sync status of a row relative to Meta's actual QR list. */
export type QrSyncStatus =
  /** Present in both WACRM and Meta. */
  | "active"
  /** Meta no longer has this code — offers safe local cleanup. */
  | "deleted_in_whatsapp"
  /** Exists in Meta but has no WACRM metadata yet. */
  | "imported_from_whatsapp";

export interface QrCodeView extends QrCodeRecord {
  sync_status: QrSyncStatus;
}

/** Meta-only QR code surfaced by sync (no local row yet). */
export interface ImportedQrCode {
  id: null;
  meta_code: string;
  name: null;
  prefilled_message: string | null;
  deep_link_url: string | null;
  qr_image_url: string | null;
  sync_status: "imported_from_whatsapp";
}

export const QR_NAME_MAX_LENGTH = 120;

/** WACRM-local display-name guard (our field, our limit). */
export function validateQrName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Name is required.");
  }
  const trimmed = name.trim();
  if (trimmed.length > QR_NAME_MAX_LENGTH) {
    throw new Error(
      `Name must be ${QR_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  return trimmed;
}
