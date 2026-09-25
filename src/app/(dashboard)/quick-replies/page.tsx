"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import {
  Plus,
  Search,
  Star,
  Pencil,
  Trash2,
  MessageSquareText,
  Lock,
  Globe,
  X,
  Image as ImageIcon,
  Music,
  FileText,
  Upload,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsPanelHead } from "@/components/settings/settings-panel-head";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { QuickReply } from "@/components/inbox/quick-reply-picker";
import {
  validateQuickReplyMedia,
  humanFileSize,
  QUICK_REPLY_MEDIA_BUCKET,
  type QuickReplyMessageType,
} from "@/lib/quick-replies/media-validation";
import { uploadAccountMedia, deleteAccountMedia } from "@/lib/storage/upload-media";

type FormData = {
  title: string;
  shortcut: string;
  message: string;
  category: string;
  visibility: "personal" | "shared";
  is_favorite: boolean;
  message_type: QuickReplyMessageType;
  media_url: string | null;
  media_path: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_file_size: number | null;
  media_caption: string;
};

const EMPTY_FORM: FormData = {
  title: "",
  shortcut: "",
  message: "",
  category: "",
  visibility: "shared",
  is_favorite: false,
  message_type: "text",
  media_url: null,
  media_path: null,
  media_mime_type: null,
  media_file_name: null,
  media_file_size: null,
  media_caption: "",
};

const MESSAGE_TYPES: { value: QuickReplyMessageType; label: string; icon: React.ReactNode }[] = [
  { value: "text", label: "Text", icon: <MessageSquareText className="h-3 w-3" /> },
  { value: "image", label: "Image", icon: <ImageIcon className="h-3 w-3" /> },
  { value: "audio", label: "Audio", icon: <Music className="h-3 w-3" /> },
  { value: "document", label: "Document", icon: <FileText className="h-3 w-3" /> },
];

const ACCEPT_BY_TYPE: Record<Exclude<QuickReplyMessageType, "text">, string> = {
  image: "image/jpeg,image/png,image/jpg",
  video: "video/mp4,video/3gpp,video/3gp",
  audio: "audio/aac,audio/amr,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg,audio/opus,audio/3gpp",
  document: "application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation,text/csv",
  sticker: "image/webp",
};

