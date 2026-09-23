"use client";

import { Check } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useFlowEditor } from "../flow-editor-state";

/**
 * Workspace "Completion point" control, mounted under every node's
 * settings form. Scalar flow-level state (flows.completion_node_id)
 * means selecting a node automatically clears the previous point —
 * at most one custom point per flow, enforced by shape. NULL = the
 * END node decides (backwards compatible). Classification only:
 * this never terminates or redirects the run.
 */
export function CompletionPointRow({ nodeKey }: { nodeKey: string }) {
  const { state, setState } = useFlowEditor();
  const selected = state.completion_node_id === nodeKey;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-xs font-medium text-foreground">
            Completion point
          </Label>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Runs that reach this node show as Completed in Flow Tables.
            The flow keeps running normally afterwards.
          </p>
        </div>
        <Switch
          checked={selected}
          onCheckedChange={(v) =>
            setState((s) => ({
              ...s,
              completion_node_id: v ? nodeKey : null,
            }))
          }
          aria-label="Mark this node as the completion point"
        />
      </div>
      {selected && (
        <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-500">
          <Check className="h-3 w-3" />
          Completion point
        </p>
      )}
    </div>
  );
}
