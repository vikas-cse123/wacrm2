import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  // The auth pages are the only public entry points, so we surface the
  // legal links here (in addition to the legal pages' own footer). The
  // footer is pinned to the bottom of the viewport and sits behind the
  // centered auth cards, which are min-h-screen — this keeps it visible
  // without restructuring each individual page.
  return (
    <div className="relative min-h-screen">
      {children}
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4">
        <nav className="pointer-events-auto flex items-center gap-4 text-xs text-muted-foreground">
          <Link href="/privacy-policy" className="hover:text-foreground">
            Privacy Policy
          </Link>
          <span aria-hidden className="text-muted-foreground/40">
            &middot;
          </span>
          <Link href="/terms-and-conditions" className="hover:text-foreground">
            Terms &amp; Conditions
          </Link>
        </nav>
      </footer>
    </div>
  );
}
