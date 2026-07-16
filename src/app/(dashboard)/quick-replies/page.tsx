"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
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

type FormData = {
  title: string;
  shortcut: string;
  message: string;
  category: string;
  visibility: "personal" | "shared";
  is_favorite: boolean;
};

const EMPTY_FORM: FormData = {
  title: "",
  shortcut: "",
  message: "",
  category: "",
  visibility: "shared",
  is_favorite: false,
};

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
    setReplies((data as QuickReply[]) || []);
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
          r.message.toLowerCase().includes(q) ||
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
      message: reply.message,
      category: reply.category,
      visibility: reply.visibility,
      is_favorite: reply.is_favorite,
    });
    setDialogOpen(true);
  };

  // Save (create or update)
  const handleSave = async () => {
    if (!accountId || !user) return;
    if (!form.title.trim() || !form.shortcut.trim() || !form.message.trim()) {
      toast.error("Title, shortcut, and message are required");
      return;
    }

    const shortcut = form.shortcut.trim().replace(/^\//, "").replace(/\s+/g, "-");
    if (!shortcut) {
      toast.error("Shortcut cannot be empty");
      return;
    }

    setSaving(true);

    const payload = {
      account_id: accountId,
      created_by: user.id,
      title: form.title.trim(),
      shortcut,
      message: form.message.trim(),
      category: form.category.trim(),
      visibility: form.visibility,
      is_favorite: form.is_favorite,
    };

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
    const { error } = await supabase
      .from("quick_replies")
      .delete()
      .eq("id", deleteTarget.id);
    if (error) {
      toast.error("Failed to delete");
    } else {
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

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MessageSquareText className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              Quick Replies
            </h1>
            <p className="text-sm text-muted-foreground">
              Save and reuse frequently sent messages
            </p>
          </div>
        </div>
        <GatedButton
          canAct={canEdit}
          gateReason="send messages"
          onClick={handleCreate}
          size="sm"
        >
          <Plus className="mr-1 h-4 w-4" />
          New Reply
        </GatedButton>
      </div>

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
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
          <MessageSquareText className="h-12 w-12 opacity-30" />
          <p className="text-sm">
            {replies.length === 0
              ? "No quick replies yet. Create one to get started!"
              : "No quick replies match your search"}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((reply) => (
            <div
              key={reply.id}
              className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">
                      {reply.title}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
                      /{reply.shortcut}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {reply.message}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1">
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
                      <button
                        type="button"
                        onClick={() => handleEdit(reply)}
                        className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(reply)}
                        className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
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

            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                Message
              </label>
              <textarea
                value={form.message}
                onChange={(e) =>
                  setForm((f) => ({ ...f, message: e.target.value }))
                }
                placeholder="Hello {{name}}, thank you for contacting us!"
                rows={4}
                className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
              />
            </div>

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
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Update" : "Create"}
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
    </div>
  );
}
