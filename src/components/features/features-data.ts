import {
  Bot,
  Download,
  FileText,
  LayoutDashboard,
  MessageSquare,
  MessageSquareText,
  Radio,
  Route,
  Sheet,
  Users,
  UsersRound,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type FeatureCategory =
  | "communication"
  | "automation-ai"
  | "team-operations"
  | "integrations-data";

export interface Category {
  id: FeatureCategory | "all";
  label: string;
}

export const CATEGORIES: Category[] = [
  { id: "all", label: "Everything" },
  { id: "communication", label: "Communication" },
  { id: "automation-ai", label: "Automation & AI" },
  { id: "team-operations", label: "Team & Operations" },
  { id: "integrations-data", label: "Integrations & Data" },
];

export type PreviewKind =
  | "inbox"
  | "contacts"
  | "quick-replies"
  | "campaign"
  | "workflow"
  | "flow-canvas"
  | "ai"
  | "dashboard"
  | "roster"
  | "routing"
  | "sheets"
  | "export"
  | "templates";

export interface Feature {
  id: string;
  name: string;
  description: string;
  href: string;
  action: string;
  icon: LucideIcon;
  category: FeatureCategory;
  preview: PreviewKind;
}

export interface FeatureSection {
  id: Exclude<FeatureCategory, "all">;
  label: string;
  title: string;
  description: string;
  features: Feature[];
}

export const SECTIONS: FeatureSection[] = [
  {
    id: "communication",
    label: "Communication",
    title: "Every conversation, in one place.",
    description:
      "Give your team one shared workspace to capture, organize, and respond to customers.",
    features: [
      {
        id: "inbox",
        name: "Shared WhatsApp Inbox",
        description:
          "Manage customer conversations from one shared WhatsApp workspace.\nRead, reply, assign, search, and organize conversations in real time.",
        href: "/inbox",
        action: "Open Inbox",
        icon: MessageSquare,
        category: "communication",
        preview: "inbox",
      },
      {
        id: "contacts",
        name: "Contacts",
        description:
          "Keep every customer organized with tags, companies, custom fields, and detailed profiles.\nImport, create, edit, search, and manage contacts with account-safe phone deduplication.",
        href: "/contacts",
        action: "Manage contacts",
        icon: Users,
        category: "communication",
        preview: "contacts",
      },
      {
        id: "quick-replies",
        name: "Quick Replies",
        description:
          "Save reusable text and media responses for common customer conversations.\nFind and send the right reply instantly from the Inbox.",
        href: "/quick-replies",
        action: "Browse quick replies",
        icon: MessageSquareText,
        category: "communication",
        preview: "quick-replies",
      },
      {
        id: "bulk-message",
        name: "Bulk Message",
        description:
          "Create targeted WhatsApp campaigns using approved templates, audiences, and personalized variables.\nSchedule sends and track delivery, reads, replies, and recipient-level results.",
        href: "/broadcasts",
        action: "Create a campaign",
        icon: Radio,
        category: "communication",
        preview: "campaign",
      },
    ],
  },
  {
    id: "automation-ai",
    label: "Automation & AI",
    title: "Turn conversations into workflows.",
    description:
      "Automate repetitive work while giving your team AI-powered assistance when it matters.",
    features: [
      {
        id: "automations",
        name: "No-code Automations",
        description:
          "Build automated customer journeys with triggers, conditions, waits, tags, webhooks, and scheduling.\nCreate visual workflows for menus, buttons, media, assignment, and human handoff.",
        href: "/automations",
        action: "Build automations",
        icon: Zap,
        category: "automation-ai",
        preview: "workflow",
      },
      {
        id: "flows",
        name: "Flows",
        description:
          "Build visual WhatsApp experiences with messages, buttons, media, conditions, variables, and branching.\nCreate reusable customer journeys without rebuilding the same conversation from scratch.",
        href: "/flows",
        action: "Design flows",
        icon: Workflow,
        category: "automation-ai",
        preview: "flow-canvas",
      },
      {
        id: "ai-agents",
        name: "AI Agents",
        description:
          "Draft replies, automate conversations, and build intelligent customer support agents with your own AI provider.\nEnhance responses with your knowledge base using hybrid search.",
        href: "/agents",
        action: "Meet your agents",
        icon: Bot,
        category: "automation-ai",
        preview: "ai",
      },
    ],
  },
  {
    id: "team-operations",
    label: "Team & Operations",
    title: "Keep the whole team aligned.",
    description:
      "Route conversations, manage responsibilities, and understand performance without leaving the workspace.",
    features: [
      {
        id: "dashboard",
        name: "Dashboard",
        description:
          "See the performance of your WhatsApp CRM from one central workspace.\nTrack KPIs, response times, message volume, flows, activity, and trends.",
        href: "/dashboard",
        action: "View dashboard",
        icon: LayoutDashboard,
        category: "team-operations",
        preview: "dashboard",
      },
      {
        id: "team",
        name: "Team Accounts + Roles",
        description:
          "Manage your team with invitations, roles, ownership controls, member management, and presence.\nKeep customer conversations organized across owners, admins, agents, and viewers.",
        href: "/settings?tab=members",
        action: "Manage team",
        icon: UsersRound,
        category: "team-operations",
        preview: "roster",
      },
      {
        id: "assignment",
        name: "Chat Assignment",
        description:
          "Route incoming customer conversations to the right team members automatically.\nCreate assignment policies that balance workloads and keep response times under control.",
        href: "/chat-assignment",
        action: "Configure routing",
        icon: Route,
        category: "team-operations",
        preview: "routing",
      },
    ],
  },
  {
    id: "integrations-data",
    label: "Integrations & Data",
    title: "Your customer data stays connected.",
    description:
      "Move lead data into the tools your team already uses while keeping your CRM portable.",
    features: [
      {
        id: "sheets",
        name: "Google Sheets",
        description:
          "Connect WhatsApp lead capture with Google Sheets for structured data collection and follow-up.\nSync leads, map destinations, reconcile incomplete rows, and assign ownership automatically.",
        href: "/data-export",
        action: "Open Flow Sheets",
        icon: Sheet,
        category: "integrations-data",
        preview: "sheets",
      },
      {
        id: "export",
        name: "Data Export",
        description:
          "Export your CRM data whenever you need a portable copy of your workspace.\nExport supported contacts, deals, messages, and other business data.",
        href: "/data-export",
        action: "Export data",
        icon: Download,
        category: "integrations-data",
        preview: "export",
      },
      {
        id: "templates",
        name: "Message Templates",
        description:
          "Create and manage Meta-approved WhatsApp templates from one place.\nSubmit, edit, sync, test, and monitor template approval and quality status.",
        href: "/templates",
        action: "Manage templates",
        icon: FileText,
        category: "integrations-data",
        preview: "templates",
      },
    ],
  },
];
