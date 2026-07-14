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
import { Loader2, Download } from "lucide-react";

const DATE_FILTERS = [
  { value: "yesterday", label: "Yesterday" },
  { value: "2days", label: "Last 2 Days" },
  { value: "3days", label: "Last 3 Days" },
  { value: "4days", label: "Last 4 Days" },
  { value: "week", label: "Last Week" },
  { value: "month", label: "Last Month" },
  { value: "all", label: "All Time" },
];

export default function DroppedOffUsersPage() {
  const [showDialog, setShowDialog] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState("week");
  const [generatingLoading, setGeneratingLoading] = useState(false);
  const [droppedOffCount, setDroppedOffCount] = useState<number | null>(null);
  const [querying, setQuerying] = useState(false);

  useEffect(() => {
    queryDroppedOffCount();
  }, [selectedFilter]);

  async function queryDroppedOffCount() {
    setQuerying(true);
    try {
      const res = await fetch(`/api/dropped-off-users/query?dateFilter=${selectedFilter}`);
      if (!res.ok) throw new Error("Failed to query");
      const data = await res.json();
      setDroppedOffCount(data.count);
    } catch (err) {
      console.error(err);
      setDroppedOffCount(0);
    } finally {
      setQuerying(false);
    }
  }

  async function handleGenerate() {
    setGeneratingLoading(true);
    try {
      const res = await fetch("/api/dropped-off-users/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFilter: selectedFilter }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      alert(`Generated sheet with ${data.rowCount} users. Sheet URL: ${data.sheetUrl}`);
      setShowDialog(false);
      window.open(data.sheetUrl, "_blank");
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Generation failed"}`);
    } finally {
      setGeneratingLoading(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Dropped Off Users</h1>
        <p className="text-sm text-muted-foreground">
          Generate sheets for users who stopped messaging before reaching a Google Sheets Sync node
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground mb-4">
          Generate a new sheet with all user data from contacts who didn't complete flows containing Google Sheets Sync nodes.
          This is a one-time manual operation — the sheet won't update automatically.
        </p>
        <Button onClick={() => setShowDialog(true)}>
          <Download className="mr-2 h-4 w-4" />
          Generate Sheet
        </Button>
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Dropped Off Users Sheet</DialogTitle>
            <DialogDescription>
              Select a date range. Users who haven't reached a Google Sheets Sync node will be included.
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
            {querying ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Counting users...
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {droppedOffCount} users to include
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button onClick={handleGenerate} disabled={generatingLoading || querying || (droppedOffCount ?? 0) === 0}>
                {generatingLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
