"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Inbox, Search, Table2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  FlowTableColumn,
  FlowTablePayload,
  FlowTableRow,
  FlowTableView,
} from "@/lib/flows/flow-tables";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";

interface FlowOption {
  id: string;
  name: string;
}

const VIEWS: Array<{ id: FlowTableView; label: string }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "incomplete", label: "Incomplete" },
];

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: FlowTableRow["status"] }) {
  const completed = status === "completed";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 text-xs font-normal",
        completed
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-amber-500/40 text-amber-600 dark:text-amber-400",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          completed ? "bg-emerald-500" : "bg-amber-500",
        )}
      />
      {completed ? "Completed" : "Incomplete"}
    </Badge>
  );
}

function cellText(
  row: FlowTableRow,
  column: FlowTableColumn,
): string {
  switch (column.key) {
    case "name":
      return row.name ?? "—";
    case "phone":
      return row.phone ?? "—";
    case "submission_time":
      return formatDateTime(row.startedAt);
    case "status":
      return row.status === "completed" ? "Completed" : "Incomplete";
    default:
      return row.answers[column.key] ?? "—";
  }
}

export default function WorkspacePage() {
  const [flows, setFlows] = useState<FlowOption[] | null>(null);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [view, setView] = useState<FlowTableView>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [payload, setPayload] = useState<FlowTablePayload | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FlowTableRow | null>(null);

  // Account-scoped flow list (same source as the rest of the app).
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/flows", { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Couldn't load flows (${res.status})`);
        const json = (await res.json()) as {
          flows?: Array<{ id: string; name: string }>;
        };
        const list = (json.flows ?? []).map((f) => ({
          id: f.id,
          name: f.name,
        }));
        if (ctrl.signal.aborted) return;
        setFlows(list);
        setFlowId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFlowsError(
          err instanceof Error ? err.message : "Couldn't load flows.",
        );
        setFlows([]);
      });
    return () => ctrl.abort();
  }, []);

  // Debounced search; resets to the first page.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 400);
    return () => window.clearTimeout(t);
  }, [search]);

  const selectFlow = useCallback((id: string | null) => {
    if (!id) return;
    setFlowId(id);
    setView("all");
    setPage(0);
    setSelected(null);
  }, []);

  const selectView = useCallback((v: FlowTableView) => {
    setView(v);
    setPage(0);
  }, []);

  // Table rows: server-filtered + paginated per (flow, view, search, page).
  // Loading is DERIVED (requested vs loaded key) so the fetch effect
  // never sets state synchronously — responses reconcile by key, and
  // a stale response for an older key is ignored.
  const requestKey = flowId
    ? `${flowId}|${view}|${debouncedSearch}|${page}`
    : null;
  const loading = requestKey !== null && requestKey !== loadedKey;
  useEffect(() => {
    if (!flowId || !requestKey) return;
    const ctrl = new AbortController();
    const qs = new URLSearchParams({
      view,
      page: String(page),
      pageSize: "25",
    });
    if (debouncedSearch) qs.set("search", debouncedSearch);
    fetch(`/api/flows/${flowId}/table?${qs.toString()}`, {
      signal: ctrl.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          | (FlowTablePayload & { error?: unknown })
          | null;
        if (!res.ok || !json || !("rows" in json)) {
          throw new Error(
            json && typeof json.error === "string"
              ? json.error
              : `Couldn't load table (${res.status})`,
          );
        }
        if (ctrl.signal.aborted) return;
        setPayload(json as FlowTablePayload);
        setTableError(null);
        setLoadedKey(requestKey);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (ctrl.signal.aborted) return;
        setTableError(
          err instanceof Error ? err.message : "Couldn't load table.",
        );
        setLoadedKey(requestKey);
      });
    return () => ctrl.abort();
  }, [flowId, requestKey, view, debouncedSearch, page]);

  const totalPages = useMemo(() => {
    const total = payload?.meta.total ?? 0;
    const size = payload?.meta.pageSize ?? 25;
    return Math.max(1, Math.ceil(total / size));
  }, [payload]);
  const showingFrom = useMemo(() => {
    const total = payload?.meta.total ?? 0;
    if (total === 0) return 0;
    return page * (payload?.meta.pageSize ?? 25) + 1;
  }, [payload, page]);
  const showingTo = useMemo(() => {
    const total = payload?.meta.total ?? 0;
    return Math.min(total, page * (payload?.meta.pageSize ?? 25) + (payload?.rows.length ?? 0));
  }, [payload, page]);

  const activeFlowName = flows?.find((f) => f.id === flowId)?.name ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Workspace
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One live table per flow — every run, completed or not.
        </p>
      </div>

      {flows === null ? (
        <Skeleton className="h-10 w-72" />
      ) : flowsError ? (
        <p className="text-sm text-destructive" role="alert">
          {flowsError}
        </p>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={Table2}
          title="No flows yet"
          hint="Create a flow first — each flow gets its own table here."
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Select value={flowId ?? ""} onValueChange={selectFlow}>
              <SelectTrigger
                className="w-full sm:w-72 border-border bg-card"
                aria-label="Select flow"
              >
                <SelectValue placeholder="Select Flow" />
              </SelectTrigger>
              <SelectContent>
                {flows.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1.5" role="tablist" aria-label="Completion filter">
              {VIEWS.map((v) => (
                <Button
                  key={v.id}
                  role="tab"
                  aria-selected={view === v.id}
                  variant={view === v.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => selectView(v.id)}
                  className={cn(
                    "h-8 rounded-full px-3.5 text-[13px] font-medium",
                    view !== v.id &&
                      "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {v.label}
                </Button>
              ))}
            </div>
          </div>

          {payload?.meta.completionNodeId ? (
            <p className="text-xs text-muted-foreground">
              Completion point:{" "}
              <code className="rounded bg-muted px-1 font-mono">
                {payload.meta.completionNodeId}
              </code>{" "}
              — runs that reach it show as Completed.{" "}
              <Link
                href={`/flows/${payload.meta.flowId}`}
                className="underline underline-offset-2"
              >
                Edit in flow builder
              </Link>
            </p>
          ) : (
            payload && (
              <p className="text-xs text-muted-foreground">
                No custom completion point — runs show as Completed when they
                reach END.{" "}
                <Link
                  href={`/flows/${payload.meta.flowId}`}
                  className="underline underline-offset-2"
                >
                  Set one in the flow builder
                </Link>
              </p>
            )
          )}

          <div className="relative max-w-sm">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone…"
              className="pl-9"
              aria-label="Search table"
            />
          </div>

          {tableError ? (
            <p className="text-sm text-destructive" role="alert">
              {tableError}
            </p>
          ) : loading && !payload ? (
            <Skeleton className="h-64 w-full" />
          ) : !payload || payload.rows.length === 0 ? (
            <EmptyState
              icon={Table2}
              title={
                view === "all"
                  ? "No runs yet"
                  : view === "completed"
                    ? "No completed runs"
                    : "No incomplete runs"
              }
              hint="New flow runs appear here automatically."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {payload.columns.map((c) => (
                        <TableHead key={c.key} className="whitespace-nowrap">
                          {c.label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payload.rows.map((row) => (
                      <TableRow
                        key={row.runId}
                        className="cursor-pointer"
                        onClick={() => setSelected(row)}
                      >
                        {payload.columns.map((c) =>
                          c.key === "status" ? (
                            <TableCell key={c.key}>
                              <StatusBadge status={row.status} />
                            </TableCell>
                          ) : (
                            <TableCell
                              key={c.key}
                              className="max-w-56 truncate"
                            >
                              {cellText(row, c)}
                            </TableCell>
                          ),
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <p className="tabular-nums">
                  Showing {showingFrom}–{showingTo} of{" "}
                  {payload.meta.total.toLocaleString()}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0 || loading}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page + 1 >= totalPages || loading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <Sheet
        open={selected !== null}
        onOpenChange={(v) => !v && setSelected(null)}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name ?? "Run"}</SheetTitle>
                <SheetDescription>
                  {activeFlowName ?? "Flow run"} · started{" "}
                  {formatDateTime(selected.startedAt)}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-4 overflow-y-auto px-5 pb-6">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selected.status} />
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Phone</dt>
                    <dd className="font-medium text-foreground">
                      {selected.phone ?? "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Submission time</dt>
                    <dd className="tabular-nums text-foreground">
                      {formatDateTime(selected.startedAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Completed at</dt>
                    <dd className="tabular-nums text-foreground">
                      {formatDateTime(selected.completedAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Flow run ID</dt>
                    <dd className="max-w-48 truncate font-mono text-xs text-foreground">
                      {selected.runId}
                    </dd>
                  </div>
                </dl>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Answers
                  </h3>
                  {payload && payload.columns.some((c) => !c.system) ? (
                    <dl className="mt-2 space-y-2 text-sm">
                      {payload.columns
                        .filter((c) => !c.system)
                        .map((c) => (
                          <div
                            key={c.key}
                            className="flex justify-between gap-4"
                          >
                            <dt className="shrink-0 text-muted-foreground">
                              {c.label}
                            </dt>
                            <dd className="break-words text-right text-foreground">
                              {selected.answers[c.key] ?? "—"}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">
                      No answers collected yet.
                    </p>
                  )}
                </div>
                {selected.conversationId ? (
                  <Button
                    className="w-full"
                    render={
                      <Link href={`/inbox?c=${selected.conversationId}`} />
                    }
                  >
                    <Inbox className="mr-2 h-4 w-4" />
                    Open Conversation
                  </Button>
                ) : (
                  <Button disabled className="w-full">
                    <Inbox className="mr-2 h-4 w-4" />
                    No conversation linked
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
