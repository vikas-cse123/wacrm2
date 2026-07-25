import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  Download,
  GitBranch,
  Inbox,
  Megaphone,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Table2,
  UserCheck,
  Users,
  Workflow,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  COMPANY_NAME,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  WEBSITE_DOMAIN,
} from "@/lib/site";

const TITLE =
  "Interscale WhatsApp CRM | WhatsApp Conversations, Automation and Google Sheets Sync";
const DESCRIPTION =
  "Interscale WhatsApp CRM helps businesses manage WhatsApp conversations, contacts, pipelines, broadcasts and automation flows, with optional Google Sheets synchronisation.";

// The homepage must be publicly indexable — the root layout marks the
// whole app `robots: index:false`, so we override that here (the same
// way the legal pages do). `title.absolute` bypasses the root layout's
// "%s — interscale" template so Google sees the exact required title.
export const metadata: Metadata = {
  metadataBase: new URL(WEBSITE_DOMAIN),
  title: { absolute: TITLE },
  description: DESCRIPTION,
  applicationName: PRODUCT_NAME,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: `${WEBSITE_DOMAIN}/`,
    siteName: PRODUCT_NAME,
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/interscale-logo.png",
        width: 512,
        height: 512,
        alt: PRODUCT_NAME,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: PRODUCT_NAME,
    description: DESCRIPTION,
    images: ["/interscale-logo.png"],
  },
};

const primaryCta = cn(
  buttonVariants({ variant: "default" }),
  "h-11 rounded-lg px-6 text-sm font-semibold hover:bg-primary/90",
);
const secondaryCta = cn(
  buttonVariants({ variant: "outline" }),
  "h-11 rounded-lg px-6 text-sm font-semibold",
);

const FEATURES = [
  {
    icon: Inbox,
    title: "Shared WhatsApp inbox",
    body: "Handle every WhatsApp conversation from one shared team inbox with real-time messaging.",
  },
  {
    icon: Users,
    title: "Contact management",
    body: "Organise customers with contact records, tags, notes and custom fields.",
  },
  {
    icon: MessageSquareText,
    title: "Templates and quick replies",
    body: "Send approved WhatsApp templates and reusable quick replies in a click.",
  },
  {
    icon: GitBranch,
    title: "Sales pipelines and deals",
    body: "Track deals across custom pipeline stages from first message to close.",
  },
  {
    icon: Megaphone,
    title: "Broadcasts",
    body: "Reach segments of your contacts with targeted WhatsApp broadcasts.",
  },
  {
    icon: Workflow,
    title: "Automation flows",
    body: "Build no-code flows that qualify, route and respond to customers automatically.",
  },
  {
    icon: Bot,
    title: "AI agents",
    body: "Let AI agents help answer common questions and assist your team.",
  },
  {
    icon: UserCheck,
    title: "Team assignment",
    body: "Assign chats to teammates so ownership of every conversation stays clear.",
  },
  {
    icon: Download,
    title: "Data export",
    body: "Export your CRM data whenever you need it for reporting or backup.",
  },
  {
    icon: Bell,
    title: "Notifications",
    body: "Stay on top of new messages with real-time and push notifications.",
  },
] as const;

const SHEETS_CAPABILITIES = [
  "Connect a Google account",
  "See which Google account is connected",
  "Select an existing spreadsheet",
  "Create a new spreadsheet",
  "Append collected flow responses as new rows",
  "Import previously completed responses when requested",
  "Disconnect the integration at any time",
] as const;

const STEPS = [
  {
    title: "Connect WhatsApp",
    body: "Link your WhatsApp Business number to start receiving and sending messages.",
  },
  {
    title: "Build an automation flow",
    body: "Design a no-code flow that greets, qualifies and responds to customers.",
  },
  {
    title: "Collect customer responses",
    body: "Capture the answers and details customers share as they move through the flow.",
  },
  {
    title: "Sync selected responses to Google Sheets",
    body: "Append the responses you choose as new rows in a linked Google Spreadsheet.",
  },
  {
    title: "Manage follow-up and sales activity",
    body: "Track deals, assign chats and follow up with everything in one CRM workspace.",
  },
] as const;

