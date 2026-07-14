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

interface FlowWithDroppedCount {
  flow_id: string;
  flow_name: string;
  droppedCount: number;
  generatedSheetUrl?: string;
}

export default function DataExportPage() {
  const [sheets, setSheets] = useState<LinkedSheet[]>([]);
  const [sheetsLoading, setSheetsLoading] = useState(true);
  const [flows, setFlows] = useState<FlowWithDroppedCount[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(true);
  const [generatingFlowId, setGeneratingFlowId] = useState<string | null>(null);

  useEffect(() => {
    fetchSheets();
    fetchFlows();
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

  async function fetchFlows() {
    try {
      const res = await fetch("/api/flows/dropped-off");
      if (!res.ok) throw new Error("Failed to fetch flows");
      const data = await res.json();
      setFlows(data.flows);
    } catch (err) {
      console.error(err);
      setFlows([]);
    } finally {
      setFlowsLoading(false);
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

  async function handleGenerateDroppedOff(flowId: string) {
    setGeneratingFlowId(flowId);
    try {
      const res = await fetch(`/api/flows/${flowId}/dropped-off`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Generation failed");
      }
      const data = await res.json();
      // Update flows to show the generated sheet URL
      setFlows(
        flows.map((f) =>
          f.flow_id === flowId
            ? { ...f, generatedSheetUrl: data.sheetUrl }
            : f
        )
      );
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Generation failed"}`);
    } finally {
      setGeneratingFlowId(null);
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
          <TabsTrigger value="sheets">Completed Flows</TabsTrigger>
          <TabsTrigger value="dropped-off">Incomplete Flows</TabsTrigger>
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

        {/* Incomplete Flows Tab */}
        <TabsContent value="dropped-off" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Generate sheets for flows that users didn't complete.
          </p>
          {flowsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : flows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/50 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No flows found, or no users have abandoned any flows yet.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {flows.map((flow) => (
                <div
                  key={flow.flow_id}
                  className="flex items-center justify-between rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex-1">
                    <h3 className="font-medium text-foreground">{flow.flow_name}</h3>
                    {flow.generatedSheetUrl && (
                      <a
                        href={flow.generatedSheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        View Sheet <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleGenerateDroppedOff(flow.flow_id)}
                    disabled={generatingFlowId === flow.flow_id || flow.droppedCount === 0 || !!flow.generatedSheetUrl}
                  >
                    {generatingFlowId === flow.flow_id && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    <Download className="mr-2 h-4 w-4" />
                    {flow.generatedSheetUrl ? "Generated" : "Generate"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
