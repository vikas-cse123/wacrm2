import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";

/**
 * GET/PUT /api/account/reminder-template — the account's fallback
 * template for WhatsApp reminders sent outside the 24-hour
 * customer-service window ({{1}} = reminder message).
 *
 *   GET — { template_name, template_language } (nulls when
 *     unconfigured). Any member.
 *   PUT — { template_name: string | null, template_language?: string }
 *     Admin+. Null clears the setting. A named template must exist
 *     in this account, be APPROVED, and carry exactly one {{1}}
 *     body variable (the reminder text slot) — anything else 400s
 *     so a misconfiguration surfaces at save time, not at 3am in
 *     the scheduler.
 */

const MAX_NAME_LEN = 120;

function countBodyVariables(bodyText: unknown): number | null {
  if (typeof bodyText !== "string") return null;
  const matches = bodyText.match(/\{\{(\d+)\}\}/g) ?? [];
  const indices = matches.map((m) => Number(m.slice(2, -2)));
  if (indices.length === 0) return 0;
  if (indices.some((n) => n !== 1)) return -1;
  return indices.length;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("accounts")
      .select("reminder_template_name, reminder_template_language")
      .eq("id", ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? {}) as {
      reminder_template_name?: string | null;
      reminder_template_language?: string | null;
    };
    const name = row.reminder_template_name ?? null;
    return NextResponse.json({
      template_name: name,
      template_language: name ? (row.reminder_template_language ?? "en_US") : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { template_name: rawName, template_language: rawLanguage } = body;

    // Explicit null (or empty string) clears the setting; a missing
    // template_name is a malformed request.
    if (rawName === null || rawName === "") {
      const { error } = await ctx.supabase
        .from("accounts")
        .update({ reminder_template_name: null, reminder_template_language: null })
        .eq("id", ctx.accountId);
      if (error) throw error;
      return NextResponse.json({ template_name: null, template_language: null });
    }

    if (rawName === undefined) {
      return NextResponse.json(
        { error: "template_name is required." },
        { status: 400 },
      );
    }

    if (typeof rawName !== "string" || !rawName.trim()) {
      return NextResponse.json(
        { error: "template_name is required." },
        { status: 400 },
      );
    }
    const templateName = rawName.trim();
    if (templateName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: "template_name is too long." },
        { status: 400 },
      );
    }
    const language =
      typeof rawLanguage === "string" && rawLanguage.trim()
        ? rawLanguage.trim()
        : "en_US";

    const { data: template, error: templateErr } = await ctx.supabase
      .from("message_templates")
      .select("name, language, status, body_text")
      .eq("account_id", ctx.accountId)
      .eq("name", templateName)
      .eq("language", language)
      .maybeSingle();
    if (templateErr) throw templateErr;
    const row = template as {
      status?: string;
      body_text?: unknown;
    } | null;
    if (!row) {
      return NextResponse.json(
        { error: "Template not found in this account." },
        { status: 400 },
      );
    }
    if (row.status !== "APPROVED") {
      return NextResponse.json(
        { error: "Template must be APPROVED by Meta." },
        { status: 400 },
      );
    }
    if (countBodyVariables(row.body_text) !== 1) {
      return NextResponse.json(
        { error: "Template body must contain exactly one {{1}} variable for the reminder text." },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase
      .from("accounts")
      .update({
        reminder_template_name: templateName,
        reminder_template_language: language,
      })
      .eq("id", ctx.accountId);
    if (error) throw error;
    return NextResponse.json({
      template_name: templateName,
      template_language: language,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
