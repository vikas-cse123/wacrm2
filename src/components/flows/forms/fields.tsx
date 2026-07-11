"use client";

/**
 * Reusable field components shared across every per-node form.
 *
 * `NodeKeySelect` — picks a node from the flow's node list, rendered
 * with the source node's icon so the dropdown reads as
 * "destination = ◇ menu" rather than an opaque slug.
 *
 * `NextNodeRow` — wraps NodeKeySelect with a label; the most common
 * per-node form row ("after this node, advance to…").
 *
 * `TextRow` — wraps Input or Textarea behind a label. Pure UI sugar
 * to keep per-node forms uncluttered.
 *
 * `WebhookRow` — per-node webhook config (enable toggle, URL, secret).
 * Lives here rather than in node-config-form.tsx because it's not
 * tied to any one node_type — every node gets the same webhook UI.
 *
 * Lives in src/components/flows/forms/ so both the list view's
 * collapsed-card editor and the canvas view's side-panel editor
 * (introduced in this PR) mount the exact same form components.
 */

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { NODE_META, type BuilderNode } from "../shared";

const STATIC_WEBHOOK_SECRET = "!@456webhook56343";

export function TextRow({
  label,
  value,
  onChange,
  rows = 1,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {rows > 1 ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="bg-muted"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-muted"
        />
      )}
    </div>
  );
}

export interface NodeWebhookConfig {
  enabled?: boolean;
  url?: string;
  secret?: string;
  fields?: string[];
}

export function WebhookRow({
  webhook,
  onChange,
}: {
  webhook: NodeWebhookConfig | undefined;
  onChange: (webhook: NodeWebhookConfig) => void;
}) {
  const w = webhook ?? {};

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          Send webhook when this node runs
        </label>
        <Switch
          checked={w.enabled ?? false}
          onCheckedChange={(checked) =>
            onChange({
              ...w,
              enabled: checked,
              secret: w.secret || (checked ? STATIC_WEBHOOK_SECRET : w.secret),
            })
          }
        />
      </div>

      {w.enabled && (
        <>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Webhook URL
            </label>
            <Input
              value={w.url ?? ""}
              onChange={(e) => onChange({ ...w, url: e.target.value })}
              placeholder="https://example.com/hook"
              className="bg-muted"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Secret (for signature verification)
            </label>
            <Input
              value={w.secret ?? ""}
              readOnly
              className="bg-muted font-mono text-xs"
            />
          </div>
        </>
      )}
    </div>
  );
}

export function NextNodeRow({
  value,
  allNodes,
  currentKey,
  onChange,
  label,
}: {
  value: string;
  allNodes: BuilderNode[];
  currentKey: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <NodeKeySelect
        value={value || null}
        nodes={allNodes}
        excludeKey={currentKey}
        onChange={(v) => onChange(v ?? "")}
        placeholder="Pick a next node…"
      />
    </div>
  );
}

export function NodeKeySelect({
  value,
  nodes,
  excludeKey,
  onChange,
  placeholder,
  className,
}: {
  value: string | null;
  nodes: BuilderNode[];
  excludeKey?: string;
  onChange: (v: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const options = nodes.filter((n) => n.node_key !== excludeKey);
  return (
    <Select
      value={value ?? "__none__"}
      onValueChange={(v) => onChange(v === "__none__" ? null : v)}
    >
      <SelectTrigger className={cn("bg-muted", className)}>
        <SelectValue placeholder={placeholder ?? "—"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">— None —</SelectItem>
        {options.map((n) => {
          const Icon = NODE_META[n.node_type].icon;
          return (
            <SelectItem key={n.node_key} value={n.node_key}>
              <span className="inline-flex items-center gap-1.5">
                <Icon
                  className={cn("h-3 w-3", NODE_META[n.node_type].color)}
                />
                {n.node_key}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}