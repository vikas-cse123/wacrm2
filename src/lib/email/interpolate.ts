/**
 * Template interpolation for flow email notifications.
 *
 * Supports the same {{vars.*}} syntax the flow engine already
 * interpolates for WhatsApp messages, plus contact and flow fields so
 * authors can write notifications like:
 *
 *   Subject: New lead: {{contact.name}}
 *   Body:
 *     Name: {{contact.name}}
 *     Phone: {{contact.phone}}
 *     Flow: {{flow.name}}
 *
 * Namespaces:
 *   {{vars.<key>}}        — snapshot of flow_runs.vars at enqueue time
 *   {{contact.<field>}}   — name | email | phone | company on contacts
 *   {{flow.name}}         — the flow's name
 *
 * Missing values render as the empty string (matches the existing
 * flow-engine and automations interpolators), never as an exception.
 */

export interface EmailInterpolationContext {
  /** Snapshot of flow_runs.vars captured when the node fired. */
  vars?: Record<string, unknown>;
  /** Contact fields resolved at send time. */
  contact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    company?: string | null;
  } | null;
  /** The flow's name. */
  flowName?: string | null;
}

const CONTACT_FIELDS = ["name", "email", "phone", "company"] as const;

function valueFor(key: string, ctx: EmailInterpolationContext): string {
  const dot = key.indexOf(".");
  const ns = dot === -1 ? key : key.slice(0, dot);
  const prop = dot === -1 ? "" : key.slice(dot + 1);

  if (ns === "vars" && prop) {
    const v = ctx.vars?.[prop];
    return v === undefined || v === null ? "" : String(v);
  }
  if (ns === "contact" && (CONTACT_FIELDS as readonly string[]).includes(prop)) {
    const v = ctx.contact?.[prop as (typeof CONTACT_FIELDS)[number]];
    return v == null ? "" : String(v);
  }
  if (key === "flow.name") {
    return ctx.flowName ?? "";
  }
  return "";
}

/**
 * Replace every {{...}} token in `template`. Unknown namespaces and
 * missing values render as "". Pure — exported for unit tests.
 */
export function interpolateEmail(
  template: string,
  ctx: EmailInterpolationContext,
): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) =>
    valueFor(key.trim(), ctx),
  );
}