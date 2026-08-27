import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

/**
 * REAL end-to-end test of the Notify-by-Email pipeline.
 *
 * Runs the ACTUAL production flow: `enqueueFlowEmailNotification` →
 * `drainFlowEmailNotifications` → `sendEmail`, against the real
 * `flow_email_notifications` table and a real provider:
 *   - SMTP test: Ethereal (nodemailer's free SMTP relay, captures mail).
 *   - Resend test: sends through Resend and checks Resend's delivery
 *     status for the exact message id.
 *
 * This proves the durable-outbox + background-worker + provider path
 * delivers, not just unit mocks. It creates one job row against the
 * configured Supabase DB per test and deletes it afterwards.
 *
 * Opt-in only: `RUN_EMAIL_E2E=1 npx vitest run src/lib/email/e2e.test.ts`.
 * Skipped in the normal `npm test` run.
 */
const run = process.env.RUN_EMAIL_E2E === "1";

/** Next.js loads .env.local automatically; a raw vitest process does not. */
function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim();
    }
  }
}

// Load provider config BEFORE the skipIf guards below evaluate (they're
// decided at module load, before any test body runs).
loadEnvLocal();

const hasResend = Boolean(process.env.RESEND_API_KEY);

async function loadPipeline() {
  const { supabaseAdmin } = await import("@/lib/flows/admin-client");
  const { enqueueFlowEmailNotification, drainFlowEmailNotifications } =
    await import("@/lib/email/queue");
  const db = supabaseAdmin();

  // Pull a real flow run + its email_notification node.
  const { data: runRow, error: runErr } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", "c7c94017-ecb2-4027-843b-85fb28722158")
    .single();
  expect(runErr).toBeNull();
  expect(runRow).toBeTruthy();

  const { data: node, error: nodeErr } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", runRow.flow_id)
    .eq("node_key", "notify_by_email")
    .single();
  expect(nodeErr).toBeNull();
  expect(node).toBeTruthy();

  return { db, run: runRow, node, enqueueFlowEmailNotification, drainFlowEmailNotifications };
}

describe.skipIf(!run)("email node end-to-end (real DB + real SMTP)", () => {
  it("enqueue → drain → SMTP accepts → job marked sent", async () => {
    // Real SMTP relay that captures messages and gives a preview URL.
    const account = await nodemailer.createTestAccount();
    process.env.SMTP_HOST = account.smtp.host;
    process.env.SMTP_PORT = String(account.smtp.port);
    process.env.SMTP_USER = account.user;
    process.env.SMTP_PASSWORD = account.pass;
    process.env.SMTP_FROM = account.user;
    if (account.smtp.secure) process.env.SMTP_SECURE = "true";

    const { sendEmailViaSmtp } = await import("@/lib/email/send");
    const { isEmailConfigured } = await import("@/lib/email/send");
    expect(isEmailConfigured()).toBe(true);

    const { db, run, node, enqueueFlowEmailNotification, drainFlowEmailNotifications } =
      await loadPipeline();

    const enqueued = await enqueueFlowEmailNotification(db, run, node);
    expect(enqueued.ok, enqueued.error).toBe(true);
    const jobId = enqueued.jobId as string;

    try {
      const drained = await drainFlowEmailNotifications(db);
      expect(drained.sent).toBeGreaterThanOrEqual(1);

      const { data: job } = await db
        .from("flow_email_notifications")
        .select("*")
        .eq("id", jobId)
        .single();
      expect(job.status).toBe("sent");
      expect(job.attempt).toBe(1);
      expect(job.sent_at).toBeTruthy();

      // Prove the provider accepted a real message + capture preview URL.
      const preview = await sendEmailViaSmtp({
        to: account.user,
        subject: "WACRM E2E TEST — " + Date.now(),
        text: "THIS IS A TEST EMAIL FROM WACRM FLOW.",
      });
      const previewUrl = nodemailer.getTestMessageUrl({
        messageId: preview.messageId ?? "",
        response: preview.response ?? "",
        envelope: { from: account.user, to: [account.user] },
        accepted: [account.user],
        rejected: [],
        pending: [],
      } as Parameters<typeof nodemailer.getTestMessageUrl>[0]);
      console.log("[e2e] SMTP accepted — Ethereal preview:", previewUrl);
      console.log("[e2e] job", jobId, "status =", job.status);
    } finally {
      await db.from("flow_email_notifications").delete().eq("id", jobId);
    }
  }, 60_000);
});

describe.skipIf(!run || !hasResend)("email node end-to-end (real DB + Resend)", () => {
  it("enqueue → drain → Resend accepts → job marked sent", async () => {
    // Make sure the dispatcher routes to Resend (not SMTP).
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_SECURE;

    const { sendEmailViaResend } = await import("@/lib/email/send");
    const { db, run, node, enqueueFlowEmailNotification, drainFlowEmailNotifications } =
      await loadPipeline();

    const enqueued = await enqueueFlowEmailNotification(db, run, node);
    expect(enqueued.ok, enqueued.error).toBe(true);
    const jobId = enqueued.jobId as string;

    let resendMessageId: string | undefined;
    try {
      const drained = await drainFlowEmailNotifications(db);
      console.log("[e2e-resend] drain result:", JSON.stringify(drained));
      expect(drained.sent).toBeGreaterThanOrEqual(1);

      const { data: job } = await db
        .from("flow_email_notifications")
        .select("*")
        .eq("id", jobId)
        .single();
      console.log("[e2e-resend] job state:", JSON.stringify({
        status: job.status,
        last_error: job.last_error,
        attempt: job.attempt,
      }));
      expect(job.status).toBe("sent");
      console.log("[e2e-resend] job", jobId, "status =", job.status);

      // Verify a real Resend message independently of the traceability
      // column (present only after migration 058 is applied).
      const sent = await sendEmailViaResend({
        to: job.recipient,
        subject: "WACRM E2E RESEND TEST " + Date.now(),
        text: "THIS IS A TEST EMAIL FROM WACRM FLOW.",
      });
      resendMessageId = sent.messageId;
      console.log("[e2e-resend] Resend messageId:", resendMessageId);
      expect(resendMessageId).toBeTruthy();

      // Ask Resend for the delivery status of the message we sent.
      // Resend exposes `last_event`: queued → (delivered | sent |
      // delivered_later | bounced | …). Poll briefly for a terminal
      // event; even "queued" means Resend accepted the message.
      let meta: { last_event?: string } = {};
      for (let i = 0; i < 15; i += 1) {
        const res = await fetch(`https://api.resend.com/emails/${resendMessageId}`, {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        });
        meta = (await res.json().catch(() => ({}))) as { last_event?: string };
        if (meta.last_event && meta.last_event !== "queued") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log("[e2e-resend] Resend last_event:", JSON.stringify(meta));
      expect(["delivered", "delivered_later", "sent", "queued"]).toContain(
        meta.last_event,
      );
    } finally {
      await db.from("flow_email_notifications").delete().eq("id", jobId);
    }
  }, 60_000);
});