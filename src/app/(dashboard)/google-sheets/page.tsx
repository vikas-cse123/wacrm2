"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowUpRight, Loader2, Trash2, X } from "lucide-react";

interface LinkedSheet {
  flow_id: string;
  flow_name: string;
  spreadsheet_name: string;
  spreadsheet_url: string;
  sheet_tab: string;
}

const DATE_FILTERS = [
  { value: "yesterday", label: "Yesterday" },
  { value: "2days", label: "Last 2 Days" },
  { value: "3days", label: "Last 3 Days" },
  { value: "4days", label: "Last 4 Days" },
  { value: "week", label: "Last Week" },
  { value: "month", label: "Last Month" },
  { value: "all", label: "All Time" },
];

export default function GoogleSheetsPage() {
  const [sheets, setSheets] = useState<LinkedSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [importingFlowId, setImportingFlowId] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState("week");
  const [importLoading, setImportLoading] = useState(false);

  useEffect(() => {
    fetchSheets();
  }, []);

  async function fetchSheets() {
    try {
      const res = await fetch("/api/google-sheets/list");
      if (!res.ok) throw new Error("Failed to fetch sheets");
      const data = await res.json();
      setSheets(data.sheets);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleImport() {
    if (!importingFlowId) return;
    setImportLoading(true);
    try {
      const res = await fetch(`/api/google-sheets/${importingFlowId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFilter: selectedFilter }),
      });
      if (!res.ok) throw new Error("Import failed");
      const data = await res.json();
      alert(`Imported ${data.imported} rows`);
      setImportingFlowId(null);
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Import failed"}`);
    } finally {
      setImportLoading(false);
    }
  }

  async function handleUnlink(flowId: string) {
    if (!confirm("Unlink this sheet? It will stop receiving new data.")) return;
    try {
      const res = await fetch(`/api/google-sheets/${flowId}/unlink`, { method: "POST" });
      if (!res.ok) throw new Error("Unlink failed");
      setSheets(sheets.filter((s) => s.flow_id !== flowId));
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unlink failed"}`);
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Google Sheets</h1>
        <p className="text-sm text-muted-foreground">
          Manage all linked Google Sheets across your flows
        </p>
      </div>

      {sheets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/50 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No linked sheets yet. Go to a flow and link a sheet to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sheets.map((sheet) => (
            <div key={sheet.flow_id} className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
              <div className="flex-1">
                <h3 className="font-medium text-foreground">{sheet.flow_name}</h3>
                <p className="text-sm text-muted-foreground">{sheet.spreadsheet_name}</p>
                <a
                  href={sheet.spreadsheet_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  View Sheet <ArrowUpRight className="h-3 w-3" />
                </a>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setImportingFlowId(sheet.flow_id)}
                >
                  Import
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleUnlink(sheet.flow_id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!importingFlowId} onOpenChange={(open) => !open && setImportingFlowId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Past Responses</DialogTitle>
            <DialogDescription>
              Select a date range to import completed responses to this sheet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Time Range</label>
              <Select value={selectedFilter} onValueChange={(v) => v && setSelectedFilter(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_FILTERS.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setImportingFlowId(null)}>
                Cancel
              </Button>
              <Button onClick={handleImport} disabled={importLoading}>
                {importLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
