import { requireOwnerPage } from "@/lib/auth/require-owner-page";

// Owner-only. Covers /flows and every subroute (/flows/[id], .../runs).
// Redirects non-owners to /dashboard on the server, so Flows can't be
// reached by editing the URL.
export default async function FlowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOwnerPage();
  return <>{children}</>;
}