const SECURITY_POINTS = [
  {
    title: "Controlled user access",
    body: "Workspace members sign in to their own accounts, and chats can be assigned to specific teammates.",
  },
  {
    title: "Secure account authentication",
    body: "Access to the CRM is protected by authenticated sign-in for every user.",
  },
  {
    title: "You choose the spreadsheet",
    body: "Authorised users decide exactly which Google Spreadsheet the integration connects to.",
  },
  {
    title: "Disconnect at any time",
    body: "You can disconnect Google Sheets whenever you like, which removes the stored access.",
  },
] as const;

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/interscale-logo.png"
            alt={COMPANY_NAME}
            width={36}
            height={36}
            className="rounded-lg"
            priority
          />
          <span className="text-sm font-semibold text-foreground sm:text-base">
            {PRODUCT_NAME}
          </span>
        </Link>

        <nav className="hidden items-center gap-6 text-sm text-muted-foreground lg:flex">
          <a href="#features" className="hover:text-foreground">
            Features
          </a>
          <a href="#google-sheets" className="hover:text-foreground">
            Google Sheets Integration
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "h-9 px-3 text-sm font-medium text-foreground",
            )}
          >
            Login
          </Link>
          <Link
            href="/signup"
            className={cn(
              buttonVariants({ variant: "default" }),
              "h-9 rounded-lg px-4 text-sm font-semibold hover:bg-primary/90",
            )}
          >
            Get Started
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 mx-auto h-80 max-w-4xl rounded-full bg-primary/20 blur-3xl"
      />
      <div className="mx-auto max-w-6xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24 lg:pb-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3.5 text-primary" />
              WhatsApp CRM &amp; automation platform
            </span>
            <h1 className="mt-5 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              {PRODUCT_NAME}
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {PRODUCT_NAME} helps businesses manage WhatsApp conversations,
              contacts, sales pipelines, broadcasts and automation flows from
              one workspace.
            </p>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
              It is a business CRM and automation platform for teams that sell
              and support customers over WhatsApp &mdash; with optional Google
              Sheets synchronisation for the responses you collect.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className={primaryCta}>
                Get Started
                <ArrowRight className="size-4" />
              </Link>
              <Link href="/login" className={secondaryCta}>
                Login
              </Link>
            </div>
          </div>

          <DashboardPreview />
        </div>
      </div>
    </section>
  );
}

// A stylised, data-free illustration of the product. Deliberately NOT a
// real screenshot: production screenshots can contain real customer
// conversations, so this mock-up shows only sample, non-identifying UI.
function DashboardPreview() {
  return (
    <div className="relative">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-3">
          <span className="size-3 rounded-full bg-destructive/50" />
          <span className="size-3 rounded-full bg-amber-500/50" />
          <span className="size-3 rounded-full bg-emerald-500/50" />
          <span className="ml-3 text-xs text-muted-foreground">
            {PRODUCT_NAME}
          </span>
        </div>
        <div className="grid grid-cols-3">
          <div className="col-span-1 space-y-3 border-r border-border p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Inbox className="size-4 text-primary" />
              Inbox
            </div>
            {["Aisha K.", "Ravi M.", "Sofia L."].map((name, i) => (
              <div
                key={name}
                className={cn(
                  "rounded-lg p-2.5",
                  i === 0 ? "bg-primary/10" : "bg-muted/50",
                )}
              >
                <div className="text-[11px] font-medium text-foreground">
                  {name}
                </div>
                <div className="mt-1 h-1.5 w-4/5 rounded-full bg-muted-foreground/25" />
              </div>
            ))}
          </div>
          <div className="col-span-2 flex flex-col gap-3 p-4">
            <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-[11px] text-foreground">
              Hi! I would like to book a consultation.
            </div>
            <div className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-[11px] text-primary-foreground">
              Happy to help. What date works best for you?
            </div>
            <div className="mt-1 flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-2.5">
              <Table2 className="size-4 text-emerald-500" />
              <span className="text-[11px] text-muted-foreground">
                Response appended to Google Sheet
              </span>
              <Check className="ml-auto size-3.5 text-emerald-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
        {title}
      </h2>
      {children ? (
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          {children}
        </p>
      ) : null}
    </div>
  );
}

