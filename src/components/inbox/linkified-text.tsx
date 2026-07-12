import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { linkify } from "@/lib/inbox/linkify";

interface LinkifiedTextProps {
  text: string;
  /**
   * Outbound bubbles sit on the primary fill, so links need to read
   * against that surface rather than the default link colour.
   */
  onPrimary?: boolean;
  className?: string;
}

/**
 * Renders message text with bare URLs turned into clickable anchors.
 * Building anchors from parsed segments (rather than injecting HTML)
 * keeps the customer-supplied text safe from injection.
 */
export function LinkifiedText({ text, onPrimary, className }: LinkifiedTextProps) {
  const segments = linkify(text);

  return (
    <p className={cn("whitespace-pre-wrap break-words text-sm", className)}>
      {segments.map((segment, i) => {
        if (segment.type === "link") {
          return (
            <a
              key={i}
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "underline underline-offset-2 hover:opacity-80",
                onPrimary ? "text-primary-foreground" : "text-primary",
              )}
            >
              {segment.value}
            </a>
          );
        }
        return <Fragment key={i}>{segment.value}</Fragment>;
      })}
    </p>
  );
}
