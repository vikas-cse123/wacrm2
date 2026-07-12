import { requireOwnerPage } from "@/lib/auth/require-owner-page";

// Owner-only. Redirects non-owners to /dashboard on the server, so
// Settings can't be reached by editing the URL — the backend counterpart
// to the hidden nav entry.
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOwnerPage();
  return <>{children}</>;
}
