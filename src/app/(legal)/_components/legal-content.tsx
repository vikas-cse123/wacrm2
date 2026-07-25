import type { ReactNode } from "react";

// Small presentational primitives shared by the Privacy Policy and
// Terms pages. Tailwind v4 is configured without the typography
// plugin, so we style the long-form legal copy by hand here using the
// app's design tokens (foreground / muted-foreground / border / etc.)
// so the pages inherit the active theme and dark/light mode.

export function LegalHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
      {children}
    </h1>
  );
}

export function LegalMeta({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 text-sm text-muted-foreground">{children}</p>
  );
}

// A numbered/labelled section. `id` lets the in-page table of contents
// (and external anchors) deep-link to a specific clause.
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mt-10 text-xl font-semibold text-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-muted-foreground/60">
      {children}
    </ul>
  );
}
