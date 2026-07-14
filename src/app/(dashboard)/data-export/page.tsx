"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2, ArrowUpRight, Download } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface LinkedSheet {
  flow_id: string;
  flow_name: string;
  spreadsheet_name: string;
  spreadsheet_url: string;
  sheet_tab: string;
}

export default function DataExportPage() {
  const [sheets, setSheets] = useState<LinkedSheet[]>([]);
  const [sheetsLoading, setSheetsLoading] = useState(true);
  const [droppedOffCount, setDroppedOffCount] = useState<number | null>(null);
  const [droppedOffLoading, setDroppedOffLoading] = useState(true);
  const [generatingDroppedOff, setGeneratingDroppedOff] = useState(false);

  useEffect(() => {
    fetchSheets();
    fetchDroppedOffCount();
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
      setSheetsLoading(false);
    }
  }

  async function fetchDroppedOffCount() {
    try {
      const res = await fetch("/api/dropped-off-users/query");
      if (!res.ok) throw new Error("Failed to fetch count");
      const data = await res.json();
      setDroppedOffCount(data.count);
    } catch (err) {
      console.error(err);
      setDroppedOffCount(0);
    } finally {
      setDroppedOffLoading(false);
    }
  }

  async function handleImport(flowId: string) {
    try {
      const res = await fetch(`/api/google-sheets/${flowId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Import failed");
      const data = await res.json();
      alert(`Imported ${data.imported} rows`);
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Import failed"}`);
    }
  }

  async function handleUnlink(flowId: string) {
    if (!confirm("Unlink this sheet? It will stop receiving new data.")) return;
    try {
      const res = await fetch(`/api/google-sheets/${flowId}/unlink`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Unlink failed");
      setSheets(sheets.filter((s) => s.flow_id !== flowId));
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unlink failed"}`);
    }
  }

  async function handleGenerateDroppedOff() {
    setGeneratingDroppedOff(true);
    try {
      const res = await fetch("/api/dropped-off-users/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      alert(`Generated sheet with ${data.rowCount} users`);
      if (data.sheetUrl) window.open(data.sheetUrl, "_blank");
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Generation failed"}`);
    } finally {
      setGeneratingDroppedOff(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Data Export</h1>
        <p className="text-sm text-muted-foreground">
          Manage Google Sheets and export user data
        </p>
      </div>

      <Tabs defaultValue="sheets" className="w-full">
        <TabsList>
          <TabsTrigger value="sheets">Google Sheets</TabsTrigger>
          <TabsTrigger value="dropped-off">Dropped Off Users</TabsTrigger>
        </TabsList>

        {/* Google Sheets Tab */}
        <TabsContent value="sheets" className="space-y-4">
          {sheetsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : sheets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/50 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No linked sheets yet. Go to a flow and link a sheet to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {sheets.map((sheet) => (
                <div
                  key={sheet.flow_id}
                  className="flex items-center justify-between rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex-1">
                    <h3 className="font-medium text-foreground">{sheet.flow_name}</h3>
                    <p className="text-sm text-muted-foreground">
                      {sheet.spreadsheet_name}
                    </p>
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
                      onClick={() => handleImport(sheet.flow_id)}
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
        </TabsContent>

        {/* Dropped Off Users Tab */}
        <TabsContent value="dropped-off" className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground mb-4">
              Generate a sheet with all users who stopped messaging before completing a flow.
              This includes all incomplete and abandoned runs across all flows.
            </p>
            {droppedOffLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Counting users...
              </div>
            ) : (
              <p className="text-sm text-muted-foreground mb-4">
                <strong>{droppedOffCount}</strong> users found
              </p>
            )}
            <Button
              onClick={handleGenerateDroppedOff}
              disabled={generatingDroppedOff || droppedOffLoading || (droppedOffCount ?? 0) === 0}
            >
              {generatingDroppedOff && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <Download className="mr-2 h-4 w-4" />
              Generate Sheet
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
