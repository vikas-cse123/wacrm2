// All Sheets isolation guard.
//
// Static test: All Sheets code must never reference the PROTECTED
// Google Sheets mutable state or orchestration. Allowed shared surface:
// google_connections reads, getValidAccessToken, google/sheets.ts and
// google/tabs.ts REST helpers, sheet-columns/layout pure builders,
// flows/flow_runs/contacts reads, all_sheet_* tables.
//
// Mechanics: line/block comments are stripped and string-literal contents
// are ignored, so documentation prose may name the protected tables
// without tripping the guard. A token only counts in executable position:
//   - as a code identifier: resolveFlowSheetColumns(...),
//     <GoogleSheetsSyncForm />, { incomplete_synced_at: ... }
//   - as a query-builder call argument: .from("flow_sheet_configs"),
//     .select("..., incomplete_synced_at")
//
// Accepted scanner limitations: JS regex literals containing `//` or `/*`,
// and unbalanced quotes inside JSX text, can confuse the scan. Template
// `${}` interpolations are always scanned as code. (Note: regex patterns
// below are built from single-quoted strings on purpose — embedding a
// backtick inside a template literal broke the parser once already.)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/lib/all-sheets", "src/app/api/all-sheets", "src/app/(dashboard)/all-sheets"];

// This guard file itself names the tokens (in its own token list), so it
// is excluded from the scan.
const SELF_FILE = "isolation.test.ts";

// Forbidden: protected tables/columns + protected orchestration.
//
// `updateHeaderCells` (sheets.ts) is banned for All Sheets even though it
// is not a table: it embeds encodeURIComponent() ranges in the JSON
// request body, which Google rejects for multi-word tab titles
// (400 "Unable to parse range"). All Sheets must use
// `updateTabHeaderCells` (google/tabs.ts) instead. The name does not
// collide: "updateTabHeaderCells" never contains "updateHeaderCells".
const FORBIDDEN = [
  "flow_sheet_configs",
  "flow_incomplete_sheet_configs",
  "google_sheets_sync_failures",
  "incomplete_synced_at",
  "resolveFlowSheetColumns",
  "syncRunToGoogleSheet",
  "syncIncompleteRunsForFlow",
  "syncAllIncompleteSheets",
  "cleanupCompletedIncompleteRows",
  "GoogleSheetsSyncForm",
  "updateHeaderCells",
];

