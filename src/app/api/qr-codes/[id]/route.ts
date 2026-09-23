import { NextResponse } from "next/server";

import { validateQrName } from "@/lib/qr-codes/types";
import { loadQrContext, qrErrorResponse, toQrCodeRecord } from "@/lib/qr-codes/server";
import {
  deleteMetaQrCode,
  isMetaQrNotFoundError,
  isQrImageFormat,
  normalizeQrImageFormat,
  updateMetaQrCode,
  validateQrPrefilledMessage,
} from "@/lib/whatsapp/meta-api";
function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

async function loadRow(ctx: Awaited<ReturnType<typeof loadQrContext>>, id: string) {
  const { data, error } = await ctx.supabase
    .from("whatsapp_qr_codes")
    .select("*")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * PATCH /api/qr-codes/[id] — rename locally, and/or update the
 * prefilled message in Meta. Admin+ only. The row is always scoped
 * by (id, account_id): cross-account ids resolve to 404.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await loadQrContext("admin");
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return badRequest("Invalid JSON body.");
    }
    const wantsName = "name" in body;
    const wantsMessage = "prefilled_message" in body;
    const wantsFormat = "image_format" in body;
    if (!wantsName && !wantsMessage && !wantsFormat) {
      return badRequest("Nothing to update.");
    }

    let name: string | undefined;
    let prefilledMessage: string | undefined;
    try {
      if (wantsName) name = validateQrName(body.name);
      if (wantsMessage) {
        prefilledMessage = validateQrPrefilledMessage(body.prefilled_message);
      }
    } catch (error) {
      return badRequest(
        error instanceof Error ? error.message : "Invalid input.",
      );
    }
    if (wantsFormat && !isQrImageFormat(body.image_format)) {
      return badRequest("Image format must be SVG or PNG.");
    }
    const imageFormat =
      wantsFormat ? normalizeQrImageFormat(body.image_format) : undefined;

    const row = await loadRow(ctx, id);
    if (!row) {
      return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    }

    // Prefilled-message edits go to Meta first — Meta is authoritative.
    // A format-only change also re-renders through Meta (same endpoint
    // with the current message) so the stored image never desyncs from
    // what Meta actually holds.
    let meta = null;
    const storedFormat = normalizeQrImageFormat(row.image_format as string);
    const effectiveMessage =
      prefilledMessage ?? (row.prefilled_message as string);
    const needsMetaRender =
      (wantsMessage && prefilledMessage !== undefined) ||
      (imageFormat !== undefined && imageFormat !== storedFormat);
    if (needsMetaRender) {
      try {
        meta = await updateMetaQrCode({
          phoneNumberId: ctx.phoneNumberId,
          accessToken: ctx.accessToken,
          code: row.meta_code as string,
          prefilledMessage: effectiveMessage,
          imageFormat,
        });
      } catch (error) {
        if (isMetaQrNotFoundError(error)) {
          return NextResponse.json(
            {
              error:
                "This QR code no longer exists in WhatsApp. Remove it to reconcile.",
              meta_missing: true,
            },
            { status: 410 },
          );
        }
        console.error(
          "[qr-codes] Meta update failed:",
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
    }

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (imageFormat !== undefined) patch.image_format = imageFormat;
    if (meta) {
      patch.prefilled_message =
        meta.prefilled_message ?? effectiveMessage;
      if (meta.deep_link_url) patch.deep_link_url = meta.deep_link_url;
      if (meta.qr_image_url) patch.qr_image_url = meta.qr_image_url;
    }
    const { data, error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ qr_code: toQrCodeRecord(data) });
  } catch (error) {
    return qrErrorResponse(error);
  }
}

/**
 * DELETE /api/qr-codes/[id] — delete the REAL Meta QR code, then
 * remove local metadata. Admin+ only. If Meta reports the code is
 * already gone, local state is still reconciled (reported back so
 * the UI can say so instead of crashing).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await loadQrContext("admin");
    const { id } = await params;

    const row = await loadRow(ctx, id);
    if (!row) {
      return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    }

    let reconciled = false;
    try {
      await deleteMetaQrCode({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
        code: row.meta_code as string,
      });
    } catch (error) {
      if (!isMetaQrNotFoundError(error)) {
        console.error(
          "[qr-codes] Meta delete failed:",
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
      reconciled = true;
    }

    const { error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) throw error;
    return NextResponse.json({ deleted: true, reconciled });
  } catch (error) {
    return qrErrorResponse(error);
  }
}
