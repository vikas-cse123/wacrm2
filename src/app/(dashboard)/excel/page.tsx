import { redirect } from "next/navigation";

import { getCurrentAccount } from "@/lib/auth/account";
import { buildExcelData } from "@/lib/excel/build-excel-data";
import { TRACKED_FLOWS } from "@/lib/excel/tracked-flows";
import { ExcelTable } from "@/components/excel/excel-table";

// Always render per-request: the data depends on the caller's account
// and live flow runs.
export const dynamic = "force-dynamic";

export default async function ExcelPage() {
  // Owner-only, account-scoped. getCurrentAccount() throws for
  // unauthenticated / no-account callers → treat as non-owner.
  const ctx = await getCurrentAccount().catch(() => null);
  if (!ctx || ctx.role !== "owner") redirect("/dashboard");

  const data = await buildExcelData(ctx.accountId);
  const showingAllFlows = TRACKED_FLOWS.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Flow completions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone who has completed a tracked flow, with their answers to
          every question — in a spreadsheet you can search and export.
        </p>
      </div>

      {showingAllFlows && (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          Showing <strong>all flows</strong> and every ended run. To narrow to
          specific flows — or to count a run complete the moment it reaches a
          chosen node (e.g. the &ldquo;How many nights…&rdquo; node) — edit{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            src/lib/excel/tracked-flows.ts
          </code>
          .
        </div>
      )}

      <ExcelTable data={data} />
    </div>
  );
}