// Protected engine/UI files that must never gain an All Sheets dependency.
const PROTECTED_FILES = [
  "src/lib/flows/engine.ts",
  "src/lib/flows/sheet-sync.ts",
  "src/lib/flows/incomplete-sheet-sync.ts",
  "src/lib/flows/incomplete-sheet-cleanup.ts",
  "src/lib/flows/cron-runner.ts",
  "src/lib/cron/cron-runner.ts", // listed defensively; skipped when absent
  "src/app/(dashboard)/data-export/page.tsx",
  "src/components/flows/forms/node-config-form.tsx",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

/** Previous non-whitespace char in raw source (for the `'` heuristic). */
function prevSignificantChar(source: string, index: number): string {
  let j = index - 1;
  while (j >= 0 && /\s/.test(source[j] ?? "")) j--;
  return j >= 0 ? (source[j] ?? "") : "";
}

/**
 * Scan TS/TSX source, always dropping comments. When `keepStrings` is
 * false, string-literal contents are blanked (template `${}`
 * interpolations are still scanned as code, in both modes).
 */
function scan(source: string, keepStrings: boolean): string {
  let out = "";
  let i = 0;
  const n = source.length;

  const blank = (text: string): string => (keepStrings ? text : text.replace(/[^\n]/g, " "));

  const consumeTemplate = (): void => {
    out += keepStrings ? "`" : " ";
    i++;
    let chunk = "";
    const flush = (): void => {
      out += blank(chunk);
      chunk = "";
    };
    while (i < n) {
      const c: string = source[i] ?? "";
      if (c === "\\") {
        chunk += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        flush();
        out += keepStrings ? "`" : " ";
        i++;
        return;
      }
      if (c === "$" && (source[i + 1] ?? "") === "{") {
        flush();
        out += " ";
        i += 2;
        let depth = 1;
        let interp = "";
        while (i < n && depth > 0) {
          const ch: string = source[i] ?? "";
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          if (depth > 0) interp += ch;
          i++;
        }
        out += scan(interp, keepStrings);
        out += " ";
        continue;
      }
      chunk += c;
      i++;
    }
    flush();
  };

  while (i < n) {
    const c: string = source[i] ?? "";
    const next: string = i + 1 < n ? (source[i + 1] ?? "") : "";

    if (c === "/" && next === "/") {
      while (i < n && (source[i] ?? "") !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !((source[i] ?? "") === "*" && (source[i + 1] ?? "") === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "`" || c === "'") {
      // A `'` preceded by a word char is an apostrophe in JSX/prose text
      // (e.g. "don't"), not a string delimiter.
      if (c === "'" && isWordChar(prevSignificantChar(source, i))) {
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        consumeTemplate();
        continue;
      }
      out += keepStrings ? c : " ";
      i++;
      while (i < n) {
        const d: string = source[i] ?? "";
        if (d === "\\") {
          out += keepStrings ? source.slice(i, i + 2) : "  ";
          i += 2;
          continue;
        }
        if (d === "\n" || d === c) {
          out += d === "\n" ? "\n" : keepStrings ? c : " ";
          i++;
          break;
        }
        out += keepStrings ? d : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Source with comments removed, strings kept. */
function withoutComments(source: string): string {
  return scan(source, true);
}

/** Executable code only: no comments, no string-literal contents. */
function executableCode(source: string): string {
  return scan(source, false);
}

// A call-argument string looks like `("...",` — built from single-quoted
// parts so no backtick ever appears inside a template literal.
const QUOTE_CLASS = '["\'`]';
const NOT_QUOTE_NL = '[^"\'`\\n]';

function argUsePattern(token: string): RegExp {
  return new RegExp('[(,]\\s*' + QUOTE_CLASS + NOT_QUOTE_NL + '*\\b' + escapeRegExp(token) + '\\b');
}

/**
 * True when `token` appears in executable position: as a code identifier,
 * or as a query-builder call argument (`.from("...")`, `.select("...")`).
 * Mentions inside comments or plain strings do not count.
 */
export function containsExecutableReference(source: string, token: string): boolean {
  const code = executableCode(source);
  if (new RegExp('\\b' + escapeRegExp(token) + '\\b').test(code)) return true;
  return argUsePattern(token).test(withoutComments(source));
}

/** True when the `all_sheet_` prefix appears in executable position. */
function containsAllSheetReference(source: string): boolean {
  if (executableCode(source).includes("all_sheet_")) return true;
  return new RegExp('[(,]\\s*' + QUOTE_CLASS + NOT_QUOTE_NL + '*all_sheet_').test(
    withoutComments(source),
  );
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectFiles(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("all-sheets isolation", () => {
  it("never references protected Google Sheets state or engines", () => {
    const cwd = process.cwd();
    const files = ROOTS.flatMap((r) => collectFiles(join(cwd, r))).filter(
      (f) => !f.endsWith(SELF_FILE),
    );
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      for (const token of FORBIDDEN) {
        if (containsExecutableReference(content, token)) violations.push(`${f}: ${token}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("existing Google Sheets engine and UI files do not reference all_sheet tables", () => {
    const cwd = process.cwd();
    const violations: string[] = [];
    let checked = 0;
    for (const rel of PROTECTED_FILES) {
      let content: string;
      try {
        content = readFileSync(join(cwd, rel), "utf8");
      } catch {
        continue; // defensively listed path absent — nothing to check
      }
      checked++;
      if (containsAllSheetReference(content)) violations.push(`${rel}: all_sheet_`);
    }
    expect(checked).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
