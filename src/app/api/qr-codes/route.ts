import { NextResponse } from "next/server";

import { validateQrName } from "@/lib/qr-codes/types";
import {
  loadQrContext,
  qrErrorResponse,
  toQrCodeRecord,
} from "@/lib/qr-codes/server";
import {
  createMetaQrCode,
  isQrImageFormat,
  normalizeQrImageFormat,
  validateQrPrefilledMessage,
} from "@/lib/whatsapp/meta-api";

/**
 * GET /api/qr-codes — list this account's QR metadata (newest first).
 * Any authenticated account member may read. Meta reconciliation
 * lives in POST /api/qr-codes/sync; this stays a cheap local read.
 */
export async function GET() {
  try {
    const ctx = await loadQrContext();
    const { data, error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({
      connected: true,
      qr_codes: (data ?? []).map(toQrCodeRecord),
    });
  } catch (error) {
    return qrErrorResponse(error);
  }
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/qr-codes — create a REAL Meta QR code, then store the
 * WACRM display metadata. Admin+ only. Meta is authoritative: if
 * Meta rejects, nothing is stored.
 */
export async function POST(request: Request) {
  try {
    const ctx = await loadQrContext("admin");

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return badRequest("Invalid JSON body.");
    }

    let name: string;
    let prefilledMessage: string;
    try {
      name = validateQrName(body.name);
      prefilledMessage = validateQrPrefilledMessage(body.prefilled_message);
    } catch (error) {
      return badRequest(
        error instanceof Error ? error.message : "Invalid input.",
      );
    }
    if (body.image_format !== undefined && !isQrImageFormat(body.image_format)) {
      return badRequest("Image format must be SVG or PNG.");
    }
    const imageFormat = normalizeQrImageFormat(body.image_format);

    let meta;
    try {
      meta = await createMetaQrCode({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
        prefilledMessage,
        imageFormat,
      });
    } catch (error) {
      console.error(
        "[qr-codes] Meta create failed:",
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

    const { data, error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .upsert(
        {
          account_id: ctx.accountId,
          meta_code: meta.code,
          name,
          prefilled_message: meta.prefilled_message ?? prefilledMessage,
          deep_link_url: meta.deep_link_url,
          qr_image_url: meta.qr_image_url,
          image_format: imageFormat,
        },
        { onConflict: "account_id,meta_code" },
      )
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ qr_code: toQrCodeRecord(data) }, { status: 201 });
  } catch (error) {
    return qrErrorResponse(error);
  }
}
