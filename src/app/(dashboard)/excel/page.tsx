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
  const noFlowsConfigured = TRACKED_FLOWS.length === 0;

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

      {noFlowsConfigured ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          No flows are being tracked yet. Add one in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            src/lib/excel/tracked-flows.ts
          </code>{" "}
          (set the flow id and, optionally, a completion node), then redeploy.
        </div>
      ) : (
        <ExcelTable data={data} />
      )}
    </div>
  );
}
