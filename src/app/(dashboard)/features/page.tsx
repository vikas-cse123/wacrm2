"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CategoryNav } from "@/components/features/category-nav";
import { EcosystemHero } from "@/components/features/ecosystem-hero";
import {
  AutomationAiSection,
  CommunicationSection,
  IntegrationsDataSection,
  SectionHeader,
  TeamOperationsSection,
} from "@/components/features/feature-sections";
import {
  CATEGORIES,
  SECTIONS,
  type Category,
  type FeatureSection,
} from "@/components/features/features-data";

function scrollToTarget(target: HTMLElement) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

function SectionBlock({ section }: { section: FeatureSection }) {
  return (
    <section aria-labelledby={`features-${section.id}`} className="scroll-mt-32">
      <SectionHeader section={section} />
      {section.id === "communication" && <CommunicationSection section={section} />}
      {section.id === "automation-ai" && <AutomationAiSection section={section} />}
      {section.id === "team-operations" && <TeamOperationsSection section={section} />}
      {section.id === "integrations-data" && <IntegrationsDataSection section={section} />}
    </section>
  );
}

export default function FeaturesPage() {
  const [category, setCategory] = useState<Category["id"]>("all");
  const sectionsRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () =>
      category === "all"
        ? SECTIONS
        : SECTIONS.filter((s) => s.id === category),
    [category]
  );

  const handleCategory = useCallback((id: Category["id"]) => {
    setCategory(id);
    // Keep the content in view after the layout changes.
    requestAnimationFrame(() => {
      if (sectionsRef.current) scrollToTarget(sectionsRef.current);
    });
  }, []);

  const handleExplore = useCallback(() => {
    const el = document.getElementById("platform-index");
    if (el) scrollToTarget(el);
  }, []);

  const activeLabel = CATEGORIES.find((c) => c.id === category)?.label ?? "";

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-24 sm:px-6">
      {/* ============ HERO ============ */}
      <div className="relative overflow-hidden">
        {/* Extremely subtle dotted texture, hero only */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_40%,black,transparent)]"
        />
        <div className="relative grid items-center gap-10 py-14 sm:py-16 lg:grid-cols-[55%_45%] lg:gap-8 lg:py-24">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">
              WACRM Platform
            </p>
            <h1 className="mt-3 max-w-130 text-[32px] leading-[1.08] font-semibold tracking-tight text-balance text-foreground sm:text-[42px] lg:text-[54px]">
              Everything your team needs to run{" "}
              <span className="text-primary">WhatsApp</span> at scale.
            </h1>
            <p className="mt-4 max-w-[560px] text-[15px] leading-relaxed text-muted-foreground">
              Bring conversations, customer data, automation, AI, team
              collaboration, and business tools into one connected workspace.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button size="lg" render={<Link href="/inbox" />}>
                Open Inbox
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Button>
              <Button size="lg" variant="outline" onClick={handleExplore}>
                Explore the platform
                <ArrowDown data-icon="inline-end" aria-hidden="true" />
              </Button>
            </div>
            <div className="mt-10 border-t border-border pt-4">
              <p className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                13 core capabilities
              </p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Communication · Automation · AI · Teams · Data
              </p>
            </div>
          </div>
          <EcosystemHero />
        </div>
      </div>

      {/* ============ CATEGORY INDEX ============ */}
      <div id="platform-index" className="scroll-mt-20">
        <div className="sticky top-0 z-10 -mx-4 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
          <CategoryNav active={category} onChange={handleCategory} />
          <p className="sr-only" aria-live="polite">
            Showing {activeLabel} features
          </p>
        </div>

        {/* ============ SECTIONS ============ */}
        <div ref={sectionsRef} className="scroll-mt-32 space-y-24 pt-12 lg:space-y-32">
          {visible.map((section) => (
            <SectionBlock key={section.id} section={section} />
          ))}
        </div>

        {/* ============ CLOSING ============ */}
        <div className="mt-24 flex flex-col items-start justify-between gap-4 rounded-xl border border-border bg-card p-6 sm:flex-row sm:items-center sm:p-7">
          <div>
            <p className="text-[17px] font-semibold tracking-tight text-foreground">
              Start where the work happens.
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Open the Inbox to see conversations, or revisit any capability above.
            </p>
          </div>
          <Button size="lg" render={<Link href="/inbox" />} className="shrink-0">
            Open Inbox
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
