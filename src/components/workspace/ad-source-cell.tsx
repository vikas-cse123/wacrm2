"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";
import {
  adSourceLabel,
  adSourcePlatform,
  toSafeAdSourceHref,
} from "@/lib/flows/workspace-ad-source";

/**
 * Facebook mark: the in-repo asset `public/icons/fb.png` (740×740
 * RGBA). Rendered small from the large source — crisp,
 * proportional, never stretched or cropped.
 */
export function FacebookMark({ className }: { className?: string }) {
  return (
    <Image
      src="/icons/fb.png"
      alt=""
      aria-hidden="true"
      width={96}
      height={96}
      className={cn("object-contain", className)}
    />
  );
}

/**
 * Instagram mark: the in-repo asset `public/icons/Insta.png`
 * (740×740 RGBA). Same compact rendering contract as Facebook.
 */
export function InstagramMark({ className }: { className?: string }) {
  return (
    <Image
      src="/icons/Insta.png"
      alt=""
      aria-hidden="true"
      width={96}
      height={96}
      className={cn("object-contain", className)}
    />
  );
}

/**
 * Lead Source cell: icon only, never URL text, never an arrow, never
 * a generic link icon. Facebook → `/icons/fb.png`, Instagram →
 * `/icons/Insta.png`. The icon links the exact stored URL in a new
 * tab; anything else (missing/invalid/unrecognized) renders a
 * neutral, non-clickable "—".
 */
export function AdSourceCell({ sourceUrl }: { sourceUrl: string | null | undefined }) {
  const platform = adSourcePlatform(sourceUrl);
  const href = platform ? toSafeAdSourceHref(sourceUrl) : null;

  // Only Facebook/Instagram have brand assets; anything else —
  // missing, invalid, or an unrecognized host — is a neutral "—".
  // (No generic link icon is ever shown.)
  if (platform !== "facebook" && platform !== "instagram") {
    return (
      <span className="text-muted-foreground" aria-label="No ad source">
        —
      </span>
    );
  }
  if (!href) {
    return (
      <span className="text-muted-foreground" aria-label="No ad source">
        —
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={adSourceLabel(platform)}
      title={adSourceLabel(platform)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1",
        "text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {platform === "facebook" ? (
        <FacebookMark className="h-6 w-6" />
      ) : (
        <InstagramMark className="h-6 w-6" />
      )}
    </a>
  );
}
