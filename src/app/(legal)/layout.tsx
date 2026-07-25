import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  COMPANY_NAME,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  WEBSITE_DOMAIN,
} from "./_constants";

// Public, unauthenticated chrome for the legal pages. These pages sit
// OUTSIDE the (dashboard) group on purpose — they must render for
// signed-out visitors and for Google's OAuth reviewers. The root
// layout marks the whole app `robots: index:false`; legal pages are
// the exception (they need to be crawlable), so we re-enable indexing
// here for every route in this group.
export const metadata: Metadata = {
  robots: {
    index: true,
    follow: true,
  },
};

function LegalHeader() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/login" className="flex items-center gap-3">
          <Image
            src="/interscale-logo.png"
            alt={COMPANY_NAME}
            width={36}
            height={36}
            className="rounded-lg"
          />
          <span className="text-sm font-semibold text-foreground">
            {PRODUCT_NAME}
          </span>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/privacy-policy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms-and-conditions" className="hover:text-foreground">
            Terms
          </Link>
        </nav>
      </div>
    </header>
  );
}

function LegalFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-16 border-t border-border bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          &copy; {year} {COMPANY_NAME}. All rights reserved.
        </p>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/privacy-policy" className="hover:text-foreground">
            Privacy Policy
          </Link>
          <Link href="/terms-and-conditions" className="hover:text-foreground">
            Terms &amp; Conditions
          </Link>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="hover:text-foreground"
          >
            Contact
          </a>
          <a
            href={WEBSITE_DOMAIN}
            className="hover:text-foreground"
            target="_blank"
            rel="noopener noreferrer"
          >
            interscalechat.co.in
          </a>
        </nav>
      </div>
    </footer>
  );
}

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <LegalHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        {children}
      </main>
      <LegalFooter />
    </div>
  );
}
