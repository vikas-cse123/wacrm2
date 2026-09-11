// All Sheets — isolated collection management.
//
// Exactly ONE spreadsheet per (account_id, kind). A flow must NEVER cause
// a second collection spreadsheet: callers MUST go through
// getOrCreateCollection() and then create tabs inside it.
//
// Owns ONLY all_sheet_collections. Reads flows for default titles.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSpreadsheet } from "@/lib/google/sheets";
import { isGoogleNotFoundError, listWorksheetTabs } from "@/lib/google/tabs";
import type { AllSheetCollectionRow, AllSheetKind } from "./types";

export function collectionTitleForKind(kind: AllSheetKind): string {
  return kind === "completed" ? "[All Sheets] Completed" : "[All Sheets] Incomplete";
}

/** Fetch the collection for (account, kind), or null when absent. */
export async function getCollection(
  db: SupabaseClient,
  accountId: string,
  kind: AllSheetKind,
): Promise<AllSheetCollectionRow | null> {
  const { data, error } = await db
    .from("all_sheet_collections")
    .select("*")
    .eq("account_id", accountId)
    .eq("kind", kind)
    .maybeSingle<AllSheetCollectionRow>();
  if (error) throw error;
  return data ?? null;
}

/**
 * Return the ONE collection spreadsheet for (account, kind), creating the
 * Google spreadsheet + row on first use. Concurrent creators race safely:
 * the UNIQUE(account_id, kind) constraint makes the second insert fail
 * with 23505, in which case we re-read the winner. Never creates two.
 */
export async function getOrCreateCollection(
  db: SupabaseClient,
  accountId: string,
  kind: AllSheetKind,
  accessToken: string,
): Promise<{ collection: AllSheetCollectionRow; created: boolean }> {
  const existing = await getCollection(db, accountId, kind);
  if (existing) {
    // Heal rows whose Drive spreadsheet was deleted out-of-band: a 404
    // means the file is truly gone, so drop the dead row and fall through
    // to create a fresh spreadsheet below. Any other error rethrows — a
    // transient failure must never orphan a live collection by spawning
    // a duplicate spreadsheet.
    try {
      await listWorksheetTabs(accessToken, existing.spreadsheet_id);
    } catch (err) {
      if (!isGoogleNotFoundError(err)) throw err;
      console.error("[all-sheets] collection spreadsheet gone in Drive, recreating.");
      await db.from("all_sheet_collections").delete().eq("id", existing.id);
      return getOrCreateCollection(db, accountId, kind, accessToken);
    }
    return { collection: existing, created: false };
  }

  const meta = await createSpreadsheet(accessToken, collectionTitleForKind(kind));

  const { data, error } = await db
    .from("all_sheet_collections")
    .insert({
      account_id: accountId,
      kind,
      spreadsheet_id: meta.spreadsheetId,
      spreadsheet_url: meta.url,
      spreadsheet_name: meta.title,
    })
    .select()
    .single<AllSheetCollectionRow>();

  if (!error && data) return { collection: data, created: true };

  // Lost a creation race (or the row appeared between our read and
  // insert): re-read the winner instead of creating a second spreadsheet.
  // The orphan Google spreadsheet from the lost race is left in Drive —
  // same convention as the rest of the codebase (config deleted, Drive
  // file retained).
  if ((error as { code?: string } | null)?.code === "23505") {
    const winner = await getCollection(db, accountId, kind);
    if (winner) return { collection: winner, created: false };
  }
  throw error ?? new Error("Failed to create All Sheets collection");
}
