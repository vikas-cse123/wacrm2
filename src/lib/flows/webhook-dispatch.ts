import crypto from "crypto";
import { supabaseAdmin } from "./admin-client";
import type { FlowNodeRow, FlowRunRow } from "./types";

// Only this WhatsApp client uses the Cal.com booking hand-off. Keeping the
// special captured-name payload scoped here avoids changing other accounts'
// webhook contracts.
const CLID_BOOKING_PHONE_NUMBER_ID = "1237170136146543";

/**
 * Fires the per-node webhook configured in node.config.webhook, if
 * enabled. Fire-and-forget: never awaited by the caller, so a slow
 * or dead client endpoint can never delay flow execution or the
 * inbound webhook response to Meta.
 */
export function dispatchNodeWebhook(
  run: FlowRunRow,
  node: FlowNodeRow,
): void {
  const cfg = (node.config as Record<string, unknown>)?.webhook as
    | { enabled?: boolean; url?: string; secret?: string; fields?: string[] }
    | undefined;
  if (!cfg?.enabled || !cfg?.url) return;

  (async () => {
    const db = supabaseAdmin();
    const start = Date.now();

    const [{ data: contact }, { data: config }] = await Promise.all([
      db
        .from("contacts")
        .select("id, name, phone")
        .eq("id", run.contact_id!)
        .eq("account_id", run.account_id)
        .maybeSingle(),
      db
        .from("whatsapp_config")
        .select("phone_number_id")
        .eq("account_id", run.account_id)
        .single(),
    ]);

    const capturedVars = (run.vars ?? {}) as Record<string, unknown>;
    const data = pickFields(capturedVars, cfg.fields ?? []);

    // This client's Tag Contact webhook hands qualified leads to its Cal.com
    // booking server. Include the flow's captured name so it receives what
    // the customer typed instead of only their WhatsApp profile name.
    const capturedName = capturedVars.name;
    if (
      config?.phone_number_id === CLID_BOOKING_PHONE_NUMBER_ID &&
      node.node_type === "set_tag" &&
      typeof capturedName === "string" &&
      capturedName.trim()
    ) {
      data.name = capturedName.trim();
    }

    const payload = {
      account_id: run.account_id,
      flow_id: run.flow_id,
      node_id: node.node_key,
      node_type: node.node_type,
      customer: {
        phone_number: contact?.phone ?? null,
        name: contact?.name ?? null,
        id: contact?.id ?? run.contact_id,
      },
      business: {
        phone_number_id: config?.phone_number_id ?? null,
      },
      data,
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);
    const signature = crypto
      .createHmac("sha256", cfg.secret || "")
      .update(body)
      .digest("hex");

    let statusCode: number | null = null;
    let responseBody = "";
    let error: string | null = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(cfg.url!, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Wacrm-Signature": signature },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      statusCode = res.status;
      responseBody = (await res.text()).slice(0, 1000);
    } catch (err: any) {
      error = err?.name === "AbortError" ? "timeout after 5s" : String(err?.message ?? err);
    }

    await db.from("flow_node_webhook_logs").insert({
      account_id: run.account_id,
      flow_id: run.flow_id,
      node_id: node.node_key,
      contact_id: run.contact_id,
      phone_number: contact?.phone ?? null,
      url: cfg.url,
      payload,
      status_code: statusCode,
      response_body: responseBody,
      success: statusCode !== null && statusCode >= 200 && statusCode < 300,
      error,
      duration_ms: Date.now() - start,
    });
  })().catch((e) => console.error("[flow webhook dispatch] unexpected failure", e));
}

function pickFields(vars: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = vars[f];
  return out;
}
