"use client";

import { Mic } from "lucide-react";
import Link from "next/link";

import { useAuth } from "@/hooks/use-auth";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Call Recording panel — how this account receives phone call
 * recordings from CallVault devices.
 *
 * Informational only: there is no per-device registry to manage
 * (devices authenticate as their own WhatsApp Max user, so
 * nothing here can leak another member's session). Each teammate
 * connects their own phone from inside CallVault with their own
 * WhatsApp Max email + password; uploads attribute to whoever is
 * logged in on that device.
 */
export function CallRecordingPanel() {
  const { account } = useAuth();

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Call Recording"
        description="Connect CallVault to your WhatsApp Max account."
      />

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-muted-foreground">
            <Mic className="size-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              WhatsApp Max
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Your CallVault devices can upload finished recordings to
              this WhatsApp Max account
              {account?.name ? (
                <>
                  {" "}(<span className="font-medium text-foreground">{account.name}</span>)
                </>
              ) : null}
              . On the phone, open CallVault → WhatsApp Max, enter
              the server URL and sign in with your own WhatsApp Max
              email and password — no API keys to copy.
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Install CallVault on the Android phone.</li>
              <li>
                In CallVault, open the WhatsApp Max section and enter
                this server&apos;s URL.
              </li>
              <li>
                Sign in with your WhatsApp Max email and password,
                then tap Connect.
              </li>
              <li>
                Finished recordings upload automatically and appear
                under{" "}
                <Link href="/recordings" className="text-primary hover:underline">
                  Recordings
                </Link>
                .
              </li>
            </ol>
            <p className="mt-3 text-sm text-muted-foreground">
              Each recording is attributed to whoever is logged in on
              that phone. To stop uploads from a phone, open CallVault
              there and tap Disconnect — nothing here can sign out
              another member&apos;s device.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
