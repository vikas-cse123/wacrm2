import { requireOwnerPage } from "@/lib/auth/require-owner-page";

// Owner-only. Redirects non-owners to /dashboard on the server, so the
// AI Agents page can't be reached by editing the URL.
export default async function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOwnerPage();
  return <>{children}</>;
}
