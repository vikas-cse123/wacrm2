"use client";

import { cn } from "@/lib/utils";
import { CATEGORIES, type Category } from "./features-data";

/* Sticky product index: horizontal pill navigator. Single-select;
   the active pill carries the indigo tint. */

export function CategoryNav({
  active,
  onChange,
}: {
  active: Category["id"];
  onChange: (id: Category["id"]) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter features by category"
      className="flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {CATEGORIES.map((c) => {
        const isActive = c.id === active;
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(c.id)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-all duration-200",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              isActive
                ? "border-primary/40 bg-primary-soft text-primary shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
