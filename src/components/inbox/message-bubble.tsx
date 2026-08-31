"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { LinkifiedText } from "./linkified-text";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function displayMessageStatus(status: Message["status"]) {
  if (status === "read") return "Seen";
  if (status === "failed") return "Failed";
  if (status === "sending") return "Sending";
  return "Unseen";
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} unavailable</span>
    </div>
  );
}

/**
 * Full-screen lightbox overlay for viewing an expanded image.
 * Closes on backdrop click, close-button click, or Escape key.
 */
function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
        aria-label="Close image"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <img
        src={src ?? ""}
        alt={alt}
        className="max-h-64 max-w-60 cursor-pointer rounded-lg object-cover transition-opacity hover:opacity-90"
        onClick={() => setIsExpanded(true)}
        onError={() => setError(true)}
      />
      {isExpanded && src && (
        <ImageLightbox src={src} alt={alt} onClose={() => setIsExpanded(false)} />
      )}
    </>
  );
}

/**
 * Which way to render a `content_type === 'interactive'` bubble.
 *
 * - "inbound-reply": the customer tapped a button/list row (webhook
 *   stores the tapped title in content_text + id in
 *   interactive_reply_id) — render the "↩ Button reply" affordance.
 * - "outgoing-prompt": the bot's Send Buttons prompt with the offered
 *   buttons persisted (interactive_buttons, set by the flows engine's
 *   meta-send) — render the body plus read-only option chips.
 * - "plain": anything else (historical outgoing prompts with no
 *   stored buttons, or malformed rows) — just the body text.
 *
 * Pure function so the branching is unit-testable without a DOM.
 */
export function interactiveRenderKind(message: Message): {
  kind: "inbound-reply" | "outgoing-prompt" | "plain";
  buttons: Array<{ id: string; title: string }>;
} {
  if (message.content_type !== "interactive") {
    return { kind: "plain", buttons: [] };
  }
  if (message.sender_type === "customer") {
    return { kind: "inbound-reply", buttons: [] };
  }
  const buttons = Array.isArray(message.interactive_buttons)
    ? message.interactive_buttons.filter(
        (b): b is { id: string; title: string } =>
          b != null && typeof b.id === "string" && typeof b.title === "string",
      )
    : [];
  return {
    kind: buttons.length > 0 ? "outgoing-prompt" : "plain",
    buttons,
  };
}

function MessageContent({
  message,
  onPrimary,
}: {
  message: Message;
  onPrimary: boolean;
}) {
  switch (message.content_type) {
    case "text":
      return (
        <LinkifiedText text={message.content_text ?? ""} onPrimary={onPrimary} />
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label="Image" />
          )}
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={onPrimary}
              className="mt-1"
            />
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label="Video" />
          )}
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={onPrimary}
              className="mt-1"
            />
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label="Audio" />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || "Document"} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || "Document"}
          </span>
        </a>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            Template
          </span>
          {message.content_text && (
            <LinkifiedText
              text={message.content_text}
              onPrimary={onPrimary}
              className="mt-1"
            />
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Location shared"}</span>
        </div>
      );

    case "interactive": {
      const { kind, buttons } = interactiveRenderKind(message);

      // Outgoing Send Buttons prompt from the bot: show the body, then
      // the options that were offered, as READ-ONLY chips — a
      // historical record of what the customer saw, not clickable
      // actions. No "↩ Button reply" affordance here; that label means
      // the customer tapped something.
      if (kind === "outgoing-prompt") {
        return (
          <div className="flex flex-col gap-1.5">
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || "[Interactive message]"}
            </p>
            <div className="flex flex-col gap-1">
              {buttons.map((b) => (
                <div
                  key={b.id}
                  className="rounded-lg border border-primary-foreground/25 bg-primary-foreground/10 px-2.5 py-1 text-center text-xs font-medium text-primary-foreground"
                >
                  {b.title}
                </div>
              ))}
            </div>
          </div>
        );
      }

      // Inbound: the customer tapped a reply button or list row on a
      // message the bot sent. We show the tapped option's title (already
      // in content_text, set by parseMessageContent in the webhook) with
      // a small affordance so agents reading the inbox can tell at a
      // glance that this is a tap rather than the customer typing the
      // same words. Historical outgoing prompts with no stored buttons
      // fall through here to the same plain body rendering as before.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <CornerDownLeft className="h-3 w-3" />
            Button reply
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "[Interactive reply]"}
          </p>
        </div>
      );
    }

    default:
      return (
        <LinkifiedText
          text={message.content_text || "[Unsupported message type]"}
          onPrimary={onPrimary}
        />
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "h:mm a");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} onPrimary={isAgent} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && (
            <>
              <span className="text-primary-foreground/50 text-[10px]">·</span>
              <span className="text-primary-foreground/70 text-[10px]">
                {displayMessageStatus(message.status)}
              </span>
            </>
          )}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