function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-border py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Features"
          title="Everything your team needs to sell on WhatsApp"
        >
          A complete CRM built around WhatsApp &mdash; from the first message to
          the closed deal.
        </SectionHeading>
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary/40"
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
                <Icon className="size-5 text-primary" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function GoogleSheets() {
  return (
    <section
      id="google-sheets"
      className="scroll-mt-20 border-t border-border py-20"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold text-primary">
              Google Sheets Integration
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Sync collected responses to Google Sheets
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              Authorised users can connect their Google account, select or
              create a Google Spreadsheet, and automatically append responses
              collected through CRM automation flows as new rows.
            </p>
            <p className="mt-3 text-base leading-relaxed text-muted-foreground">
              The integration is optional and fully under your control. With it,
              you can:
            </p>
            <ul className="mt-6 space-y-3">
              {SHEETS_CAPABILITIES.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 text-sm text-foreground"
                >
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
              {PRODUCT_NAME} does not access Gmail, Google Calendar, Google
              Contacts or other unrelated Google services. See our{" "}
              <Link
                href="/privacy-policy"
                className="text-primary hover:text-primary/80"
              >
                Privacy Policy
              </Link>{" "}
              for full details on how Google data is used.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center gap-3 border-b border-border pb-4">
              <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/10">
                <Table2 className="size-5 text-emerald-500" />
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">
                  Linked spreadsheet
                </div>
                <div className="text-xs text-muted-foreground">
                  Connected Google account
                </div>
              </div>
              <span className="ml-auto rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
                Connected
              </span>
            </div>
            <div className="mt-4 overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-3 bg-muted/50 text-[11px] font-medium text-muted-foreground">
                <div className="border-r border-border px-3 py-2">Name</div>
                <div className="border-r border-border px-3 py-2">Flow</div>
                <div className="px-3 py-2">Submitted</div>
              </div>
              {[
                ["Aisha K.", "Booking", "10:24"],
                ["Ravi M.", "Enquiry", "11:02"],
                ["Sofia L.", "Booking", "11:47"],
              ].map((row) => (
                <div
                  key={row[0]}
                  className="grid grid-cols-3 border-t border-border text-[11px] text-foreground"
                >
                  <div className="border-r border-border px-3 py-2">
                    {row[0]}
                  </div>
                  <div className="border-r border-border px-3 py-2">
                    {row[1]}
                  </div>
                  <div className="px-3 py-2">{row[2]}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Sample data shown for illustration only.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-20 border-t border-border py-20"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="How it works"
          title="From first message to synced record"
        >
          A simple flow connects your WhatsApp conversations to your CRM and,
          optionally, to Google Sheets.
        </SectionHeading>
        <ol className="mt-14 grid gap-5 md:grid-cols-5">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="relative rounded-2xl border border-border bg-card p-5"
            >
              <div className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {i + 1}
              </div>
              <h3 className="mt-4 text-sm font-semibold text-foreground">
                {step.title}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section className="border-t border-border py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Security and control"
          title="You stay in control of your data"
        >
          Practical safeguards and clear controls over how your workspace and
          Google data are used.
        </SectionHeading>
        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {SECURITY_POINTS.map((point) => (
            <div
              key={point.title}
              className="flex gap-4 rounded-2xl border border-border bg-card p-6"
            >
              <ShieldCheck className="size-5 shrink-0 text-primary" />
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {point.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {point.body}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-3xl text-center text-sm leading-relaxed text-muted-foreground">
          Data is handled according to our{" "}
          <Link
            href="/privacy-policy"
            className="text-primary hover:text-primary/80"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="border-t border-border py-20">
      <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Get started with {PRODUCT_NAME}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
          Bring your WhatsApp conversations, contacts and automation into one
          workspace.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/signup" className={primaryCta}>
            Get Started
            <ArrowRight className="size-4" />
          </Link>
          <Link href="/login" className={secondaryCta}>
            Login
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5">
              <Image
                src="/interscale-logo.png"
                alt={COMPANY_NAME}
                width={32}
                height={32}
                className="rounded-lg"
              />
              <span className="text-sm font-semibold text-foreground">
                {PRODUCT_NAME}
              </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              A WhatsApp CRM and automation platform by {COMPANY_NAME}.
            </p>
          </div>

          <nav className="flex flex-col gap-3 text-sm">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground/70 uppercase">
              Product &amp; legal
            </span>
            <a
              href="#features"
              className="text-muted-foreground hover:text-foreground"
            >
              Features
            </a>
            <a
              href="#google-sheets"
              className="text-muted-foreground hover:text-foreground"
            >
              Google Sheets Integration
            </a>
            <Link
              href="/privacy-policy"
              className="text-muted-foreground hover:text-foreground"
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms-and-conditions"
              className="text-muted-foreground hover:text-foreground"
            >
              Terms and Conditions
            </Link>
            <Link
              href="/login"
              className="text-muted-foreground hover:text-foreground"
            >
              Login
            </Link>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {SUPPORT_EMAIL}
            </a>
          </nav>
        </div>

        <div className="mt-10 border-t border-border pt-6">
          <p className="text-xs leading-relaxed text-muted-foreground">
            &copy; 2026 {COMPANY_NAME}. All rights reserved.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
            WhatsApp is a trademark of Meta Platforms, Inc. Google Sheets is a
            trademark of Google LLC. {PRODUCT_NAME} is an independent product and
            is not affiliated with, endorsed by or sponsored by Meta or Google.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main>
        <Hero />
        <Features />
        <GoogleSheets />
        <HowItWorks />
        <Security />
        <CtaBand />
      </main>
      <Footer />
    </div>
  );
}
