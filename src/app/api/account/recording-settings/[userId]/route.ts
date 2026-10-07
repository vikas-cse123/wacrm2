// ============================================================
// /api/account/recording-settings/[userId]
//
//   GET — read one member's WhatsApp recording source.
//   PUT — set one member's WhatsApp recording source.
//
// Per-user, mutually exclusive: exactly one of
// 'none' | 'whatsapp' | 'whatsapp_business' is effective.
// Absence of a row means 'none' (safe default — recording an
// app nobody chose is opt-in, never inherited).
//
// Authorization (server-derived, never client input):
//   - GET: the user themselves, or the account owner.
//   - PUT: the user themselves, or the account owner.
//     Agents/viewers cannot configure another member.
// Target must belong to the caller's account, else 404 (no
// cross-tenant oracle). Writes go through the RLS-scoped
// caller client, whose owner-only WITH CHECK policy backstops
// the requireRole/hasMinRole checks here.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";

export const VALID_SOURCES = ["none", "whatsapp", "whatsapp_business"] as const;
export type RecordingSource = (typeof VALID_SOURCES)[number];

export function isRecordingSource(value: unknown): value is RecordingSource {
  return (
    typeof value === "string" &&
    (VALID_SOURCES as readonly string[]).includes(value)
  );
}

interface SettingRow {
  user_id: string;
  whatsapp_recording_source: string;
  updated_at: string;
}

function toSetting(userId: string, row: SettingRow | null) {
  return {
    user_id: userId,
    whatsapp_recording_source: row?.whatsapp_recording_source ?? "none",
    updated_at: row?.updated_at ?? null,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { userId } = await params;

    const isSelf = userId === ctx.userId;
    if (!isSelf && !hasMinRole(ctx.role, "owner")) {
      return NextResponse.json(
        { error: "Only the account owner can view another member's recording settings" },
        { status: 403 },
      );
    }

    // Target must be in the caller's account — same 404 as a
    // missing contact, never a cross-account signal.
    const { data: member, error: memberError } = await ctx.supabase
      .from("profiles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const { data: row, error } = await ctx.supabase
      .from("user_recording_settings")
      .select("user_id, whatsapp_recording_source, updated_at")
      .eq("account_id", ctx.accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;

    return NextResponse.json({
      setting: toSetting(userId, row as SettingRow | null),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { userId } = await params;

    const isSelf = userId === ctx.userId;
    if (!isSelf && !hasMinRole(ctx.role, "owner")) {
      return NextResponse.json(
        { error: "Only the account owner can configure another member's recording settings" },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as {
      whatsapp_recording_source?: unknown;
    } | null;
    if (!isRecordingSource(body?.whatsapp_recording_source)) {
      return NextResponse.json(
        { error: "'whatsapp_recording_source' must be one of none, whatsapp, whatsapp_business" },
        { status: 400 },
      );
    }
    const source = body.whatsapp_recording_source;

    const { data: member, error: memberError } = await ctx.supabase
      .from("profiles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const { data: row, error } = await ctx.supabase
      .from("user_recording_settings")
      .upsert(
        {
          account_id: ctx.accountId,
          user_id: userId,
          whatsapp_recording_source: source,
          updated_by: ctx.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id,user_id" },
      )
      .select("user_id, whatsapp_recording_source, updated_at")
      .single();
    if (error) throw error;

    return NextResponse.json({
      setting: toSetting(userId, row as SettingRow),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
