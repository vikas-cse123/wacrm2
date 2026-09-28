"use client";

import { FileText } from "lucide-react";

/**
 * Workspace cell for a file/attachment value (a flow answer captured
 * from an inbound document/image, or a value that is itself a URL).
 *
 * Renders the SAME filename the cell already displayed, as a link
 * that opens the actual existing WACRM media URL in a NEW browser
 * tab (`/api/whatsapp/media/{mediaId}` serves images/PDFs inline, so
 * they preview instead of downloading). Only the filename is
 * clickable — the table row stays inert. Truncation/ellipsis for long
 * filenames is preserved, with the full name on hover.
 */

export interface AttachmentCellLinkProps {
  /** Existing file URL (never generated here — always resolved upstream). */
  url: string;
  /** The displayed filename — rendered unchanged. */
  fileName: string;
  /** Column/field display label (header + aria). */
  label: string;
  /** Edited dot (Workspace override present) — mirrors other cells. */
  edited?: boolean;
  /** Original flow value for the edited tooltip. */
  originalValue?: string | null;
}

export function AttachmentCellLink({
  url,
  fileName,
  label,
  edited = false,
  originalValue,
}: AttachmentCellLinkProps) {
  return (
    <span
      className="block min-w-0"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${fileName}`}
        aria-label={`${label} — open ${fileName} in a new tab`}
        className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate underline-offset-2 decoration-dotted hover:underline">
          {fileName}
        </span>
        {edited && (
          <span
            aria-label="Edited"
            title={
              originalValue
                ? `Edited — original: ${originalValue}`
                : "Edited"
            }
            className="inline-block size-1.5 shrink-0 rounded-full bg-blue-500"
          />
        )}
      </a>
    </span>
  );
}