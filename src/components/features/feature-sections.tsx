"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Feature, FeatureSection } from "./features-data";
import { FeatureCard } from "./feature-card";
import { FeaturePreview } from "./previews";

/* Editorial section layouts — each category gets its own composition
   instead of a repeated card grid. */

/** Small label + title + one short description. */
export function SectionHeader({ section }: { section: FeatureSection }) {
  return (
    <div className="max-w-2xl">
      <p className="text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">
        {section.label}
      </p>
      <h2
        id={`features-${section.id}`}
        className="mt-2 text-[30px] leading-tight font-semibold tracking-tight text-foreground sm:text-[34px]"
      >
        {section.title}
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
        {section.description}
      </p>
    </div>
  );
}

/** Wide horizontal card: copy left, preview right. Optional second link
   (used by Google Sheets → Flow Sheets / All Sheets). */
export function FeatureCardWide({
  feature,
  secondary,
  className,
}: {
  feature: Feature;
  secondary?: { label: string; href: string };
  className?: string;
}) {
  const Icon = feature.icon;
  return (
    <div
      className={cn(
        "group rounded-xl border border-border bg-card p-6 transition-all duration-200 motion-safe:hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 sm:p-7",
        className
      )}
    >
      <div className="grid items-center gap-6 md:grid-cols-2">
        <div>
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary transition-transform duration-200 motion-safe:group-hover:-translate-y-0.5">
            <Icon className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
          <p className="mt-4 text-[17px] font-semibold tracking-tight text-foreground">
            {feature.name}
          </p>
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
            {feature.description}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4">
            <Link
              href={feature.href}
              aria-label={`${feature.name} — ${feature.action}`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {feature.action}
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-200 motion-safe:group-hover:translate-x-1"
                aria-hidden="true"
              />
            </Link>
            {secondary && (
              <Link
                href={secondary.href}
                aria-label={`${feature.name} — ${secondary.label}`}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {secondary.label}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="transition-transform duration-200 motion-safe:group-hover:scale-[1.01]"
        >
          <FeaturePreview kind={feature.preview} />
        </div>
      </div>
    </div>
  );
}

function byId(section: FeatureSection, id: string): Feature {
  const f = section.features.find((feat) => feat.id === id);
  if (!f) throw new Error(`Unknown feature: ${id}`);
  return f;
}

/** Communication: Inbox hero (2/3) + Contacts/Quick Replies stack,
   Bulk Message wide below. */
export function CommunicationSection({ section }: { section: FeatureSection }) {
  const inbox = byId(section, "inbox");
  const contacts = byId(section, "contacts");
  const quickReplies = byId(section, "quick-replies");
  const bulk = byId(section, "bulk-message");
  return (
    <div className="mt-8 space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <FeatureCard feature={inbox} className="lg:col-span-2" />
        <div className="flex flex-col gap-5">
          <FeatureCard feature={contacts} />
          <FeatureCard feature={quickReplies} />
        </div>
      </div>
      <FeatureCardWide feature={bulk} />
    </div>
  );
}

/** Automation & AI: Automations ↔ Flows pair, AI Agents wide below. */
export function AutomationAiSection({ section }: { section: FeatureSection }) {
  const automations = byId(section, "automations");
  const flows = byId(section, "flows");
  const ai = byId(section, "ai-agents");
  return (
    <div className="mt-8 space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <FeatureCard feature={automations} />
        <FeatureCard feature={flows} />
      </div>
      <p className="text-center text-[12px] text-muted-foreground">
        Automations and Flows share triggers, contact context, and handoff —
        start visual, add intelligence where it counts.
      </p>
      <FeatureCardWide feature={ai} />
    </div>
  );
}

/** Team & Operations: Dashboard wide + roster, routing strip below. */
export function TeamOperationsSection({ section }: { section: FeatureSection }) {
  const dashboard = byId(section, "dashboard");
  const team = byId(section, "team");
  const assignment = byId(section, "assignment");
  return (
    <div className="mt-8 space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <FeatureCard feature={dashboard} className="lg:col-span-2" />
        <FeatureCard feature={team} />
      </div>
      <FeatureCardWide feature={assignment} />
    </div>
  );
}

/** Integrations & Data: Sheets hero, Export + Templates pair. */
export function IntegrationsDataSection({
  section,
}: {
  section: FeatureSection;
}) {
  const sheets = byId(section, "sheets");
  const dataExport = byId(section, "export");
  const templates = byId(section, "templates");
  return (
    <div className="mt-8 space-y-5">
      <FeatureCardWide
        feature={sheets}
        secondary={{ label: "All Sheets", href: "/all-sheets" }}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <FeatureCard feature={dataExport} />
        <FeatureCard feature={templates} />
      </div>
    </div>
  );
}
