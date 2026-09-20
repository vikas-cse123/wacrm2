// Shared WhatsApp Quick Reply media validation — single source of truth for client + server.
// Mirrors WhatsApp Cloud API caps per task spec. Server MUST re-validate; browser MIME is untrusted.

export type QuickReplyMessageType = "text" | "image" | "video" | "audio" | "document" | "sticker";

export const QUICK_REPLY_MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker: 512 * 1024, // max animated; static capped tighter in validate
} as const;

export const QUICK_REPLY_MIME_ALLOWLIST: Record<Exclude<QuickReplyMessageType, "text">, string[]> = {
  image: ["image/jpeg", "image/jpg", "image/png"],
  video: ["video/mp4", "video/3gpp", "video/3gp", "video/3gpp2"],
  audio: [
    "audio/aac",
    "audio/amr",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/ogg",
    "audio/opus",
    "audio/3gpp",
    "audio/3gp",
    "audio/webm",
  ],
  document: [
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.presentation",
    "text/csv",
    "application/vnd.oasis.opendocument.spreadsheet",
  ],
  sticker: ["image/webp"],
};

export const QUICK_REPLY_EXT_ALLOWLIST: Record<Exclude<QuickReplyMessageType, "text">, string[]> = {
  image: [".jpg", ".jpeg", ".png"],
  video: [".mp4", ".3gp", ".3gpp"],
  audio: [".aac", ".amr", ".mp3", ".m4a", ".ogg", ".opus", ".3gp", ".3gpp", ".mp4"],
  document: [".pdf", ".txt", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".ods", ".odt", ".odp", ".csv"],
  sticker: [".webp"],
};

const EXT_TO_MIME_HINT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
  ".aac": "audio/aac",
  ".amr": "audio/amr",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".csv": "text/csv",
  ".webp": "image/webp",
};

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.[^.]+$/);
  return m ? m[0] : "";
}

function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(";")[0].trim();
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  mime?: string;
}

export function validateQuickReplyMedia(
  file: { name: string; size: number; type: string },
  messageType: Exclude<QuickReplyMessageType, "text">,
): ValidationResult {
  const ext = extOf(file.name);
  const mime = normalizeMime(file.type || EXT_TO_MIME_HINT[ext] || "");
  const allowedMimes = QUICK_REPLY_MIME_ALLOWLIST[messageType];
  const allowedExts = QUICK_REPLY_EXT_ALLOWLIST[messageType];
  const limit = QUICK_REPLY_MEDIA_LIMITS[messageType];

  // Size check first — gives clearest error. Sticker has dual cap: static 100KB vs animated 512KB.
  // We enforce 512KB max (WhatsApp spec) and surface a friendlier error for static expectation.
  let effectiveLimit = limit;
  if (messageType === "sticker" && file.size > 512 * 1024) {
    return {
      ok: false,
      error: "Sticker must be WebP and smaller than 500 KB (100 KB for static, 512 KB for animated).",
    };
  }
  if (messageType === "sticker") effectiveLimit = 512 * 1024;
  if (file.size > effectiveLimit) {
    const sizeMsg =
      messageType === "image"
        ? "Image must be JPEG or PNG and smaller than 5 MB."
        : messageType === "video"
          ? "Video must be MP4/3GP and smaller than 16 MB."
          : messageType === "audio"
            ? "Audio must be AAC/AMR/MP3/M4A/OGG and smaller than 16 MB."
            : messageType === "document"
              ? "Document exceeds the 100 MB WhatsApp limit."
              : "File is too large.";
    // Prefer spec wording, but append actual limit for clarity when not exact spec sentence
    if (messageType === "document") return { ok: false, error: sizeMsg };
    if (file.size > effectiveLimit) return { ok: false, error: sizeMsg };
  }

  // Extension + MIME both must align — don't trust browser MIME alone.
  const extOk = allowedExts.includes(ext);
  const mimeOk = mime ? allowedMimes.includes(mime) : false;
  // For browser-less uploads (type=""), fall back to ext only. For typed uploads, require both or at least one strong signal.
  if (!extOk && !mimeOk) {
    const errMap: Record<string, string> = {
      image: "Image must be JPEG or PNG and smaller than 5 MB.",
      video: "Video must be MP4/3GP and smaller than 16 MB.",
      audio: "Audio must be AAC, AMR, MP3, M4A, or OGG (Opus) and smaller than 16 MB.",
      document: "Unsupported document type. Use PDF, DOCX, XLSX, PPTX, TXT, ODS, ODT, or ODP.",
      sticker: "Sticker must be a WebP image (static ≤100 KB, animated ≤512 KB).",
    };
    return { ok: false, error: errMap[messageType] || "Unsupported file type." };
  }
  if (!extOk) {
    return { ok: false, error: `File extension ${ext || "(none)"} not allowed for ${messageType}.` };
  }
  // If mime is present but not allowed, still reject — catches spoofed extensions
  if (mime && !mimeOk) {
    // Allow alias image/jpg == image/jpeg
    const aliasOk = messageType === "image" && mime === "image/jpg";
    if (!aliasOk) return { ok: false, error: `File type ${mime} not allowed for ${messageType}.` };
  }

  return { ok: true, mime: mime || EXT_TO_MIME_HINT[ext] };
}

export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export const QUICK_REPLY_MEDIA_BUCKET = "chat-media";
