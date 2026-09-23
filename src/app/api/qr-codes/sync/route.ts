import { NextResponse } from "next/server";

import type {
  ImportedQrCode,
  QrCodeView,
} from "@/lib/qr-codes/types";
import { loadQrContext, qrErrorResponse, toQrCodeRecord } from "@/lib/qr-codes/server";
import { listMetaQrCodes } from "@/lib/whatsapp/meta-api";

/**
 * POST /api/qr-codes/sync — reconcile WACRM metadata with Meta's
 * ACTUAL QR list. Admin+ only. Never recreates Meta codes that were
 * deleted in WhatsApp; those surface as `deleted_in_whatsapp` for
 * safe local cleanup, and Meta-only codes surface as
 * `imported_from_whatsapp` until named locally.
 */
export async function POST() {
  try {
    const ctx = await loadQrContext("admin");

    let meta;
    try {
      meta = await listMetaQrCodes({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
      });
    } catch (error) {
      console.error(
        "[qr-codes] Meta sync failed:",
        error instanceof Error ? error.message : error,
      );
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Meta API request failed.",
        },
        { status: 502 },
      );
    }
    const byCode = new Map(meta.map((m) => [m.code, m]));

    const { data: rows, error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const qr_codes: QrCodeView[] = [];
    for (const row of rows ?? []) {
      const record = toQrCodeRecord(row);
      const live = byCode.get(record.meta_code);
      if (!live) {
        qr_codes.push({ ...record, sync_status: "deleted_in_whatsapp" });
        continue;
      }
      // Refresh last-known Meta values when they drifted.
      const drifted =
        (live.prefilled_message ?? null) !== record.prefilled_message ||
        (live.deep_link_url ?? null) !== record.deep_link_url ||
        (live.qr_image_url ?? null) !== record.qr_image_url;
      if (drifted) {
        const { data: updated, error: updateError } = await ctx.supabase
          .from("whatsapp_qr_codes")
          .update({
            prefilled_message:
              live.prefilled_message ?? record.prefilled_message,
            deep_link_url: live.deep_link_url,
            qr_image_url: live.qr_image_url,
          })
          .eq("id", record.id)
          .eq("account_id", ctx.accountId)
          .select()
          .single();
        if (!updateError && updated) {
          qr_codes.push({
            ...toQrCodeRecord(updated),
            sync_status: "active",
          });
          continue;
        }
      }
      qr_codes.push({ ...record, sync_status: "active" });
    }

    const known = new Set((rows ?? []).map((r) => r.meta_code as string));
    const imported: ImportedQrCode[] = meta
      .filter((m) => !known.has(m.code))
      .map((m) => ({
        id: null,
        meta_code: m.code,
        name: null,
        prefilled_message: m.prefilled_message,
        deep_link_url: m.deep_link_url,
        qr_image_url: m.qr_image_url,
        sync_status: "imported_from_whatsapp" as const,
      }));

    return NextResponse.json({ qr_codes, imported });
  } catch (error) {
    return qrErrorResponse(error);
  }
}
