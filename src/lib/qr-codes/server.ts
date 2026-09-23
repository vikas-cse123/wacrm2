import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { decrypt } from "@/lib/whatsapp/encryption";
import { normalizeQrImageFormat } from "@/lib/whatsapp/meta-api";
import type { QrCodeRecord } from "./types";

// ============================================================
// Server-side QR context — resolves everything from the session.
// The browser never supplies account_id or phone_number_id.
// ============================================================

export interface QrContext {
  supabase: SupabaseClient;
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
}

export class QrNotConnectedError extends Error {
  readonly status = 400 as const;
  constructor() {
    super("No WhatsApp number is connected.");
    this.name = "QrNotConnectedError";
  }
}

/**
 * Resolve the caller's account + connected WhatsApp number.
 * `minRole` gates writes ('admin'); reads use the default (any
 * authenticated account member).
 */
export async function loadQrContext(
  minRole: "admin" | "agent" | "viewer" = "viewer",
): Promise<QrContext> {
  const ctx =
    minRole === "viewer"
      ? await getCurrentAccount()
      : await requireRole(minRole);
  const { data: config, error } = await ctx.supabase
    .from("whatsapp_config")
    .select("phone_number_id, access_token")
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (error || !config) throw new QrNotConnectedError();
  return {
    supabase: ctx.supabase,
    accountId: ctx.accountId,
    phoneNumberId: config.phone_number_id as string,
    accessToken: decrypt(config.access_token as string),
  };
}

interface QrRow {
  id: string;
  account_id: string;
  meta_code: string;
  name: string;
  prefilled_message: string;
  deep_link_url: string | null;
  qr_image_url: string | null;
  image_format: string | null;
  created_at: string;
  updated_at: string;
}

/** Narrow a DB row into the API shape (never leaks anything extra). */export function toQrCodeRecord(row: QrRow): QrCodeRecord {
  return {
    id: row.id,
    account_id: row.account_id,
    meta_code: row.meta_code,
    name: row.name,
    prefilled_message: row.prefilled_message,
    deep_link_url: row.deep_link_url,
    qr_image_url: row.qr_image_url,
    image_format: normalizeQrImageFormat(row.image_format),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Route-level error mapping. `toErrorResponse` only classifies auth
 * errors, so the missing-connection case is handled here (400, not
 * 500) — mirroring the business-profile route's `{ connected: false }`
 * shape. Meta failures are mapped by each route to 502.
 */
export function qrErrorResponse(error: unknown): NextResponse {
  if (error instanceof QrNotConnectedError) {
    return NextResponse.json(
      { connected: false, message: error.message },
      { status: 400 },
    );
  }
  return toErrorResponse(error);
}
