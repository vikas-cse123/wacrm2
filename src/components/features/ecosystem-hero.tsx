"use client";

import { Bot, Sheet, Tags, UsersRound, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

/* Hero ecosystem composition: a central Inbox card orbited by five
   interface fragments (Contacts, Automation, AI Agent, Sheets, Team),
   tied together with connector lines over a restrained indigo glow.
   Decorative — the hero copy carries the meaning. */

const satellites = [
  {
    id: "contacts",
    label: "Contacts",
    icon: Tags,
    className: "top-0 left-0 sm:top-2 sm:left-2",
    body: (
      <div className="flex gap-1">
        {["VIP", "Bali"].map((t) => (
          <span
            key={t}
            className="rounded-full bg-primary-soft px-1.5 py-px text-[8px] font-medium text-primary"
          >
            {t}
          </span>
        ))}
      </div>
    ),
  },
  {
    id: "automation",
    label: "Automation",
    icon: Zap,
    className: "top-0 right-0 sm:top-6 sm:right-0",
    body: (
      <div className="space-y-1">
        <div className="h-1 w-16 rounded-full bg-primary/70" />
        <div className="h-1 w-11 rounded-full bg-border" />
      </div>
    ),
  },
  {
    id: "ai",
    label: "AI Agent",
    icon: Bot,
    className: "top-[38%] -left-1 sm:left-0",
    body: (
      <p className="max-w-28 truncate text-[8px] text-muted-foreground">
        Draft ready for review…
      </p>
    ),
  },
  {
    id: "sheets",
    label: "Sheets",
    icon: Sheet,
    className: "top-[38%] -right-1 sm:right-0",
    body: (
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm bg-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-1.5 bg-card" />
        ))}
      </div>
    ),
  },
  {
    id: "team",
    label: "Team",
    icon: UsersRound,
    className: "bottom-0 left-1/2 -translate-x-1/2",
    body: (
      <div className="flex -space-x-1">
        {["AM", "SK", "RJ"].map((a) => (
          <span
            key={a}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-card text-[7px] font-semibold text-foreground ring-1 ring-border"
          >
            {a}
          </span>
        ))}
      </div>
    ),
  },
];

export function EcosystemHero() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto aspect-square w-full max-w-105 select-none sm:aspect-[5/4] lg:aspect-square lg:max-w-none"
    >
      {/* Understated atmospheric glow */}
      <div className="absolute inset-8 rounded-full bg-primary/10 blur-3xl" />

      {/* Connectors */}
      <svg
        className="absolute inset-0 h-full w-full text-border"
        viewBox="0 0 400 400"
        fill="none"
        preserveAspectRatio="none"
      >
        <path
          d="M80 90 C 140 120, 160 160, 200 200"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <path
          d="M320 100 C 270 130, 240 160, 200 200"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <path
          d="M70 250 C 120 240, 150 220, 200 200"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <path
          d="M330 250 C 280 240, 250 220, 200 200"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <path
          d="M200 340 C 200 300, 200 240, 200 200"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      </svg>

      {/* Central Inbox card */}
      <div className="absolute top-1/2 left-1/2 w-52 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-3 shadow-xl shadow-primary/10 sm:w-60">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary">
            AM
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold text-foreground">
              Aarav Mehta
            </p>
            <p className="truncate text-[9px] text-muted-foreground">
              Bali package for 4 finalized
            </p>
          </div>
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
            3
          </span>
        </div>
        <div className="flex items-center justify-between pt-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-1.5 py-0.5 text-[8px] font-medium text-primary">
            <span className="h-1 w-1 rounded-full bg-primary" />
            Open · Assigned
          </span>
          <span className="text-[8px] text-muted-foreground">2m ago</span>
        </div>
      </div>

      {/* Satellite fragments */}
      {satellites.map((s) => (
        <div
          key={s.id}
          className={cn(
            "absolute w-28 rounded-lg border border-border bg-card-2 p-2 shadow-md shadow-black/5 sm:w-32",
            s.className
          )}
        >
          <div className="mb-1.5 flex items-center gap-1">
            <s.icon className="h-3 w-3 text-primary" />
            <span className="text-[9px] font-semibold text-foreground">
              {s.label}
            </span>
          </div>
          {s.body}
        </div>
      ))}
    </div>
  );
}
