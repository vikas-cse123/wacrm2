import { NextResponse } from "next/server";

import { validateQrName } from "@/lib/qr-codes/types";
import { loadQrContext, qrErrorResponse, toQrCodeRecord } from "@/lib/qr-codes/server";
import { listMetaQrCodes } from "@/lib/whatsapp/meta-api";

/**
 * POST /api/qr-codes/adopt — attach a WACRM display name to a QR
 * code that already exists in WhatsApp (surfaced by sync as
 * `imported_from_whatsapp`). Admin+ only. The code must genuinely
 * exist in Meta: its last-known values are read from Meta, never
 * trusted from the browser.
 */
export async function POST(request: Request) {
  try {
    const ctx = await loadQrContext("admin");

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    let name: string;
    try {
      name = validateQrName(body.name);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid input." },
        { status: 400 },
      );
    }
    const metaCode =
      typeof body.meta_code === "string" ? body.meta_code.trim() : "";
    if (!metaCode) {
      return NextResponse.json(
        { error: "Meta QR code is required." },
        { status: 400 },
      );
    }

    let live;
    try {
      const all = await listMetaQrCodes({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
      });
      live = all.find((m) => m.code === metaCode) ?? null;
    } catch (error) {
      console.error(
        "[qr-codes] Meta lookup failed:",
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
    if (!live) {
      return NextResponse.json(
        { error: "This QR code no longer exists in WhatsApp." },
        { status: 410 },
      );
    }

    const { data, error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .upsert(
        {
          account_id: ctx.accountId,
          meta_code: live.code,
          name,
          prefilled_message: live.prefilled_message ?? "",
          deep_link_url: live.deep_link_url,
          qr_image_url: live.qr_image_url,
          // Best-effort label for the existing artwork (the download
          // proxy always sniffs the real content type, so a wrong
          // guess here never corrupts a download).
          image_format:
            live.qr_image_url && /\.png(\?|$)/i.test(live.qr_image_url)
              ? "PNG"
              : "SVG",
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
