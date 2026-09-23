import { NextResponse } from "next/server";

import { loadQrContext, qrErrorResponse } from "@/lib/qr-codes/server";
import { listMetaQrCodes } from "@/lib/whatsapp/meta-api";

function safeFileStem(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || "whatsapp-qr";
}

/**
 * GET /api/qr-codes/[id]/image — stream Meta's QR image bytes as a
 * download. Any authenticated account member may download. The
 * browser never sees Meta credentials: the server resolves a fresh
 * image URL from Meta (falling back to the stored one), fetches the
 * bytes, and re-serves them with a download disposition.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await loadQrContext();
    const { id } = await params;

    const { data: row, error } = await ctx.supabase
      .from("whatsapp_qr_codes")
      .select("*")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    }

    // Prefer a fresh Meta URL (stored URLs can rotate); fall back to
    // the last-known one so a transient Meta failure still downloads.
    let imageUrl = row.qr_image_url as string | null;
    try {
      const live = await listMetaQrCodes({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
      });
      const match = live.find((m) => m.code === (row.meta_code as string));
      if (match?.qr_image_url) imageUrl = match.qr_image_url;
    } catch (error) {
      console.error(
        "[qr-codes] image refresh failed, using stored URL:",
        error instanceof Error ? error.message : error,
      );
    }
    if (!imageUrl) {
      return NextResponse.json(
        { error: "No QR image is available for this code yet." },
        { status: 404 },
      );
    }

    let upstream: Response;
    try {
      upstream = await fetch(imageUrl, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return NextResponse.json(
        { error: "Could not fetch the QR image from WhatsApp." },
        { status: 502 },
      );
    }
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: "Could not fetch the QR image from WhatsApp." },
        { status: 502 },
      );
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return NextResponse.json(
        { error: "WhatsApp did not return a QR image." },
        { status: 502 },
      );
    }
    const ext = contentType.includes("svg") ? "svg" : "png";
    const filename = `${safeFileStem(row.name as string)}.${ext}`;
    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return qrErrorResponse(error);
  }
}
