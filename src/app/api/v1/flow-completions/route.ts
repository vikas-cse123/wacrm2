// ============================================================
// GET /api/v1/flow-completions — live export of the /excel data.
//
// The machine-readable twin of the /excel page: the same tracked-flow
// completions, as CSV (default) or JSON, authenticated with an account
// API key. This is how a client "connects Excel to their CRM" — point
// Excel Power Query (Data → From Web), Google Sheets, or the CRM's HTTP
// importer at this URL and it stays in sync.
//
// Auth (either works):
//   • Authorization: Bearer wacrm_live_…   (preferred — keeps the key
//     out of URLs/logs)
//   • ?key=wacrm_live_…                     (for tools that can't send a
//     header, e.g. Google Sheets IMPORTDATA / Excel legacy From Web)
// Scope required: conversations:read.
//
// Query:
//   ?format=csv (default) | json
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { ok, toApiErrorResponse } from "@/lib/api/v1/respond";
import { buildExcelData } from "@/lib/excel/build-excel-data";
import { excelToCsv, excelToJson } from "@/lib/excel/serialize";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);

    // Allow the key via ?key= for header-less clients. Synthesize the
    // Authorization header so requireApiKey stays the single auth path.
    let authedRequest = request;
    const urlKey = url.searchParams.get("key");
    if (urlKey && !request.headers.get("authorization")) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${urlKey}`);
      authedRequest = new Request(request.url, {
        method: request.method,
        headers,
      });
    }

    const ctx = await requireApiKey(authedRequest, "conversations:read");
    const data = await buildExcelData(ctx.accountId);

    const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
    if (format === "json") {
      return ok(excelToJson(data));
    }

    return new Response(excelToCsv(data), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'inline; filename="flow-completions.csv"',
        // Never let a CDN cache one account's export for another.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
