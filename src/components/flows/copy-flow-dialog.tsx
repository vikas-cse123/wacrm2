"use client";

import { useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface CopyAccountOption {
  id: string;
  name: string;
}

export interface CopyFlowTarget {
  id: string;
  name: string;
}

export type CopyDestination =
  | { kind: "same"; accountId: string }
  | { kind: "other"; accountId: string };

/**
 * Decide which copy path a selection takes. Same account → the
 * existing duplicate endpoint (behavior unchanged); any other
 * existing duplicate endpoint (behavior unchanged); any other
 * account → the /api/internal/flows/copy endpoint. Pure so the routing rule
 * is unit-testable without rendering.
 */
export function resolveCopyDestination(
  selectedAccountId: string,
  currentAccountId: string | null,
): CopyDestination {
  if (currentAccountId && selectedAccountId === currentAccountId) {
    return { kind: "same", accountId: selectedAccountId };
  }
  return { kind: "other", accountId: selectedAccountId };
}

export interface CopyWarningItem {
  node_key: string;
  field: string;
  reason: string;
}

export interface CopyFlowSuccess {
  flowName: string;
  nodeCount: number;
  warnings: CopyWarningItem[];
}

/**
 * User-facing success text. Names the copied flow and its size;
 * warnings are summarized generically ( Counts + first item ) —
 * never with internal terminology.
 */
export function formatCopySuccess(result: CopyFlowSuccess): {
  title: string;
  description?: string;
} {
  const title = `"${result.flowName}" copied (${result.nodeCount} ${
    result.nodeCount === 1 ? "node" : "nodes"
  }).`;
  if (result.warnings.length === 0) return { title };
  const first = formatCopyWarning(result.warnings[0]!);
  const rest =
    result.warnings.length > 1
      ? ` (+${result.warnings.length - 1} more)`
      : "";
  return {
    title,
    description: `${result.warnings.length} item${
      result.warnings.length === 1 ? "" : "s"
    } need attention in the copied flow: ${first}${rest}`,
  };
}

/**
 * Map a machine warning to plain UI language. Field-scoped so new
 * warning kinds degrade to a safe generic line instead of leaking
 * raw reason strings.
 */
export function formatCopyWarning(warning: CopyWarningItem): string {
  if (warning.field === "tag_id" || warning.field === "subject_key") {
    return "A tag reference needs attention — open the copied flow and pick a tag.";
  }
  if (warning.field === "assign_to") {
    return "An assignment needs attention — open the copied flow and pick who handles handoffs.";
  }
  if (warning.field === "webhook.secret") {
    return "A webhook needs attention — open the copied flow and re-enter its secret.";
  }
  if (warning.field === "media_url" || warning.field === "header_image_url") {
    return "A media file needs attention — open the copied flow and re-upload it.";
  }
  if (warning.field === "sheet_link") {
    return "A Google Sheet needs attention — open the copied flow and link it again.";
  }
  return "An item needs attention — open the copied flow and review it.";
}

/**
 * Map copy failures to UI copy. 401 follows normal session handling
 * (the server message passes through); 403 is a generic permission
 * line that reveals nothing about account authorization; 404 names
 * neither side; anything else uses the standard error path.
 */
export function formatCopyError(status: number, serverMessage: string): string {
  if (status === 403) {
    return "You don't have permission to copy this flow.";
  }
  if (status === 404) {
    return "The flow or account could not be found.";
  }
  return serverMessage || "Couldn't copy flow.";
}

export interface InternalCopyResponse {
  flowName: string;
  nodeCount: number;
  warnings: CopyWarningItem[];
}

/**
 * "Copy Flow" dialog shown from a Flow card's Copy action. Lists
 * exactly the accounts from the caller's own auth context (today:
 * just the current account) and defaults to it. Same-account
 * selections use the long-standing duplicate endpoint with
 * identical behavior; anything else goes to the
 * /api/internal/flows/copy endpoint with { sourceFlowId,
 * targetAccountId }.
 */
export function CopyFlowDialog({
  open,
  onOpenChange,
  flow,
  accounts,
  currentAccountId,
  onCopiedInCurrentAccount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flow: CopyFlowTarget | null;
  accounts: CopyAccountOption[];
  currentAccountId: string | null;
  /** Refresh trigger for same-account copies (the copy lands here). */
  onCopiedInCurrentAccount: () => void;
}) {
  const [accountId, setAccountId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Default to the current account every time the dialog opens for
  // a (possibly different) flow.
  useEffect(() => {
    if (open) {
      setAccountId(currentAccountId ?? "");
    }
  }, [open, flow?.id, currentAccountId]);

  async function handleCopy() {
    if (!flow || !accountId || busy) return;
    const destination = resolveCopyDestination(accountId, currentAccountId);
    setBusy(true);
    try {
      if (destination.kind === "same") {
        const res = await fetch(`/api/flows/${flow.id}/duplicate`, {
          method: "POST",
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new CopyRequestError(
            res.status,
            typeof json.error === "string" ? json.error : `Copy failed: ${res.status}`,
          );
        }
        toast.success("Flow copied successfully.");
        onOpenChange(false);
        onCopiedInCurrentAccount();
      } else {
        const res = await fetch("/api/internal/flows/copy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceFlowId: flow.id,
            targetAccountId: destination.accountId,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as Partial<
          InternalCopyResponse & { error?: unknown }
        >;
        if (!res.ok) {
          throw new CopyRequestError(
            res.status,
            typeof json.error === "string" ? json.error : `Copy failed: ${res.status}`,
          );
        }
        const success = formatCopySuccess({
          flowName:
            typeof json.flowName === "string" ? json.flowName : flow.name,
          nodeCount:
            typeof json.nodeCount === "number" ? json.nodeCount : 0,
          warnings: Array.isArray(json.warnings) ? json.warnings : [],
        });
        toast.success(success.title, success.description ? { description: success.description } : undefined);
        onOpenChange(false);
      }
    } catch (err) {
      if (err instanceof CopyRequestError) {
        if (err.status === 401) {
          // Normal session handling: surface the server message so
          // the standard signed-out flow takes over downstream.
          toast.error(err.message);
        } else {
          toast.error(formatCopyError(err.status, err.message));
        }
      } else {
        console.error(err);
        toast.error("Couldn't copy flow.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy Flow</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {flow ? (
              <>
                Copy <span className="font-medium">“{flow.name}”</span> to the
                selected account.
              </>
            ) : (
              "Copy this flow to the selected account."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Account
          </p>
          <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")}>
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={handleCopy} disabled={!flow || !accountId || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            <Copy className="h-4 w-4" />
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

class CopyRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CopyRequestError";
    this.status = status;
  }
}
