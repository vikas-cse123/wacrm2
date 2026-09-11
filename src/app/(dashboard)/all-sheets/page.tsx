"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowUpRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ImportDateRangePopover } from "@/components/flows/import-date-range-popover";
import { flowTabSheetHref } from "./tab-state";

interface FlowTab {
  id: string;
  flow_id: string;
  worksheet_id: number | null;
  worksheet_title: string;
  header_written: boolean;
}

interface Collection {
  id: string;
  kind: "completed" | "incomplete";
  spreadsheet_url: string | null;
  spreadsheet_name: string | null;
}

interface FlowEntry {
  flow_id: string;
  flow_name: string;
  completedCount: number;
  incompleteCount: number;
  completedCollection: Collection | null;
  incompleteCollection: Collection | null;
  completedTab: FlowTab | null;
  incompleteTab: FlowTab | null;
}

interface RunPreview {
  id: string;
  status: string;
  vars: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
  contact: { phone?: string | null; name?: string | null } | null;
  synced: boolean;
}

export default function AllSheetsPage() {
  const [flows, setFlows] = useState<FlowEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"completed" | "incomplete">("completed");
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [busyFlowId, setBusyFlowId] = useState<string | null>(null);
  const [rows, setRows] = useState<RunPreview[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);

  useEffect(() => {
    fetchFlows();
  }, []);

  async function fetchFlows() {
    setLoading(true);
    try {
      const res = await fetch("/api/all-sheets/flows", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch flows");
      const data = await res.json();
      setFlows(data.flows ?? []);
      setSelectedFlowId((prev) => {
        if (prev && (data.flows ?? []).some((f: FlowEntry) => f.flow_id === prev)) return prev;
        return (data.flows ?? [])[0]?.flow_id ?? null;
      });
    } catch (err) {
      console.error(err);
      toast.error("Failed to load flows");
    } finally {
      setLoading(false);
    }
  }

  const selectedFlow = useMemo(
    () => flows.find((f) => f.flow_id === selectedFlowId) ?? null,
    [flows, selectedFlowId],
  );
  const activeTab = kind === "completed" ? selectedFlow?.completedTab : selectedFlow?.incompleteTab;

  useEffect(() => {
    if (!activeTab) {
      setRows([]);
      return;
    }
    fetchRows(activeTab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, kind]);

  async function fetchRows(tabId: string) {
    setRowsLoading(true);
    try {
      const res = await fetch(`/api/all-sheets/tabs/${tabId}/rows?limit=25`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch rows");
      const data = await res.json();
      setRows(data.runs ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setRowsLoading(false);
    }
  }

  async function handleAdd(flowId: string) {
    setBusyFlowId(flowId);
    try {
      const res = await fetch("/api/all-sheets/tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow_id: flowId, kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Add failed");
      toast.success(
        data.created ? "Flow tab created (header initialized)." : "Flow tab already exists — reused.",
      );
      await fetchFlows();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Add failed");
    } finally {
      setBusyFlowId(null);
    }
  }

  async function handleDelete(tabId: string) {
    if (!confirm("Remove this flow's tab from All Sheets? Only this tab is removed — the shared spreadsheet stays.")) return;
    try {
      const res = await fetch(`/api/all-sheets/tabs/${tabId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Flow tab removed.");
      await fetchFlows();
      setRows([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleSync(tabId: string, window_: { from?: string; to?: string }) {
    const endpoint = kind === "completed" ? "import" : "refresh";
    try {
      const res = await fetch(`/api/all-sheets/tabs/${tabId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(window_),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sync failed");
      toast.success(
        data.imported > 0 ? `Synced ${data.imported} row${data.imported === 1 ? "" : "s"}.` : "Nothing new to sync.",
      );
      await fetchRows(tabId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
      throw err;
    }
  }

  const answerKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r.vars ?? {})) keys.add(k);
    return [...keys].slice(0, 8);
  }, [rows]);

  const collectionForKind = useMemo(() => {
    for (const f of flows) {
      const c = kind === "completed" ? f.completedCollection : f.incompleteCollection;
      if (c) return c;
    }
    return null;
  }, [flows, kind]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">All Sheets</h1>
        <p className="text-sm text-muted-foreground">
          One shared spreadsheet per section, one tab per flow. Operations here never touch Google Sheets links.
        </p>
      </div>

      <Tabs value={kind} onValueChange={(v) => setKind(v as "completed" | "incomplete")} className="w-full">
        <TabsList>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="incomplete">Incomplete</TabsTrigger>
        </TabsList>

        {(["completed", "incomplete"] as const).map((k) => (
          <TabsContent key={k} value={k} className="space-y-4">
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : flows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/50 p-8 text-center">
                <p className="text-sm text-muted-foreground">No flows found.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {kind === k && collectionForKind ? (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
                    <div>
                      <p className="text-xs uppercase tracking-wider text-muted-foreground">Shared spreadsheet</p>
                      <h3 className="font-medium text-foreground">{collectionForKind.spreadsheet_name}</h3>
                      {collectionForKind.spreadsheet_url ? (
                        <a
                          href={collectionForKind.spreadsheet_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          View Sheet <ArrowUpRight className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : kind === k ? (
                  <div className="rounded-lg border border-dashed border-border bg-muted/50 p-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      No shared {k} spreadsheet yet. Add a flow below to create it (one spreadsheet total, tabs per flow).
                    </p>
                  </div>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
                  <div className="space-y-2">
                    {flows.map((flow) => {
                      const isActive = flow.flow_id === selectedFlowId;
                      const count = k === "completed" ? flow.completedCount : flow.incompleteCount;
                      const tab = k === "completed" ? flow.completedTab : flow.incompleteTab;
                      return (
                        <button
                          key={flow.flow_id}
                          type="button"
                          onClick={() => setSelectedFlowId(flow.flow_id)}
                          className={`w-full rounded-lg border p-3 text-left transition-colors ${
                            isActive ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50"
                          }`}
                        >
                          <p className="truncate text-sm font-medium text-foreground">{flow.flow_name}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {count} {k} run{count === 1 ? "" : "s"}
                            {tab ? ` · tab: ${tab.worksheet_title}` : " · not added"}
                          </p>
                        </button>
                      );
                    })}
                  </div>

                  <div className="rounded-lg border border-border bg-card p-4">
                    {kind === k && selectedFlow ? (
                      <FlowDetail
                        flow={selectedFlow}
                        kind={k}
                        tab={k === "completed" ? selectedFlow.completedTab : selectedFlow.incompleteTab}
                        collection={k === "completed" ? selectedFlow.completedCollection : selectedFlow.incompleteCollection}
                        busy={busyFlowId === selectedFlow.flow_id}
                        rows={selectedFlow.flow_id === selectedFlowId ? rows : []}
                        rowsLoading={rowsLoading}
                        answerKeys={selectedFlow.flow_id === selectedFlowId ? answerKeys : []}
                        onAdd={() => handleAdd(selectedFlow.flow_id)}
                        onDelete={handleDelete}
                        onSync={handleSync}
                        onRefresh={() => activeTab && fetchRows(activeTab.id)}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function FlowDetail({
  flow,
  kind,
  tab,
  collection,
  busy,
  rows,
  rowsLoading,
  answerKeys,
  onAdd,
  onDelete,
  onSync,
  onRefresh,
}: {
  flow: FlowEntry;
  kind: "completed" | "incomplete";
  tab: FlowTab | null;
  collection: Collection | null;
  busy: boolean;
  rows: RunPreview[];
  rowsLoading: boolean;
  answerKeys: string[];
  onAdd: () => void;
  onDelete: (tabId: string) => void;
  onSync: (tabId: string, window_: { from?: string; to?: string }) => Promise<void>;
  onRefresh: () => void;
}) {
  // Flow-level link: rendered ONLY when this flow has a tab record.
  // Collection existence alone must never show it (STATE B).
  const sheetHref = flowTabSheetHref(collection?.spreadsheet_url, tab);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground">{flow.flow_name}</h3>
          <p className="text-xs text-muted-foreground">
            {kind === "completed" ? `${flow.completedCount} completed runs` : `${flow.incompleteCount} incomplete runs`}
            {tab ? ` · tab “${tab.worksheet_title}”` : " · no All Sheets tab yet"}
          </p>
          {sheetHref ? (
            <a
              href={sheetHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Open Sheet <ArrowUpRight className="h-3 w-3" />
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {!tab ? (
            <Button size="sm" onClick={onAdd} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              Add to All Sheets
            </Button>
          ) : (
            <>
              <ImportDateRangePopover
                triggerLabel={kind === "completed" ? "Import" : "Refresh"}
                onConfirm={(w) => onSync(tab.id, w)}
              />
              <Button variant="outline" size="sm" onClick={onRefresh}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => onDelete(tab.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {!tab ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Not in All Sheets {kind} yet. Adding creates a tab inside the one shared spreadsheet (header initialized, no auto-import).
          </p>
        </div>
      ) : rowsLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No {kind} runs to show yet. Use Import/Refresh to sync them into this tab.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">Status</th>
                {answerKeys.map((key) => (
                  <th key={key} className="max-w-[160px] truncate px-3 py-2 font-medium">{key}</th>
                ))}
                <th className="px-3 py-2 font-medium">Synced</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 text-foreground">{r.contact?.phone ?? r.contact?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.status}</td>
                  {answerKeys.map((key) => (
                    <td key={key} className="max-w-[160px] truncate px-3 py-2 text-muted-foreground">
                      {r.vars?.[key] == null ? "" : String(r.vars[key])}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-muted-foreground">{r.synced ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
