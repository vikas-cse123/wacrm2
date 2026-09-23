"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Feature } from "./features-data";
import { FeaturePreview } from "./previews";

/* Feature showcase card: icon → title → 2-line description →
   miniature product preview → action row. The whole card is one link. */

export function FeatureCard({
  feature,
  className,
}: {
  feature: Feature;
  className?: string;
}) {
  const Icon = feature.icon;
  return (
    <Link
      href={feature.href}
      aria-label={`${feature.name} — ${feature.action}`}
      className={cn(
        "group flex flex-col rounded-xl border border-border bg-card p-6",
        "transition-all duration-200 motion-safe:hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        className
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary transition-transform duration-200 motion-safe:group-hover:-translate-y-0.5">
        <Icon className="h-4.5 w-4.5" aria-hidden="true" />
      </span>

      <span className="mt-4 flex items-start justify-between gap-2">
        <span className="text-[17px] font-semibold tracking-tight text-foreground">
          {feature.name}
        </span>
        <ArrowUpRight
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-all duration-200 group-hover:text-primary"
          aria-hidden="true"
        />
      </span>

      <span className="mt-1.5 line-clamp-2 min-h-10 text-[13px] leading-relaxed text-muted-foreground">
        {feature.description}
      </span>

      <span
        aria-hidden="true"
        className="mt-4 block transition-transform duration-200 motion-safe:group-hover:scale-[1.01]"
      >
        <FeaturePreview kind={feature.preview} />
      </span>

      <span className="mt-4 inline-flex items-center gap-1.5 border-t border-border pt-4 text-[13px] font-medium text-primary">
        {feature.action}
        <ArrowRight
          className="h-3.5 w-3.5 transition-transform duration-200 motion-safe:group-hover:translate-x-1"
          aria-hidden="true"
        />
      </span>
    </Link>
  );
}
