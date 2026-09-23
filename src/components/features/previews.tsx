"use client";

import {
  ArrowDown,
  Check,
  GitBranch,
  Search,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PreviewKind } from "./features-data";

/* Miniature product previews for feature cards. Decorative only —
   always rendered inside aria-hidden containers. Fictional sample data. */

function Surface({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-muted/60 p-3",
        className
      )}
    >
      {children}
    </div>
  );
}

function Bar({ className }: { className?: string }) {
  return <div className={cn("rounded-full bg-border", className)} />;
}

function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[9px] font-semibold text-primary",
        className
      )}
    >
      {initials}
    </span>
  );
}

function InboxPreview() {
  const rows = [
    { initials: "AM", name: "Aarav Mehta", msg: "Bali package for 4 finalized", unread: 3, active: true },
    { initials: "SK", name: "Sara Khan", msg: "Sharing the itinerary PDF", unread: 0, active: false },
    { initials: "RJ", name: "Rohan Jain", msg: "Thanks, payment done", unread: 1, active: false },
  ];
  return (
    <Surface className="space-y-1 p-2">
      {rows.map((r) => (
        <div
          key={r.initials}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5",
            r.active && "bg-card ring-1 ring-inset ring-border"
          )}
        >
          <Avatar initials={r.initials} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-medium text-foreground">
                {r.name}
              </span>
              {r.unread > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                  {r.unread}
                </span>
              )}
            </div>
            <p className="truncate text-[10px] text-muted-foreground">{r.msg}</p>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 rounded-md bg-card px-2 py-1.5 ring-1 ring-inset ring-border">
        <span className="flex-1 text-[10px] text-muted-foreground">
          Reply to Aarav…
        </span>
        <Send className="h-3 w-3 text-primary" />
      </div>
    </Surface>
  );
}

function ContactsPreview() {
  return (
    <Surface className="space-y-2">
      <div className="flex items-center gap-2">
        <Avatar initials="AM" />
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-foreground">Aarav Mehta</p>
          <p className="text-[10px] text-muted-foreground">+91 98200 12345</p>
        </div>
      </div>
      <div className="flex gap-1">
        {["VIP", "Bali 2026"].map((t) => (
          <span
            key={t}
            className="rounded-full bg-primary-soft px-2 py-0.5 text-[9px] font-medium text-primary"
          >
            {t}
          </span>
        ))}
      </div>
      <div className="space-y-1 border-t border-border pt-2">
        {[
          ["Company", "Wander Trails"],
          ["Travel date", "14 Dec 2026"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium text-foreground">{v}</span>
          </div>
        ))}
      </div>
    </Surface>
  );
}

function QuickRepliesPreview() {
  return (
    <Surface className="space-y-1.5">
      <div className="flex items-center gap-1.5 rounded-md bg-card px-2 py-1.5 ring-1 ring-inset ring-border">
        <Search className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">Search replies…</span>
      </div>
      {["Share payment link", "Send itinerary PDF"].map((r) => (
        <div
          key={r}
          className="flex items-center justify-between rounded-md px-2 py-1.5 text-[10px] text-foreground hover:bg-card"
        >
          <span className="truncate">{r}</span>
          <Send className="h-3 w-3 shrink-0 text-muted-foreground" />
        </div>
      ))}
    </Surface>
  );
}