function typeTag(reply: QuickReply): string {
  const t = (reply.message_type || "text") as QuickReplyMessageType;
  if (t === "document" && reply.media_file_name) {
    return reply.media_file_name.split(".").pop()?.toUpperCase() || "Document";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export default function QuickRepliesPage() {
  const { accountId, user, isOwner, isAdmin } = useAuth();
  const canEdit = useCan("send-messages");

  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<QuickReply | null>(null);
  const [deleting, setDeleting] = useState(false);

  const supabase = useMemo(() => createClient(), []);

  const fetchReplies = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("quick_replies")
      .select("*")
      .eq("account_id", accountId)
      .order("is_favorite", { ascending: false })
      .order("title");
    if (error) {
      toast.error("Failed to load quick replies");
      console.error(error);
    }
    // Normalize message_type for legacy rows
    const normalized = ((data as QuickReply[]) || []).map((r) => ({
      ...r,
      message_type: (r.message_type as QuickReplyMessageType) || "text",
    }));
    setReplies(normalized);
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    fetchReplies();
  }, [fetchReplies]);

  // Categories
  const categories = useMemo(() => {
    const cats = new Set<string>();
    replies.forEach((r) => {
      if (r.category) cats.add(r.category);
    });
    return Array.from(cats).sort();
  }, [replies]);

  // Filtered list
  const filtered = useMemo(() => {
    let list = replies;

    if (activeCategory) {
      list = list.filter((r) => r.category === activeCategory);
    }

    if (showFavoritesOnly) {
      list = list.filter((r) => r.is_favorite);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.shortcut.toLowerCase().includes(q) ||
          r.title.toLowerCase().includes(q) ||
          (r.message && r.message.toLowerCase().includes(q)) ||
          (r.media_caption && r.media_caption.toLowerCase().includes(q)) ||
          (r.media_file_name && r.media_file_name.toLowerCase().includes(q)) ||
          r.category.toLowerCase().includes(q),
      );
    }

    return list;
  }, [replies, search, activeCategory, showFavoritesOnly]);

  // Can the current user edit this reply?
  const canEditReply = useCallback(
    (reply: QuickReply) => {
      if (reply.created_by === user?.id) return true;
      if (reply.visibility === "shared" && (isOwner || isAdmin)) return true;
      return false;
    },
    [user?.id, isOwner, isAdmin],
  );

  // Open create dialog
  const handleCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  // Open edit dialog
  const handleEdit = (reply: QuickReply) => {
    setEditingId(reply.id);
    setForm({
      title: reply.title,
      shortcut: reply.shortcut,
      message: reply.message || "",
      category: reply.category,
      visibility: reply.visibility,
      is_favorite: reply.is_favorite,
      message_type: (reply.message_type as QuickReplyMessageType) || "text",
      media_url: reply.media_url,
      media_path: reply.media_path,
      media_mime_type: reply.media_mime_type,
      media_file_name: reply.media_file_name,
      media_file_size: reply.media_file_size,
      media_caption: reply.media_caption || "",
    });
    setDialogOpen(true);
  };

  // Handle file selection + validation + upload
  const handleFile = async (file: File) => {
    if (form.message_type === "text") return;
    const mt = form.message_type as Exclude<QuickReplyMessageType, "text">;
    const validation = validateQuickReplyMedia({ name: file.name, size: file.size, type: file.type }, mt);
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    setUploading(true);
    try {
      // GC previous staged media if replacing (only if not yet saved? We GC old path after successful new upload)
      const prevPath = form.media_path;
      const { publicUrl, path } = await uploadAccountMedia(QUICK_REPLY_MEDIA_BUCKET, file);
      setForm((f) => ({
        ...f,
        media_url: publicUrl,
        media_path: path,
        media_mime_type: validation.mime || file.type,
        media_file_name: file.name,
        media_file_size: file.size,
      }));
      toast.success("File uploaded");
      // If editing existing reply, don't delete old object yet — wait until save succeeds and then GC.
      // For new reply replace, GC previous staged upload
      if (prevPath && !editingId) {
        void deleteAccountMedia(QUICK_REPLY_MEDIA_BUCKET, prevPath).catch(() => {});
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const handleRemoveMedia = () => {
    // GC staged upload if not yet persisted (path under account's folder, RLS allows delete)
    if (form.media_path && !editingId) {
      void deleteAccountMedia(QUICK_REPLY_MEDIA_BUCKET, form.media_path).catch(() => {});
    }
    setForm((f) => ({
      ...f,
      media_url: null,
      media_path: null,
      media_mime_type: null,
      media_file_name: null,
      media_file_size: null,
      media_caption: "",
    }));
  };

  // Save (create or update)
  const handleSave = async () => {
    if (!accountId || !user) return;
    if (!form.title.trim() || !form.shortcut.trim()) {
      toast.error("Title and shortcut are required");
      return;
    }
    if (form.message_type === "text" && !form.message.trim()) {
      toast.error("Message is required for text replies");
      return;
    }
    if (form.message_type !== "text" && !form.media_url) {
      toast.error("Please upload a file for this media reply");
      return;
    }
    if (uploading) {
      toast.error("Please wait for upload to finish");
      return;
    }

    const shortcut = form.shortcut.trim().replace(/^\//, "").replace(/\s+/g, "-");
    if (!shortcut) {
      toast.error("Shortcut cannot be empty");
      return;
    }

    setSaving(true);

    // Re-validate server-side before DB write (don't trust client)
    if (form.message_type !== "text" && form.media_file_name && form.media_file_size) {
      const v = validateQuickReplyMedia(
        { name: form.media_file_name, size: form.media_file_size, type: form.media_mime_type || "" },
        form.message_type as Exclude<QuickReplyMessageType, "text">,
      );
      if (!v.ok) {
        toast.error(v.error);
        setSaving(false);
        return;
      }
    }

    const payload = {
      account_id: accountId,
      created_by: user.id,
      title: form.title.trim(),
      shortcut,
      message: form.message_type === "text" ? form.message.trim() : form.media_caption.trim() || form.message.trim() || "",
      category: form.category.trim(),
      visibility: form.visibility,
      is_favorite: form.is_favorite,
      message_type: form.message_type,
      media_url: form.message_type === "text" ? null : form.media_url,
      media_path: form.message_type === "text" ? null : form.media_path,
      media_mime_type: form.message_type === "text" ? null : form.media_mime_type,
      media_file_name: form.message_type === "text" ? null : form.media_file_name,
      media_file_size: form.message_type === "text" ? null : form.media_file_size,
      media_caption: form.message_type === "text" ? null : form.media_caption.trim() || null,
    };

    // For update: capture old media path to GC after success if replaced
    const oldReply = editingId ? replies.find((r) => r.id === editingId) : null;
    const oldPath = oldReply?.media_path;

    if (editingId) {
      const { created_by: _, account_id: __, ...updatePayload } = payload;
      const { error } = await supabase
        .from("quick_replies")
        .update({ ...updatePayload, updated_at: new Date().toISOString() })
        .eq("id", editingId);
      if (error) {
        toast.error(error.message.includes("unique") ? "This shortcut is already taken" : "Failed to update");
        setSaving(false);
        return;
      }
      // GC old storage object if media was replaced (safe: old object belongs to same account path)
      if (oldPath && oldPath !== form.media_path) {
        void deleteAccountMedia(QUICK_REPLY_MEDIA_BUCKET, oldPath).catch(() => {});
      }
      toast.success("Quick reply updated");
    } else {
      const { error } = await supabase.from("quick_replies").insert(payload);
      if (error) {
        toast.error(error.message.includes("unique") ? "This shortcut is already taken" : "Failed to create");
        setSaving(false);
        return;
      }
      toast.success("Quick reply created");
    }

    setSaving(false);
    setDialogOpen(false);
    fetchReplies();
  };

  // Delete
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    // GC storage if media reply
    const path = deleteTarget.media_path;
    const { error } = await supabase
      .from("quick_replies")
      .delete()
      .eq("id", deleteTarget.id);
    if (error) {
      toast.error("Failed to delete");
    } else {
      if (path) void deleteAccountMedia(QUICK_REPLY_MEDIA_BUCKET, path).catch(() => {});
      toast.success("Quick reply deleted");
    }
    setDeleting(false);
    setDeleteTarget(null);
    fetchReplies();
  };

  // Toggle favorite
  const handleToggleFavorite = async (reply: QuickReply) => {
    const { error } = await supabase
      .from("quick_replies")
      .update({ is_favorite: !reply.is_favorite })
      .eq("id", reply.id);
    if (error) {
      toast.error("Failed to update");
      return;
    }
    setReplies((prev) =>
      prev.map((r) =>
        r.id === reply.id ? { ...r, is_favorite: !r.is_favorite } : r,
      ),
    );
  };

  const isMediaType = form.message_type !== "text";

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="Quick Replies"
        description="Save and reuse frequently sent messages"
        action={
          <GatedButton
            canAct={canEdit}
            gateReason="send messages"
            onClick={handleCreate}
            size="sm"
          >
            <Plus className="mr-1 h-4 w-4" />
            New Reply
          </GatedButton>
        }
      />

      {/* Search + Filters */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, shortcut, or message…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveCategory(null);
              setShowFavoritesOnly(false);
            }}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              !activeCategory && !showFavoritesOnly
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            All ({replies.length})
          </button>
          <button
            type="button"
            onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
            className={cn(
              "flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              showFavoritesOnly
                ? "bg-amber-500/20 text-amber-400"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            <Star className="h-3 w-3" />
            Favorites
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() =>
                setActiveCategory(activeCategory === cat ? null : cat)
              }
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                activeCategory === cat
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <MessageSquareText className="h-8 w-8 text-muted-foreground opacity-40" />
            <p className="mt-3 text-sm text-muted-foreground">
              {replies.length === 0
                ? "No quick replies yet. Create one to get started!"
                : "No quick replies match your search"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {filtered.map((reply) => (
            <Card key={reply.id}>
              <CardContent className="flex items-start justify-between gap-3 pt-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-foreground">
                      {reply.title}
                    </h3>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      /{reply.shortcut}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {typeTag(reply)}
                    </span>
                    {reply.visibility === "personal" ? (
                      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        <Lock className="h-2.5 w-2.5" />
                        Personal
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        <Globe className="h-2.5 w-2.5" />
                        Shared
                      </span>
                    )}
                    {reply.category && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {reply.category}
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {reply.message_type === "text"
                      ? reply.message
                      : reply.media_caption || reply.media_file_name || reply.media_url || ""}
                  </p>
                  {reply.message_type !== "text" && reply.media_file_name && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      {reply.media_file_name} {reply.media_file_size ? `• ${humanFileSize(reply.media_file_size)}` : ""}
                    </p>
                  )}
                </div>

                <div className="ml-2 flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleToggleFavorite(reply)}
                    className="rounded p-1 text-muted-foreground hover:text-amber-400"
                    title={
                      reply.is_favorite
                        ? "Remove from favorites"
                        : "Add to favorites"
                    }
                  >
                    <Star
                      className={cn(
                        "h-4 w-4",
                        reply.is_favorite && "fill-amber-400 text-amber-400",
                      )}
                    />
                  </button>
                  {canEditReply(reply) && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(reply)}
                        title="Edit"
                        aria-label="Edit quick reply"
                        className="h-8 px-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(reply)}
                        title="Delete"
                        aria-label="Delete quick reply"
                        className="h-8 w-8 text-muted-foreground hover:bg-red-950/30 hover:text-red-400"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open && uploading) return;
        setDialogOpen(open);
        if (!open) setDragOver(false);
      }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "Edit Quick Reply" : "New Quick Reply"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Title
              </label>
              <input
                value={form.title}
                onChange={(e) =>
                  setForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder="e.g. Welcome greeting"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Shortcut
              </label>
              <div className="flex items-center rounded-lg border border-border bg-muted">
                <span className="pl-3 text-sm text-muted-foreground">/</span>
                <input
                  value={form.shortcut}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      shortcut: e.target.value.replace(/\s+/g, "-"),
                    }))
                  }
                  placeholder="greeting"
                  className="flex-1 bg-transparent px-1 py-2 text-sm text-foreground placeholder-muted-foreground outline-none"
                />
              </div>
            </div>

            {/* Message Type */}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">Message Type</label>
              <div className="flex flex-wrap gap-1.5">
                {MESSAGE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => {
                      // If switching away from media, keep media in state but hidden; if switching to text, clear validation
                      setForm((f) => ({ ...f, message_type: t.value }));
                    }}
                    className={cn(
                      "flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors",
                      form.message_type === t.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted text-muted-foreground border-border hover:bg-muted/80",
                    )}
                  >
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Text message */}
            {form.message_type === "text" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground">
                  Message
                </label>
                <textarea
                  value={form.message}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, message: e.target.value }))
                  }
                  placeholder="Hello, Thank you for contacting us! Use {{name}} for variables."
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">Supports variables: {"{{name}}"}, {"{{phone}}"}, {"{{email}}"}, {"{{company}}"}, {"{{agent_name}}"}</p>
              </div>
            )}

            {/* Media upload */}
            {isMediaType && (
              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_BY_TYPE[form.message_type as Exclude<QuickReplyMessageType, "text">]}
                  className="hidden"
                  onChange={onFileInputChange}
                />
                {!form.media_url ? (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    className={cn(
                      "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-muted/30 px-4 py-6 text-center transition-colors",
                      dragOver ? "border-primary bg-primary/5" : "border-border",
                    )}
                  >
                    <Upload className="h-6 w-6 text-muted-foreground" />
                    <p className="text-sm text-foreground">Drag & drop file here</p>
                    <p className="text-xs text-muted-foreground">or</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                      {uploading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                      Choose File
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      {form.message_type === "image" && "JPEG / PNG, max 5 MB"}
                      {form.message_type === "video" && "MP4 / 3GP, max 16 MB"}
                      {form.message_type === "audio" && "AAC / AMR / MP3 / M4A / OGG (Opus), max 16 MB"}
                      {form.message_type === "document" && "PDF / DOCX / XLSX / PPTX / TXT / ODS / ODT / ODP, max 100 MB"}
                      {form.message_type === "sticker" && "WebP only, max 512 KB (100 KB static)"}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-border bg-muted/30 p-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        {form.message_type === "image" && form.media_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={form.media_url} alt={form.media_file_name || "preview"} className="max-h-40 rounded-lg object-cover" />
                        )}
                        {form.message_type === "video" && form.media_url && (
                          <video src={form.media_url} controls className="max-h-40 rounded-lg" />
                        )}
                        {form.message_type === "audio" && form.media_url && (
                          <audio src={form.media_url} controls className="w-full" />
                        )}
                        {form.message_type === "document" && (
                          <div className="flex items-center gap-2 text-sm text-foreground">
                            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{form.media_file_name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{form.media_mime_type}</span>
                          </div>
                        )}
                        {form.message_type === "sticker" && form.media_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={form.media_url} alt={form.media_file_name || "sticker"} className="h-32 w-32 object-contain rounded-lg bg-background" />
                        )}
                        {form.media_file_name && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {form.media_file_name} • {form.media_file_size ? humanFileSize(form.media_file_size) : ""} {form.media_mime_type ? `• ${form.media_mime_type}` : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                          Replace
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={handleRemoveMedia} disabled={uploading}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                {/* Caption — always visible for media types, with or without
                    a selected file. Stored via the existing media_caption
                    field; file selection never clears it. */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground">Caption (optional)</label>
                  <textarea
                    value={form.media_caption}
                    onChange={(e) => setForm((f) => ({ ...f, media_caption: e.target.value }))}
                    placeholder="Add a caption…"
                    maxLength={1024}
                    rows={2}
                    className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">{form.media_caption.length}/1024</p>
                </div>
                {uploading && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Uploading…</p>}
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Category
              </label>
              <input
                value={form.category}
                onChange={(e) =>
                  setForm((f) => ({ ...f, category: e.target.value }))
                }
                placeholder="e.g. Greetings"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
              />
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <select
                  value={form.visibility}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      visibility: e.target.value as "personal" | "shared",
                    }))
                  }
                  className="rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  <option value="shared">Shared (everyone)</option>
                  <option value="personal">Personal (only me)</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={form.is_favorite}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, is_favorite: e.target.checked }))
                  }
                  className="rounded"
                />
                <Star className="h-3.5 w-3.5 text-amber-400" />
                Favorite
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(false)}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || uploading}>
              {uploading ? "Uploading…" : saving ? "Saving…" : editingId ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Delete Quick Reply</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete &ldquo;{deleteTarget?.title}&rdquo;?
            This cannot be undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