function CampaignPreview() {
  return (
    <Surface className="space-y-2">
      <div className="rounded-md bg-card p-2 ring-1 ring-inset ring-border">
        <p className="text-[10px] font-medium text-foreground">
          diwali_offer_2026
        </p>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          Hi {"{{name}}"}, festive packages are live…
        </p>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        {[
          ["1,240", "Sent"],
          ["986", "Read"],
          ["212", "Replied"],
        ].map(([v, l]) => (
          <div key={l} className="rounded-md bg-card px-1 py-1.5 ring-1 ring-inset ring-border">
            <p className="text-[11px] font-semibold text-foreground">{v}</p>
            <p className="text-[9px] text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>
    </Surface>
  );
}

function WorkflowPreview() {
  const nodes = ["Trigger", "Condition", "Wait 2h", "Add tag", "Assign"];
  return (
    <Surface>
      <div className="flex flex-col items-center">
        {nodes.map((n, i) => (
          <div key={n} className="flex w-full flex-col items-center">
            <div className="flex w-full items-center gap-2 rounded-md bg-card px-2 py-1.5 ring-1 ring-inset ring-border">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  i === 0 ? "bg-primary" : "bg-border"
                )}
              />
              <span className="text-[10px] font-medium text-foreground">{n}</span>
              {i === 0 && (
                <span className="ml-auto text-[9px] text-primary">Live</span>
              )}
            </div>
            {i < nodes.length - 1 && (
              <ArrowDown className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
    </Surface>
  );
}

function FlowCanvasPreview() {
  return (
    <Surface>
      <div className="flex flex-col items-center gap-1">
        {["Message", "Buttons", "Condition"].map((n) => (
          <div key={n} className="w-full">
            <div className="flex items-center gap-2 rounded-md bg-card px-2 py-1.5 ring-1 ring-inset ring-border">
              <GitBranch className="h-3 w-3 text-primary" />
              <span className="text-[10px] font-medium text-foreground">{n}</span>
            </div>
            <div className="flex justify-center">
              <ArrowDown className="h-3 w-3 text-muted-foreground" />
            </div>
          </div>
        ))}
        <div className="grid w-full grid-cols-2 gap-1.5">
          {["Path A", "Path B"].map((p) => (
            <div
              key={p}
              className="rounded-md bg-primary-soft px-2 py-1.5 text-center text-[10px] font-medium text-primary"
            >
              {p}
            </div>
          ))}
        </div>
      </div>
    </Surface>
  );
}

function AiPreview() {
  return (
    <Surface className="space-y-2">
      <div className="max-w-[90%] rounded-md rounded-tl-none bg-card px-2 py-1.5 ring-1 ring-inset ring-border">
        <p className="text-[10px] text-foreground">
          I want a Bali package for 4 people.
        </p>
      </div>
      <div className="ml-auto max-w-[90%] rounded-md rounded-tr-none bg-primary-soft px-2 py-1.5">
        <p className="text-[10px] text-foreground">
          I can help with that — here are 3 options…
        </p>
      </div>
      <div className="flex gap-1.5 border-t border-border pt-2">
        {["Knowledge Base", "AI Draft"].map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-[9px] font-medium text-foreground ring-1 ring-inset ring-border"
          >
            <Check className="h-2.5 w-2.5 text-primary" />
            {t}
          </span>
        ))}
      </div>
    </Surface>
  );
}

function DashboardPreview() {
  const bars = [34, 52, 44, 68, 58, 82, 70];
  return (
    <Surface className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        {[
          ["4m 12s", "Avg reply"],
          ["1,284", "Messages"],
          ["₹8.2L", "Pipeline"],
        ].map(([v, l]) => (
          <div key={l}>
            <p className="text-[12px] font-semibold text-foreground">{v}</p>
            <p className="text-[9px] text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>
      <div className="flex h-14 items-end gap-1 border-t border-border pt-2">
        {bars.map((h, i) => (
          <div
            key={i}
            style={{ height: `${h}%` }}
            className={cn(
              "flex-1 rounded-sm",
              i === 5 ? "bg-primary" : "bg-border"
            )}
          />
        ))}
      </div>
    </Surface>
  );
}

function RosterPreview() {
  const rows = [
    { name: "Meera (Owner)", presence: "bg-emerald-500", role: "Owner" },
    { name: "Arjun (Admin)", presence: "bg-amber-500", role: "Admin" },
    { name: "Divya (Agent)", presence: "bg-muted-foreground/40", role: "Agent" },
  ];
  return (
    <Surface className="space-y-1">
      {rows.map((r) => (
        <div
          key={r.name}
          className="flex items-center gap-2 rounded-md px-2 py-1.5"
        >
          <span className={cn("h-2 w-2 rounded-full", r.presence)} />
          <span className="flex-1 truncate text-[10px] font-medium text-foreground">
            {r.name}
          </span>
          <span className="rounded-full bg-card px-1.5 py-0.5 text-[9px] text-muted-foreground ring-1 ring-inset ring-border">
            {r.role}
          </span>
        </div>
      ))}
    </Surface>
  );
}

function RoutingPreview() {
  return (
    <Surface className="space-y-2">
      <div className="flex items-center gap-1 text-center">
        {["Incoming chat", "Assignment rule", "Agent"].map((s, i, arr) => (
          <div key={s} className="flex flex-1 items-center gap-1">
            <div className="flex-1 rounded-md bg-card px-1 py-1.5 text-[9px] font-medium text-foreground ring-1 ring-inset ring-border">
              {s}
            </div>
            {i < arr.length - 1 && (
              <span className="text-[10px] text-muted-foreground">→</span>
            )}
          </div>
        ))}
      </div>
      <p className="text-center text-[9px] font-medium text-primary">
        Balanced routing · 3 agents online
      </p>
    </Surface>
  );
}

function SheetsPreview() {
  const rows = [
    ["Aarav Mehta", "9820012345", "Bali"],
    ["Sara Khan", "9811098765", "Goa"],
    ["Rohan Jain", "9898011223", "Dubai"],
  ];
  return (
    <Surface className="overflow-hidden p-0">
      <div className="grid grid-cols-3 gap-px bg-border text-[9px] font-semibold">
        {["Name", "Phone", "Destination"].map((h) => (
          <div key={h} className="bg-emerald-500/10 px-2 py-1.5 text-foreground">
            {h}
          </div>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r[1]} className="grid grid-cols-3 gap-px bg-border text-[10px]">
          {r.map((c, i) => (
            <div key={i} className="truncate bg-muted/60 px-2 py-1.5 text-foreground">
              {c}
            </div>
          ))}
        </div>
      ))}
    </Surface>
  );
}

function ExportPreview() {
  return (
    <Surface className="space-y-1">
      {[
        ["Contacts", "2,140 rows"],
        ["Messages", "18,932 rows"],
        ["Deals", "312 rows"],
      ].map(([k, v]) => (
        <div
          key={k}
          className="flex items-center justify-between rounded-md bg-card px-2 py-1.5 text-[10px] ring-1 ring-inset ring-border"
        >
          <span className="font-medium text-foreground">{k}</span>
          <span className="text-muted-foreground">{v}</span>
        </div>
      ))}
    </Surface>
  );
}

function TemplatesPreview() {
  const rows = [
    ["diwali_offer_2026", "Approved", "text-emerald-500 bg-emerald-500/10"],
    ["payment_reminder", "Approved", "text-emerald-500 bg-emerald-500/10"],
    ["festive_video_qr", "Pending", "text-amber-500 bg-amber-500/10"],
  ];
  return (
    <Surface className="space-y-1">
      {rows.map(([n, s, tone]) => (
        <div
          key={n}
          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
        >
          <span className="truncate font-mono text-[10px] text-foreground">{n}</span>
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium", tone)}>
            {s}
          </span>
        </div>
      ))}
    </Surface>
  );
}

export function FeaturePreview({ kind }: { kind: PreviewKind }) {
  switch (kind) {
    case "inbox":
      return <InboxPreview />;
    case "contacts":
      return <ContactsPreview />;
    case "quick-replies":
      return <QuickRepliesPreview />;
    case "campaign":
      return <CampaignPreview />;
    case "workflow":
      return <WorkflowPreview />;
    case "flow-canvas":
      return <FlowCanvasPreview />;
    case "ai":
      return <AiPreview />;
    case "dashboard":
      return <DashboardPreview />;
    case "roster":
      return <RosterPreview />;
    case "routing":
      return <RoutingPreview />;
    case "sheets":
      return <SheetsPreview />;
    case "export":
      return <ExportPreview />;
    case "templates":
      return <TemplatesPreview />;
  }
}

export function CapabilityDots({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)} aria-hidden="true">
      <Bar className="h-1.5 w-8 bg-primary" />
      <Bar className="h-1.5 w-4" />
      <Bar className="h-1.5 w-4" />
    </div>
  );
}
